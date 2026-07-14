/**
 * Durable pending-conflict state codec for sandbox session collaboration JSON.
 * Repo reads/writes this blob; service consumes the typed result.
 */

/** A conflicting file whose pre-conflict local copy was preserved at a sidecar. */
export interface ConflictSidecarRef {
  original: string
  sidecar: string
  /** "file" = readable bytes; "symlink" = readable JSON metadata (round-10 #3). */
  kind: string
  /**
   * CAS-durable recovery payload (round-11 #1) so the sidecar survives teardown
   * (which deletes the live dir; .synapse-conflicts is scan-excluded so never in
   * CAS via the snapshot path). For a FILE sidecar this is the content sha256
   * (the bytes are already in CAS from the scan). For a SYMLINK sidecar the
   * `target` string is the payload (no CAS bytes). On the next provision the
   * sidecar is re-materialized into the fresh live dir from these.
   */
  contentSha?: string
  /** Symlink target (round-11 #1), present only for kind="symlink". */
  target?: string
}

/** Per-subpath pending commit conflicts: the lost paths + their sidecars. */
export interface PendingCommitConflict {
  paths: string[]
  sidecars: ConflictSidecarRef[]
}

/**
 * Durable refresh-conflict state for at-least-once delivery (round-10 #1).
 * refreshSpaces head-wins-resolves conflicts (live path -> head, agent's copy ->
 * sidecar) and advances base at TURN START, then this durable state keeps the
 * notice deliverable if the turn is interrupted before actorThink consumes it.
 */
export interface PendingRefreshConflicts {
  /** subpath -> deferred conflict paths (head won the live path). */
  deferredConflictsBySubpath: Record<string, string[]>
  /** subpath -> sidecars preserving the agent's pre-conflict copies. */
  sidecarsBySubpath: Record<string, ConflictSidecarRef[]>
  /** subpath -> reason the refresh could not fully sync (stale/half-synced view). */
  syncFailuresBySubpath: Record<string, string>
}

/**
 * The mount-relative directory every conflict sidecar lives under. Must match
 * CONFLICTS_DIRNAME in sidecars/fs-helper/src/manifest.rs.
 */
const CONFLICTS_DIRNAME = ".synapse-conflicts"

/**
 * The ONLY shape a legitimate sidecar VFS path can take:
 *   /<mount-subpath>/.synapse-conflicts/<flat-leaf>
 * where <mount-subpath> and <flat-leaf> are each a single path segment with no
 * slashes and are not "." or "..".
 */
export const SIDECAR_ROUTE_RE = /^\/([^/]+)\/\.synapse-conflicts\/([^/]+)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

/** Whether a single path segment is safe (non-empty, not "." or ".."). */
function isSafeSegment(seg: string): boolean {
  return seg.length > 0 && seg !== "." && seg !== ".."
}

/**
 * Parse a sidecar VFS path into its mount subpath + mount-relative leaf, or null
 * if it is not a well-formed `/<mount>/.synapse-conflicts/<flat-leaf>` path with
 * safe segments. The leaf returned is the mount-relative path the fs-helper
 * restores against (e.g. `/.synapse-conflicts/<hex>`).
 */
export function parseSidecarRoute(
  sidecar: string
): { subpath: string; leaf: string } | null {
  const m = SIDECAR_ROUTE_RE.exec(sidecar)
  if (!m) return null
  const [, subpath, leafName] = m
  if (!isSafeSegment(subpath) || !isSafeSegment(leafName)) return null
  return { subpath, leaf: `/${CONFLICTS_DIRNAME}/${leafName}` }
}

/**
 * Whether a sidecar ref is INTRINSICALLY unrecoverable from its own shape. This
 * is shared by restore and notice partitioning so they never disagree.
 */
export function isSidecarPayloadIrrecoverable(
  ref: ConflictSidecarRef
): boolean {
  if (parseSidecarRoute(ref.sidecar) === null) return true
  if (ref.kind === "file") return !ref.contentSha
  if (ref.kind === "symlink") return ref.target === undefined
  return true
}

/**
 * Pure union of an existing pending-conflict map with newly-recorded conflicts:
 * per subpath, dedup paths (Set) and dedup sidecars by SIDECAR path.
 */
