// Working-set identity bridge for the bare (Mode-B) adapters (§8.1 / §4.7.4).
//
// TWO implementations behind the ONE WorkingSetBridge contract:
//
//   PRODUCT path (S11 — local:bare + docker:bare with volume-subpath mounts):
//     applyManifest ≡ materializeSnapshot, scanManifest ≡ scanCommitDir, VERBATIM.
//     The adapter never touches CAS — the spine keeps calling the same primitives
//     it does for a resident docker sandbox. `confinedFs:'native'` is sound
//     because the in-process/host-side plane reads/writes the SAME
//     <sandboxRoot>/<subpath> bytes the fs-helper materialized, through the same
//     vfs kernel.
//
//   DETACHED path (S12 — docker:bare remote bridge, config/test-flagged):
//     NO volume mounts; the working set lives inside the container's own
//     /conversation|… and is driven ENTIRELY via `docker exec` (never docker cp /
//     tar -x). applyManifest materializes base into an API-local scratch MIRROR
//     then replicates into the container write-tmp-then-Move with explicit Removes
//     for delete-propagation; scanManifest reconciles the container tree back into
//     the mirror through a per-sandbox stat-cache, then runs the EXISTING fused
//     scanCommitDir on the mirror. This is the CI PROOF of the exact remote
//     bridge contract envd will implement, before envd exists (the R2 escape).

import { createHash } from "node:crypto"
import { materializeSnapshot, scanCommitDir } from "./materialize.js"
import type { WorkingSetBridge } from "./data-plane.js"

// ─────────────────────────── PRODUCT bridge (S11) ────────────────────────────

/**
 * The product-path bridge. Pure delegation to the existing spine primitives — the
 * adapter (local:bare or docker:bare-mounted) never touches CAS. Proves the
 * §8.1 identity: docker:bare's product path IS the resident docker path.
 */
export function createProductWorkingSetBridge(): WorkingSetBridge {
  return {
    applyManifest: (input) =>
      materializeSnapshot({
        manifestSha256: input.manifestSha256,
        targetDir: input.targetDir,
      }),
    scanManifest: (input) =>
      scanCommitDir({
        dir: input.dir,
        baseManifestSha256: input.baseManifestSha256,
        latestManifestSha256: input.latestManifestSha256,
      }),
  }
}

// ─────────────────────────── DETACHED bridge (S12) ───────────────────────────

/** A single container file's identity as `docker exec find … -printf` reports it. */
export interface ContainerFileStat {
  /** Canonicalized in-container relpath (POSIX, no leading slash, mount-rooted). */
  relpath: string
  size: number
  /** mtime in whole seconds (find %T@ truncated — the cross-host granularity we rely on). */
  mtimeSec: number
}

/** Per-sandbox stat-cache entry: skip re-hashing a file whose (size,mtime) match. */
export interface StatCacheEntry {
  size: number
  mtimeSec: number
  sha256: string
}

export type StatCache = Map<string, StatCacheEntry>

/**
 * The `docker exec` seam. Injected so the whole detached bridge is unit-testable
 * against a fake container (the CI proof) without a real daemon. The default (a
 * real spawn) is built by makeRealDockerExec below. `stdin` bytes are piped to
 * the exec'd process (for the write path); the result carries exit + streams.
 */
export type DockerExecFn = (
  argv: string[],
  opts?: { stdin?: Buffer }
) => Promise<{ code: number; stdout: string; stderr: string }>

export interface DetachedBridgeOptions {
  containerId: string
  /** API-local scratch MIRROR dir — materializeSnapshot/scanCommitDir operate here. */
  mirrorDir: string
  /** In-container mount roots to enumerate (e.g. ["/conversation","/actor",…]). */
  mountRoots: string[]
  /** The `docker exec` seam (test-injected; default = real spawn). */
  exec: DockerExecFn
  /** Per-sandbox stat-cache (caller owns lifetime; survives across scans). */
  statCache: StatCache
  /** Injected for tests: read a mirror file's bytes (default = fs). */
  readMirrorFile?: (relpath: string) => Promise<Buffer>
  /** Injected for tests: list the mirror's files as canonical relpaths (default = fs walk). */
  listMirrorFiles?: () => Promise<string[]>
  /** Injected for tests: write fetched container bytes back into the mirror. */
  writeMirrorFile?: (relpath: string, bytes: Buffer) => Promise<void>
}

/** The plan a host-side diff produces for replicating the mirror into the container. */
export interface ReplicationPlan {
  /** relpaths to write (present in the mirror). Each is tmp-written then Moved. */
  writes: string[]
  /** relpaths to REMOVE in-container (present there, absent from the mirror). */
  removes: string[]
}

