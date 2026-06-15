// Content-store garbage collection (Step 11).
//
// Mark-sweep over the CAS: compute the COMPLETE set of reachable sha256s, then
// ask the fs-helper to delete every blob not in it. Reachability roots (each
// must be expanded to the content shas it transitively references):
//
//   1. Every file_snapshot's manifest_sha256 — AND every file sha inside that
//      manifest. We expand ALL snapshots, not just current heads: a snapshot
//      superseded as a space head can still be pinned by an active mount's
//      base/result_snapshot_id, and its content blobs must survive the session.
//      (Expanding every snapshot is the safe over-approximation; pruning the
//      DAG is a future optimization.)
//   2. Every *_parts.ref_sha256 across conversation/tool_result/memory/
//      context_archive parts (historical message/memory/context file refs).
//   3. Every file_assets.content_sha256 (entity assets by content).
//   4. Every PENDING conflict-sidecar content_sha in sessions.collaboration_state
//      (_sandboxPendingCommitConflicts + _sandboxPendingRefreshConflicts). A
//      conflict sidecar preserves the agent's LOSER copy (head won the path), so
//      that blob is NEVER in a snapshot/part/asset — its only reference is the
//      pending notice. Without this root, GC would reap it after the grace
//      window and the round-11 re-materialize would fail (round-11 follow-up).
//
// Anything not transitively reachable from those is unreferenced and deleted.
// The sweep runs in the fs-helper (fs.cas.gc) which deletes blobs whose sha is
// absent from the reachable set we pass.

import { readCasBlob } from "../../infrastructure/storage/index.js"
import { parseManifestShas } from "../files/manifest-parse.js"
import { gcCas } from "./materialize.js"
import {
  defaultDbh,
  gcPartTables,
  listGcAssetContentShas,
  listGcPartRefShas,
  listGcPendingSidecarStates,
  listGcSnapshotManifestShas,
  type Executor,
} from "./repo.js"

export interface GcResult {
  reachableCount: number
  manifestsExpanded: number
  manifestsUnreadable: number
  deletedCount: number
}

/**
 * Compute the reachable sha set and sweep the CAS. `dryRun` returns the
 * reachable set sizes without deleting (deletedCount=0). `dbh` overrides the
 * executor (e.g. a test transaction); defaults to the top-level db.
 */
export async function runContentGc(
  opts: { dryRun?: boolean; dbh?: Executor; graceSecs?: number } = {}
): Promise<GcResult> {
  const dbh = opts.dbh ?? defaultDbh()
  const reachable = new Set<string>()
  let manifestsExpanded = 0
  let manifestsUnreadable = 0

  // 1. Snapshots: manifest blob + every content sha inside each manifest.
  // Repo helpers return camelCase keys because Kysely's CamelCasePlugin still
  // transforms raw SQL result aliases at the DB boundary.
  for (const manifestSha of await listGcSnapshotManifestShas(dbh)) {
    reachable.add(manifestSha)
    try {
      const bytes = await readCasBlob(manifestSha)
      for (const sha of parseManifestShas(bytes)) reachable.add(sha)
      manifestsExpanded++
    } catch {
      // Manifest blob missing/unreadable: keep the manifest sha itself reachable
      // (so we never delete a referenced-but-corrupt manifest) and count it.
      manifestsUnreadable++
    }
  }

  // 2. Historical file_ref parts across all part tables.
  for (const table of gcPartTables()) {
    for (const sha of await listGcPartRefShas(table, dbh)) {
      reachable.add(sha)
    }
  }

  // 3. Entity assets by content.
  for (const sha of await listGcAssetContentShas(dbh)) {
    reachable.add(sha)
  }

  // 4. Pending conflict-sidecar content blobs (round-11 follow-up). These are
  // the agent's preserved LOSER copies, reachable ONLY via the pending notice
  // (never a snapshot, since head won). Keep them alive so the next provision
  // can re-materialize the sidecar from CAS.
  for (const sha of await collectPendingSidecarShas(dbh)) {
    reachable.add(sha)
  }

  let deletedCount = 0
  if (!opts.dryRun) {
    deletedCount = await gcCas(Array.from(reachable), opts.graceSecs)
  }

  return {
    reachableCount: reachable.size,
    manifestsExpanded,
    manifestsUnreadable,
    deletedCount,
  }
}

const PENDING_COMMIT_KEY = "_sandboxPendingCommitConflicts"
const PENDING_REFRESH_KEY = "_sandboxPendingRefreshConflicts"

/**
 * Collect every file-kind conflict-sidecar content_sha stashed in any session's
 * collaboration_state (both the commit and refresh pending stores). These blobs
 * preserve the agent's losing pre-conflict copy and are not referenced by any
 * snapshot/part/asset (round-11 follow-up), so GC must treat them as roots.
 * Tolerant of shape drift: only string contentSha on kind!="symlink" entries.
 */
async function collectPendingSidecarShas(dbh: Executor): Promise<Set<string>> {
  const out = new Set<string>()
  // Only sessions that actually carry a pending store (keeps the scan cheap).
  // The SELECTed column surfaces as `collaborationState` (CamelCasePlugin); the
  // JSONB `?` containment in the WHERE clause uses the physical column name.
  const states = await listGcPendingSidecarStates(dbh, {
    pendingCommitKey: PENDING_COMMIT_KEY,
    pendingRefreshKey: PENDING_REFRESH_KEY,
  })
  for (const rawState of states) {
    const state = (rawState ?? {}) as Record<string, unknown>
    // Commit store: { subpath: { paths, sidecars: [{contentSha,kind}] } }
    collectFromSidecarMap(
      out,
      (state[PENDING_COMMIT_KEY] as Record<string, unknown>) ?? {},
      (v) => (v as { sidecars?: unknown })?.sidecars
    )
    // Refresh store: { sidecarsBySubpath: { subpath: [{contentSha,kind}] } }
    const refresh = (state[PENDING_REFRESH_KEY] ?? {}) as {
      sidecarsBySubpath?: unknown
    }
    collectFromSidecarMap(
      out,
      (refresh.sidecarsBySubpath as Record<string, unknown>) ?? {},
      (v) => v
    )
  }
  return out
}

/** Pull contentSha off every file-kind sidecar in a per-subpath map. */
function collectFromSidecarMap(
  out: Set<string>,
  bySubpath: Record<string, unknown>,
  pickSidecars: (entry: unknown) => unknown
): void {
  for (const entry of Object.values(bySubpath)) {
    const sidecars = pickSidecars(entry)
    if (!Array.isArray(sidecars)) continue
    for (const s of sidecars) {
      const ref = s as { kind?: unknown; contentSha?: unknown }
      if (ref?.kind === "symlink") continue
      if (typeof ref?.contentSha === "string") out.add(ref.contentSha)
    }
  }
}