export function mergePendingConflicts(
  prev: Record<string, PendingCommitConflict>,
  incomingBySubpath: Record<string, PendingCommitConflict>
): Record<string, PendingCommitConflict> {
  const merged: Record<string, PendingCommitConflict> = { ...prev }
  for (const [sub, incoming] of Object.entries(incomingBySubpath)) {
    const existingEntry = merged[sub] ?? { paths: [], sidecars: [] }
    const paths = Array.from(
      new Set([...existingEntry.paths, ...incoming.paths])
    )
    const bySidecar = new Map<string, ConflictSidecarRef>()
    for (const s of [...existingEntry.sidecars, ...incoming.sidecars]) {
      bySidecar.set(s.sidecar, s)
    }
    merged[sub] = { paths, sidecars: Array.from(bySidecar.values()) }
  }
  return merged
}

/**
 * Coerce the stored pending-conflicts blob into the current shape
 * (subpath -> { paths, sidecars }). A malformed/absent blob → {}.
 */
export function normalizePendingConflicts(
  raw: unknown
): Record<string, PendingCommitConflict> {
  if (!isRecord(raw)) return {}
  const out: Record<string, PendingCommitConflict> = {}
  for (const [sub, val] of Object.entries(raw)) {
    if (isRecord(val)) {
      out[sub] = {
        paths: stringArray(val.paths),
        sidecars: Array.isArray(val.sidecars)
          ? val.sidecars.map(normalizeSidecarRef)
          : [],
      }
    }
  }
  return out
}

/** Coerce a stored sidecar ref, defaulting a missing `kind` to "file". */
function normalizeSidecarRef(raw: unknown): ConflictSidecarRef {
  const v = isRecord(raw) ? raw : {}
  return {
    original: typeof v.original === "string" ? v.original : "",
    sidecar: typeof v.sidecar === "string" ? v.sidecar : "",
    kind: typeof v.kind === "string" ? v.kind : "file",
    ...(typeof v.contentSha === "string" ? { contentSha: v.contentSha } : {}),
    ...(typeof v.target === "string" ? { target: v.target } : {}),
  }
}

/**
 * Pure union of an existing pending-refresh map with newly-recorded refresh
 * conflicts.
 */
export function mergePendingRefreshConflicts(
  prev: Pick<
    PendingRefreshConflicts,
    "deferredConflictsBySubpath" | "sidecarsBySubpath"
  >,
  incoming: Pick<
    PendingRefreshConflicts,
    "deferredConflictsBySubpath" | "sidecarsBySubpath"
  >
): Pick<
  PendingRefreshConflicts,
  "deferredConflictsBySubpath" | "sidecarsBySubpath"
> {
  const deferredConflictsBySubpath: Record<string, string[]> = {
    ...prev.deferredConflictsBySubpath,
  }
  for (const [sub, paths] of Object.entries(
    incoming.deferredConflictsBySubpath
  )) {
    deferredConflictsBySubpath[sub] = Array.from(
      new Set([...(deferredConflictsBySubpath[sub] ?? []), ...paths])
    )
  }
  const sidecarsBySubpath: Record<string, ConflictSidecarRef[]> = {
    ...prev.sidecarsBySubpath,
  }
  for (const [sub, refs] of Object.entries(incoming.sidecarsBySubpath)) {
    const bySidecar = new Map<string, ConflictSidecarRef>()
    for (const s of [...(sidecarsBySubpath[sub] ?? []), ...refs]) {
      bySidecar.set(s.sidecar, s)
    }
    sidecarsBySubpath[sub] = Array.from(bySidecar.values())
  }
  return { deferredConflictsBySubpath, sidecarsBySubpath }
}

/** Coerce the stored pending-refresh blob into the current shape. */
export function normalizePendingRefresh(
  raw: unknown
): Pick<
  PendingRefreshConflicts,
  "deferredConflictsBySubpath" | "sidecarsBySubpath"
> {
  const v = isRecord(raw) ? raw : {}
  const deferredConflictsBySubpath: Record<string, string[]> = {}
  if (isRecord(v.deferredConflictsBySubpath)) {
    for (const [sub, paths] of Object.entries(v.deferredConflictsBySubpath)) {
      deferredConflictsBySubpath[sub] = stringArray(paths)
    }
  }
  const sidecarsBySubpath: Record<string, ConflictSidecarRef[]> = {}
  if (isRecord(v.sidecarsBySubpath)) {
    for (const [sub, refs] of Object.entries(v.sidecarsBySubpath)) {
      if (Array.isArray(refs)) {
        sidecarsBySubpath[sub] = refs.map(normalizeSidecarRef)
      }
    }
  }
  return { deferredConflictsBySubpath, sidecarsBySubpath }
}
