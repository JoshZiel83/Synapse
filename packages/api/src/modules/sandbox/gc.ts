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
//
// Anything not transitively reachable from those is unreferenced and deleted.
// The sweep runs in the fs-helper (fs.cas.gc) which deletes blobs whose sha is
// absent from the reachable set we pass.

import { pool } from "../../infrastructure/database/index.js"
import { executeSqlOn } from "../../infrastructure/database/kysely.js"
import type { QueryExecutor } from "../../infrastructure/database/kysely.js"
import { readCasBlob } from "../../infrastructure/storage/index.js"
import { parseManifestShas } from "../files/manifest-parse.js"
import { gcCas } from "./materialize.js"

export interface GcResult {
  reachableCount: number
  manifestsExpanded: number
  manifestsUnreadable: number
  deletedCount: number
}

/**
 * Compute the reachable sha set and sweep the CAS. `dryRun` returns the
 * reachable set sizes without deleting (deletedCount=0). `dbh` overrides the
 * executor (e.g. a test transaction); defaults to the singleton pool.
 */
export async function runContentGc(
  opts: { dryRun?: boolean; dbh?: QueryExecutor } = {}
): Promise<GcResult> {
  const dbh = opts.dbh ?? pool
  const reachable = new Set<string>()
  let manifestsExpanded = 0
  let manifestsUnreadable = 0

  // 1. Snapshots: manifest blob + every content sha inside each manifest.
  const snapshots = await executeSqlOn<{ manifest_sha256: string }>(
    dbh,
    `SELECT DISTINCT manifest_sha256 FROM file_snapshots`
  )
  for (const row of snapshots.rows) {
    const manifestSha = row.manifest_sha256
    if (!manifestSha) continue
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
  for (const table of [
    "conversation_item_parts",
    "tool_result_parts",
    "memory_item_parts",
    "context_archive_frame_parts",
  ]) {
    const parts = await executeSqlOn<{ ref_sha256: string }>(
      dbh,
      `SELECT DISTINCT ref_sha256 FROM ${table} WHERE ref_sha256 IS NOT NULL`
    )
    for (const p of parts.rows) {
      if (p.ref_sha256) reachable.add(p.ref_sha256)
    }
  }

  // 3. Entity assets by content.
  const assets = await executeSqlOn<{ content_sha256: string }>(
    dbh,
    `SELECT DISTINCT content_sha256 FROM file_assets WHERE content_sha256 IS NOT NULL`
  )
  for (const a of assets.rows) {
    if (a.content_sha256) reachable.add(a.content_sha256)
  }

  let deletedCount = 0
  if (!opts.dryRun) {
    deletedCount = await gcCas(Array.from(reachable))
  }

  return {
    reachableCount: reachable.size,
    manifestsExpanded,
    manifestsUnreadable,
    deletedCount,
  }
}
