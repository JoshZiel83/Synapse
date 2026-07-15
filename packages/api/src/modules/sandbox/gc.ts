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

import {
  readContentBuffer,
  listBackends,
} from "../../infrastructure/storage/content-store.js"
import { parseManifestShas } from "../files/manifest-parse.js"
import { gcCas } from "./materialize.js"
import {
  decodePendingConflicts,
  decodePendingRefresh,
  type ConflictSidecarRef,
} from "./pending-conflicts.js"
import {
  defaultDbh,
  gcPartTables,
  listGcAssetContentShas,
  listGcPartRefShas,
  listGcPendingSidecarStates,
  listGcSnapshotManifestShas,
  listDurableBlobRows,
  purgeContentBlobRow,
  backendHasAnyBlobRow,
  type Executor,
} from "./repo.js"

export interface GcResult {
  reachableCount: number
  manifestsExpanded: number
  manifestsUnreadable: number
  deletedCount: number
  /**
   * Count of REMOTE objects reaped by the durable sweep (plan §10) across all
   * configured remote backends. Always 0 in the default local-only deployment
   * (no remote backend → the durable sweep is a no-op).
   */
  durableDeletedCount: number
}

/**
 * Grace window for the durable sweep (plan §10#1, §13#9). A remote object whose
 * content_blobs row was durably confirmed more recently than this is NEVER
 * reaped — it absorbs object-store LIST eventual consistency and the
 * scan→PUT→row-write window. Defaults to 24h; overridable via opts.
 */
const DEFAULT_DURABLE_GRACE_SECS = 24 * 60 * 60

/**
 * Compute the reachable sha set and sweep the CAS. `dryRun` returns the
 * reachable set sizes without deleting (deletedCount=0). `dbh` overrides the
 * executor (e.g. a test transaction); defaults to the top-level db.
 */
export async function runContentGc(
  opts: {
    dryRun?: boolean
    dbh?: Executor
    graceSecs?: number
    /** Grace window for the durable (remote) sweep; defaults to 24h (plan §10#1). */
    durableGraceSecs?: number
  } = {}
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
      const bytes = await readContentBuffer(manifestSha)
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

  // Durable sweep (plan §10#1): reap unreachable objects from each configured
  // REMOTE backend. NO-OP in the default local-only deployment (no remote
  // backend configured) — guarded below.
  const durableDeletedCount = opts.dryRun
    ? 0
    : await runDurableSweep(reachable, dbh, opts.durableGraceSecs)

  return {
    reachableCount: reachable.size,
    manifestsExpanded,
    manifestsUnreadable,
    deletedCount,
    durableDeletedCount,
  }
}

/**
 * The durable (remote) sweep (plan §10#1). For each configured remote backend
 * that can both `list` and `delete`: enumerate its objects, subtract the global
 * reachable set, and reap each unreachable sha whose content_blobs row is either
 * absent or older than the grace window — deleting the object bytes FIRST, then
 * purging the row via the SECURITY DEFINER fn.
 *
 * Conservative by construction:
 *   - GATED: returns 0 immediately when no remote backend is configured (the
 *     default), so the local-only path is byte-identical to today.
 *   - only deletes objects NOT in `reachable`;
 *   - only deletes when the row is absent OR durable_confirmed_at is older than
 *     the grace window (absorbs LIST eventual consistency + the push window).
 */
