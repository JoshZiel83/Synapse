// Pure formatting for the agent-facing conflict notice's sidecar listings.
//
// A conflict sidecar preserves the agent's pre-conflict ("loser") copy of a path
// that head won. After a teardown deletes the live dir, the sidecar is
// re-materialized on the next provision from its CAS-durable payload — but that
// restore can FAIL. When it fails the on-disk leaf is ABSENT even though (for a
// transient failure) the bytes are safe, so the notice must NOT tell the agent to
// "read it" (P2) — that would point at a missing path. Failures come in two
// flavours (P3):
//   - transient: the payload exists (file bytes in CAS, symlink target recorded)
//     but couldn't be written this provision (no live mount for the subpath yet,
//     or a transient fs error). A later turn may restore it → promise a retry.
//   - permanent: the durable record itself lacks the payload (pre-round-11 /
//     corrupt: no contentSha / no target / unparseable path). It will NEVER
//     restore → must NOT promise a retry; tell the agent the copy is unrecoverable.
//
// This module splits a sidecar list into restored / transiently-unrestored /
// permanently-unrestored and renders each, so the worker and its tests share one
// source of truth.

import {
  isSidecarPayloadIrrecoverable,
  type ConflictSidecarRef,
} from "./pending-conflicts.js"
import type { SidecarRestoreFailureReason } from "./model.js"

export interface PartitionedSidecars {
  /** Sidecars whose on-disk leaf exists this provision — safe to tell the agent to read. */
  restored: ConflictSidecarRef[]
  /** Failed but recoverable later — payload safe, leaf absent this provision. */
  transient: ConflictSidecarRef[]
  /** Failed permanently — the durable record can never rebuild the sidecar. */
  permanent: ConflictSidecarRef[]
}

/**
 * Split `sidecars` by their restore status. `failedReasons` maps an
 * agent-visible sidecar path to WHY it failed this provision (from
 * provisionSandbox); a sidecar absent from the map is treated as restored.
 *
 * `restoreStatusUnknown` (P2 fail-closed): set when the provision reported the
 * restore as NOT-ok but produced NO per-sidecar list (e.g. the failure-
 * collection itself threw). In that case we cannot trust that any sidecar was
 * restored, so none is presented as readable. But we DON'T blindly call them all
 * transient: a ref that is intrinsically unrecoverable by its own shape (file
 * with no contentSha, symlink with no target, unknown/corrupt kind, or a sidecar
 * path that isn't a safe `/<mount>/.synapse-conflicts/<flat-leaf>` —
 * `isSidecarPayloadIrrecoverable`) is still PERMANENT, exactly as the normal
 * restore path would classify it (P3 truthfulness — never tell the agent a
 * corrupt copy "will be retried"). Only refs that COULD plausibly restore later
 * are bucketed transient. The caller blocks clearing the pending store whenever
 * any transient OR the unknown flag is set, so a permanent-only unknown turn
 * still doesn't lose a transient notice.
 */
export function partitionSidecars(
  sidecars: ConflictSidecarRef[],
  failedReasons: ReadonlyMap<string, SidecarRestoreFailureReason>,
  restoreStatusUnknown = false
): PartitionedSidecars {
  const restored: ConflictSidecarRef[] = []
  const transient: ConflictSidecarRef[] = []
  const permanent: ConflictSidecarRef[] = []
  for (const s of sidecars) {
    if (restoreStatusUnknown) {
      // Fail-closed: status unknown → never "restored". Classify by shape first
      // so an intrinsically-corrupt ref is still permanent (not over-promised as
      // retryable); everything else is transient (assume not on disk, retryable).
      if (isSidecarPayloadIrrecoverable(s)) permanent.push(s)
      else transient.push(s)
      continue
    }
    const reason = failedReasons.get(s.sidecar)
    if (reason === undefined) restored.push(s)
    else if (reason === "permanent") permanent.push(s)
    else transient.push(s)
  }
  return { restored, transient, permanent }
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
 * The standalone sentence for sidecars that failed restore TRANSIENTLY — the
 * payload is safe and a later turn MAY restore it (no guarantee: transient
 * covers a temporary fs write error or a not-yet-active mount, which is retried
 * but not certain to succeed). Returns "" when there are none (so the caller can
 * concatenate freely). Deliberately omits any "read" instruction: the leaf isn't
 * present yet.
 */
export function transientUnrestoredSentence(
  transient: ConflictSidecarRef[]
): string {
  if (transient.length === 0) return ""
  const pairs = transient.map(formatUnrestoredPair).join("; ")
  return (
    `Your pre-conflict copy of these paths is preserved but could NOT be ` +
    `re-materialized on disk this turn (do NOT try to read the sidecar path ` +
    `yet — it is not present; the bytes are safe and a restore will be retried ` +
    `on a later turn): ${pairs}.`
  )
}

/**
 * The standalone sentence for sidecars that failed restore PERMANENTLY — the
 * durable record lacks the payload, so the copy is UNRECOVERABLE (it will never
 * come back). Returns "" when there are none. Makes NO retry promise.
 */
export function permanentUnrestoredSentence(
  permanent: ConflictSidecarRef[]
): string {
  if (permanent.length === 0) return ""
  const paths = permanent.map((s) => s.original).join("; ")
  return (
    `Your pre-conflict copy of these paths is UNRECOVERABLE — the saved record ` +
    `is incomplete/corrupt and cannot be restored (do NOT try to read the ` +
    `sidecar path; it will not come back). Treat your earlier change to these ` +
    `paths as lost and redo it from the current version if still needed: ${paths}.`
  )
}
