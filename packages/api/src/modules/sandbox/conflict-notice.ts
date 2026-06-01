// Pure formatting for the agent-facing conflict notice's sidecar listings.
//
// A conflict sidecar preserves the agent's pre-conflict ("loser") copy of a path
// that head won. After a teardown deletes the live dir, the sidecar is
// re-materialized on the next provision from its CAS-durable payload — but that
// restore can FAIL (the mount for its subpath isn't active yet, a transient fs
// error, or a pre-round-11 record with no contentSha). When it fails the on-disk
// leaf is ABSENT even though the bytes are safe, so the notice must NOT tell the
// agent to "read it" (P2) — that would point at a missing path. This module
// splits a sidecar list into restored (readable) vs unrestored (preserved but
// not on disk) and renders each, so both the worker and its tests share one
// source of truth.

import type { ConflictSidecarRef } from "./service.js"

export interface PartitionedSidecars {
  /** Sidecars whose on-disk leaf exists this provision — safe to tell the agent to read. */
  restored: ConflictSidecarRef[]
  /** Sidecars that could NOT be re-materialized this provision — bytes safe, leaf absent. */
  unrestored: ConflictSidecarRef[]
}

/**
 * Split `sidecars` by whether their agent-visible sidecar path is in
 * `failedSidecars` (the set provisionSandbox reported as not-restored this turn).
 */
export function partitionSidecars(
  sidecars: ConflictSidecarRef[],
  failedSidecars: ReadonlySet<string>
): PartitionedSidecars {
  const restored: ConflictSidecarRef[] = []
  const unrestored: ConflictSidecarRef[] = []
  for (const s of sidecars) {
    if (failedSidecars.has(s.sidecar)) unrestored.push(s)
    else restored.push(s)
  }
  return { restored, unrestored }
}

/** "original → sidecar" (symlinks annotated as JSON), for a RESTORED sidecar. */
export function formatRestoredPair(s: ConflictSidecarRef): string {
  return s.kind === "symlink"
    ? `${s.original} → ${s.sidecar} (symlink target, read as JSON)`
    : `${s.original} → ${s.sidecar}`
}

/** "original (preserved copy at sidecar)" — NO "read it", for an UNRESTORED sidecar. */
export function formatUnrestoredPair(s: ConflictSidecarRef): string {
  return `${s.original} (preserved copy at ${s.sidecar})`
}

/**
 * The standalone sentence naming sidecars the agent could NOT re-materialize this
 * turn. Returns "" when there are none (so the caller can concatenate freely).
 * Deliberately omits any "read" instruction: the leaf isn't present; the bytes
 * are safe and will be restored on a later turn.
 */
export function unrestoredSidecarSentence(
  unrestored: ConflictSidecarRef[]
): string {
  if (unrestored.length === 0) return ""
  const pairs = unrestored.map(formatUnrestoredPair).join("; ")
  return (
    `Your pre-conflict copy of these paths is preserved but could NOT be ` +
    `re-materialized on disk this turn (do NOT try to read the sidecar path ` +
    `yet — it is not present; the bytes are safe and will be restored on a ` +
    `later turn): ${pairs}.`
  )
}