async function runDurableSweep(
  reachable: ReadonlySet<string>,
  dbh: Executor,
  durableGraceSecs?: number
): Promise<number> {
  const remoteBackends = listBackends()
  // Default (local-only) deployment: no remote backend → nothing to sweep.
  if (remoteBackends.length === 0) return 0

  const graceSecs = durableGraceSecs ?? DEFAULT_DURABLE_GRACE_SECS
  const cutoff = new Date(Date.now() - graceSecs * 1000)
  let durableDeletedCount = 0

  for (const [backend, store] of remoteBackends) {
    // A store must support BOTH enumeration and deletion to be swept. presigned-
    // only backends (no list/delete) are skipped — their objects are reaped by
    // whatever supervisor drives that backend, never blindly.
    if (!store.list || !store.delete) continue

    // §10#6: only sweep a backend that is actually a WRITE TARGET — i.e. it has
    // at least one content_blobs row. A configured-but-read-only remote bucket
    // (legacy/migration source, WRITE_DEFAULT=local_cas) has NO rows; sweeping it
    // would treat its whole bucket as orphaned and delete it on first sweep.
    if (!(await backendHasAnyBlobRow(backend, dbh))) continue

    // Prefer listWithMeta (carries S3 LastModified) so a no-row object can get
    // the orphan-race grace: a concurrent commit PUTs bytes BEFORE writing the
    // content_blobs row, so a just-PUT-not-yet-rowed object would otherwise be
    // destroyed. Fall back to list() (no timestamps) when the backend lacks it.
    const objects: { sha: string; lastModified?: Date }[] = store.listWithMeta
      ? await store.listWithMeta("")
      : (await store.list("")).map((sha) => ({ sha }))
    const unreachable = objects.filter((o) => !reachable.has(o.sha))
    if (unreachable.length === 0) continue

    // Pull the ledger rows for the candidates so we can apply the grace per sha.
    const rows = await listDurableBlobRows(
      backend,
      unreachable.map((o) => o.sha),
      dbh
    )
    for (const { sha, lastModified } of unreachable) {
      const hasRow = rows.has(sha)
      const confirmedAt = rows.get(sha) ?? null
      // Conservative grace: skip a row that was confirmed durable within the
      // grace window (it may be mid-commit / LIST not yet consistent).
      if (hasRow && confirmedAt && confirmedAt > cutoff) continue
      // §10#1 orphan-race grace: a no-row (or NULL-confirmed) object whose bytes
      // were modified within the grace window is a just-PUT-not-yet-rowed blob
      // from a concurrent commit — skip it. Absent lastModified → treat as old
      // (eligible), same as the timestamp-less list() path.
      if (!hasRow && lastModified && lastModified > cutoff) continue

      // Bytes FIRST, then the row (so a crash between leaves an orphaned row, not
      // an orphaned object — the next sweep re-reaps the row harmlessly).
      await store.delete(sha)
      if (hasRow) await purgeContentBlobRow(sha, dbh)
      durableDeletedCount++
    }
  }
  return durableDeletedCount
}

const PENDING_COMMIT_KEY = "_sandboxPendingCommitConflicts"
const PENDING_REFRESH_KEY = "_sandboxPendingRefreshConflicts"

/**
 * Collect every file-kind conflict-sidecar content_sha stashed in any session's
 * collaboration_state (both the commit and refresh pending stores). These blobs
 * preserve the agent's losing pre-conflict copy and are not referenced by any
 * snapshot/part/asset (round-11 follow-up), so GC must treat them as roots.
 * Uses the SAME strict decode as the repo read path (no second tolerant walk): a
 * corrupt blob decodes to empty, and only FILE-kind sidecars carry CAS bytes.
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
    const commit = decodePendingConflicts(state[PENDING_COMMIT_KEY])
    for (const entry of Object.values(commit)) addFileShas(out, entry.sidecars)
    const refresh = decodePendingRefresh(state[PENDING_REFRESH_KEY])
    for (const refs of Object.values(refresh.sidecarsBySubpath))
      addFileShas(out, refs)
  }
  return out
}

/** Add every FILE-kind sidecar's contentSha (its CAS bytes are a GC root). A symlink
 *  sidecar carries a `target` string, not CAS bytes, so it contributes nothing. */
function addFileShas(out: Set<string>, sidecars: ConflictSidecarRef[]): void {
  for (const ref of sidecars) {
    if (ref.kind === "file") out.add(ref.contentSha)
  }
}