/**
 * Pure host-side diff: what to write (mirror files) vs. what to Remove (container
 * files no longer in the mirror). Delete-propagation is EXPLICIT (never implicit),
 * exactly as the envd bridge must do it — a file the agent deleted upstream is
 * removed in-container, not silently left behind.
 */
export function planReplication(
  mirrorFiles: readonly string[],
  containerFiles: readonly string[]
): ReplicationPlan {
  const mirror = new Set(mirrorFiles)
  const removes = containerFiles.filter((p) => !mirror.has(p))
  return { writes: [...mirror].sort(), removes: removes.sort() }
}

/**
 * Reconcile a container `find` listing against the stat-cache: (size,mtime) match
 * ⇒ reuse the cached sha (NO re-hash); mismatch/miss ⇒ the file must be fetched
 * (`docker exec cat`) + hashed. Returns the shas to reuse and the relpaths to fetch.
 */
export function reconcileStatCache(
  listing: readonly ContainerFileStat[],
  cache: StatCache
): { reused: Array<{ relpath: string; sha256: string }>; toFetch: string[] } {
  const reused: Array<{ relpath: string; sha256: string }> = []
  const toFetch: string[] = []
  for (const f of listing) {
    const hit = cache.get(f.relpath)
    if (hit && hit.size === f.size && hit.mtimeSec === f.mtimeSec) {
      reused.push({ relpath: f.relpath, sha256: hit.sha256 })
    } else {
      toFetch.push(f.relpath)
    }
  }
  return { reused, toFetch }
}

/** Parse `find <root> -type f -printf '%s %T@ %p\n'` output into ContainerFileStats. */
export function parseFindListing(stdout: string): ContainerFileStat[] {
  const out: ContainerFileStat[] = []
  for (const line of stdout.split("\n")) {
    const t = line.trim()
    if (!t) continue
    const firstSp = t.indexOf(" ")
    const secondSp = t.indexOf(" ", firstSp + 1)
    if (firstSp < 0 || secondSp < 0) continue
    const size = Number(t.slice(0, firstSp))
    const mtime = Math.trunc(Number(t.slice(firstSp + 1, secondSp)))
    const abs = t.slice(secondSp + 1)
    // Store the ABSOLUTE in-container path as the relpath key (mount-rooted; e.g.
    // "/conversation/x.py"). Canonical + stable across scans.
    if (!Number.isFinite(size) || !Number.isFinite(mtime)) continue
    out.push({ relpath: abs, size, mtimeSec: mtime })
  }
  return out
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * The detached remote bridge (S12). Implements the SAME WorkingSetBridge contract
 * the product bridge does, but drives the working set through `docker exec` +
 * host-computed plans. This is the exercisable model of the envd wire bridge.
 */
export interface DetachedWorkingSetBridge extends WorkingSetBridge {
  /** Enumerate the container tree (exposed for the stash/scan paths + tests). */
  listContainer(): Promise<ContainerFileStat[]>
  planFor(mirrorFiles: string[]): Promise<ReplicationPlan>
  /**
   * Steps ①②③ of scanManifest WITHOUT the final scanCommitDir: enumerate the
   * container tree, reconcile against the stat-cache, and `docker exec cat` +
   * hash + cache + mirror-write ONLY the (size,mtime)-mismatched files. Exposed so
   * the stat-cache contract (and the forced-commit-failure stash exfiltration) can
   * be exercised without the fs-helper. Returns the relpaths that were re-fetched.
   */
  fetchChangedIntoMirror(): Promise<{ fetched: string[]; reused: string[] }>
}

export function createDetachedWorkingSetBridge(
  opts: DetachedBridgeOptions
): DetachedWorkingSetBridge {
  const { containerId, mirrorDir, mountRoots, exec, statCache } = opts
  const readMirrorFile = opts.readMirrorFile ?? (async () => Buffer.alloc(0))
  const listMirrorFiles = opts.listMirrorFiles ?? (async () => [])

  const findArgs = (): string[] => [
    "exec",
    containerId,
    "find",
    ...mountRoots,
    "-type",
    "f",
    "-printf",
    "%s %T@ %p\\n",
  ]

  const listContainer = async (): Promise<ContainerFileStat[]> => {
    const res = await exec(findArgs())
    return parseFindListing(res.stdout)
  }

  const planFor = async (mirrorFiles: string[]): Promise<ReplicationPlan> => {
    const container = await listContainer()
    return planReplication(
      mirrorFiles,
      container.map((c) => c.relpath)
    )
  }

  const fetchChangedIntoMirror = async (): Promise<{
    fetched: string[]
    reused: string[]
  }> => {
    const listing = await listContainer()
    const { reused, toFetch } = reconcileStatCache(listing, statCache)
    const byPath = new Map(listing.map((f) => [f.relpath, f]))
    for (const rel of toFetch) {
      const res = await exec(["exec", containerId, "cat", rel])
      const bytes = Buffer.from(res.stdout, "binary")
      const sha = sha256Hex(bytes)
      const f = byPath.get(rel)
      if (f) {
        statCache.set(rel, { size: f.size, mtimeSec: f.mtimeSec, sha256: sha })
      }
      // write current bytes into the mirror so scanCommitDir sees them.
      await opts.writeMirrorFile?.(rel, bytes)
    }
    return { fetched: toFetch, reused: reused.map((r) => r.relpath) }
  }

  return {
    listContainer,
    planFor,
    fetchChangedIntoMirror,

    async applyManifest(input) {
      // ① materialize base into the API-local scratch MIRROR (CAS-world).
      await materializeSnapshot({
        manifestSha256: input.manifestSha256,
        targetDir: mirrorDir,
      })
      // ② replicate the mirror INTO the container (container-world), via
      //    write-tmp-then-Move + explicit Removes. NEVER docker cp / tar -x.
      const mirrorFiles = await listMirrorFiles()
      const plan = await planFor(mirrorFiles)
      // Writes: pipe bytes to a tmp path, then Move into place (atomic-ish rename).
      for (const rel of plan.writes) {
        const bytes = await readMirrorFile(rel)
        const tmp = `${rel}.synapse-tmp`
        await exec(["exec", "-i", containerId, "sh", "-c", `cat > '${tmp}'`], {
          stdin: bytes,
        })
        await exec(["exec", containerId, "mv", "-f", tmp, rel])
      }
      // Removes: delete-propagation for files the agent removed upstream.
      for (const rel of plan.removes) {
        await exec(["exec", containerId, "rm", "-f", rel])
      }
    },

    async scanManifest(input) {
      // ①②③ enumerate + reconcile via the stat-cache + fetch only the changed
      //      files into the mirror.
      await fetchChangedIntoMirror()
      // ④ run the EXISTING fused scan/commit engine on the MIRROR (Mode-A verbatim).
      return scanCommitDir({
        dir: input.dir ?? mirrorDir,
        baseManifestSha256: input.baseManifestSha256,
        latestManifestSha256: input.latestManifestSha256,
      })
    },
  }
}

// ─────────────────────── forced-commit-failure stash (S12) ───────────────────

/**
 * Forced-commit-failure stash (§7 / §4.7.4). A detached sandbox has NO
 * materialized_dir to preserve on a commit failure (the host-dir preservation the
 * product path relies on), so instead we best-effort EXFILTRATE the uncommitted
 * working set: fetch the changed files into the mirror, commit the mirror to CAS,
 * and record the resulting manifest as `sandboxes.stash_manifest_id` with
 * state='failed' as a GC root. Recovery re-appends from CAS with no live dir.
 *
 * This function implements the WRITE-side contract (exfiltrate → commit → record).
 * The persistence of (stash_manifest_id, state='failed') and the recovery-sweep
 * that re-appends `state='failed' AND stash_manifest_id IS NOT NULL` are injected
 * (`recordStash`) so the contract is testable without the DB; wiring the sweep
 * into the reconciler/GC is the honest spine-integration residual (see report).
 */
export async function stashUncommittedWorkingSet(input: {
  bridge: DetachedWorkingSetBridge
  scanManifest: (
    dir: string
  ) => Promise<{ mergedManifestSha256?: string } & Record<string, unknown>>
  mirrorDir: string
  /** Persist the stash pointer + flip state='failed' (DB seam; test-injectable). */
  recordStash: (manifestSha256: string) => Promise<void>
}): Promise<{ stashed: boolean; manifestSha256?: string }> {
  try {
    // Best-effort exfiltrate the uncommitted bytes into the mirror.
    await input.bridge.fetchChangedIntoMirror()
    const commit = await input.scanManifest(input.mirrorDir)
    const manifestSha = commit.mergedManifestSha256
    if (!manifestSha) {
      // Nothing to stash (empty working set) — still a clean "no stash" outcome.
      return { stashed: false }
    }
    await input.recordStash(manifestSha)
    return { stashed: true, manifestSha256: manifestSha }
  } catch {
    // Exfiltration itself failed → the caller keeps the sandbox alive until its
    // deadline + raises an operator alarm (handled by the caller, not here).
    return { stashed: false }
  }
}
