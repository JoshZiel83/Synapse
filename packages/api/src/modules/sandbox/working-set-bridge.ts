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
//   DETACHED path (S12/R4 — off-box remote bridge): NO volume mounts; the working
//     set lives inside the sandbox VM and is driven ENTIRELY over a
//     WorkingSetTransport (never docker cp / tar -x). applyManifest materializes
//     base into an API-local scratch MIRROR then replicates into the VM
//     write-then-Move with explicit Removes for delete-propagation; scanManifest
//     reconciles the VM tree back into the mirror through a per-sandbox stat-cache
//     (delete-PRUNING the mirror to exactly the VM listing — F1), then runs the
//     EXISTING fused scanCommitDir on the mirror.
//
// R4 Phase 1c abstracts the container seam from `docker exec` to a transport
// interface (WorkingSetTransport) BOTH a docker-exec wrapper AND the off-box envd
// client satisfy. The docker-exec transport keeps the CI-proven S12 path (and its
// tests) working verbatim; the envd transport (cubesandbox/working-set.ts) is the
// prod off-box bridge. The delete-aware-mirror + stat-cache algorithm is identical
// across both — only the transport differs.

import { createHash } from "node:crypto"
import type { Readable } from "node:stream"
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

// ─────────────────────────── DETACHED bridge (S12/R4) ─────────────────────────

/** A single container/VM file's identity as the transport reports it. */
export interface ContainerFileStat {
  /** Canonicalized in-container relpath (POSIX, no leading slash, mount-rooted). */
  relpath: string
  /**
   * (#5) 'file' (a regular file — has bytes + a hash) or 'dir' (a directory — no
   * bytes). Only EMPTY directories are emitted as 'dir' entries: a non-empty dir is
   * implied by its files' parents (materialize/writeMirrorFile create them), but an
   * empty dir has no file to imply it, so it must round-trip explicitly or it is
   * lost on PULL/PUSH. A 'dir' entry is never read/hashed and its size is 0.
   */
  kind: "file" | "dir"
  size: number
  /** mtime in whole seconds (docker `find %T@` truncated — the docker-transport
   *  granularity). For the envd transport this is Math.trunc(ms/1000) and is NOT
   *  the reconcile key (see `mtimeKey`). */
  mtimeSec: number
  /**
   * (F6) FULL-resolution mtime key. The envd transport sets this to the RFC-3339
   * millisecond stamp so a same-size same-SECOND in-place edit is NOT a false
   * cache hit (a lost update). When present on EITHER the listing entry or the
   * cached entry, the stat-cache reconcile keys on THIS (never the truncated
   * second). The docker-exec transport leaves it undefined (`find %T@` carries no
   * sub-second precision), so docker keeps its (size, mtimeSec) key.
   */
  mtimeKey?: string
}

/** Per-sandbox stat-cache entry: skip re-hashing a file whose stat matches. */
export interface StatCacheEntry {
  size: number
  mtimeSec: number
  sha256: string
  /** (F6) full-resolution mtime key mirrored from the fetched ContainerFileStat. */
  mtimeKey?: string
}

export type StatCache = Map<string, StatCacheEntry>

// ─────────────────────────── the transport seam ──────────────────────────────

/**
 * The container/VM transport the detached bridge drives. Abstracted (R4 §1.4) so
 * the SAME delete-aware-mirror + stat-cache algorithm runs over EITHER a docker
 * `exec` wrapper (the CI proof) OR the off-box envd client (prod). Keys are
 * mount-rooted relpaths (`/conversation/x.py`), identical across transports — that
 * is what the docker-vs-envd list-parity invariant (2d) guarantees.
 */
export interface WorkingSetTransport {
  /** Enumerate every REGULAR file under the given roots (docker: `find -type f`;
   *  envd: recursive listDir). Symlinks/other are excluded; dotfiles/dotdirs are
   *  included. Relpaths are mount-rooted. */
  list(mountRoots: string[]): Promise<ContainerFileStat[]>
  /** Read a file's whole bytes (docker: `cat`; envd: readFile). */
  read(relpath: string): Promise<Buffer>
  /** (R6 #3) STREAM a file's bytes as a Node Readable — the PULL pipes this into the
   *  mirror so an arbitrarily large VM file transfers without OOM AND without loss.
   *  Present on the envd transport; ABSENT on the docker-exec test transport (which
   *  falls back to the whole-buffer `read`). */
  readStream?(relpath: string): Promise<Readable>
  /** Write a file's whole bytes, creating parents (docker: tmp-write + `mv -f`;
   *  envd: writeFile whole-file replace). */
  write(relpath: string, bytes: Buffer): Promise<void>
  /** Remove a file (docker: `rm -f`; envd: remove). Idempotent. */
  remove(relpath: string): Promise<void>
  /** (#5) Create an (empty) directory + parents (docker: `mkdir -p`; envd: makeDir,
   *  already-exists = success). Idempotent — round-trips an empty dir into the VM. */
  makeDir(relpath: string): Promise<void>
}

/**
 * The `docker exec` seam. Injected so the docker-exec transport is unit-testable
 * against a fake container (the CI proof) without a real daemon. `stdin` bytes are
 * piped to the exec'd process (for the write path).
 */
export type DockerExecFn = (
  argv: string[],
  opts?: { stdin?: Buffer }
) => Promise<{ code: number; stdout: string; stderr: string }>

/**
 * (R4 §1.4a) The docker-exec WorkingSetTransport — wraps the CI-proven
 * find/cat/(cat>tmp+mv)/rm argv verbatim so the docker:bare S12 detached path (and
 * its tests) keep working unchanged. Delete-propagation writes go tmp-then-Move
 * (atomic-ish rename); Removes are explicit `rm -f`.
 */
export function makeDockerExecTransport(opts: {
  containerId: string
  exec: DockerExecFn
}): WorkingSetTransport {
  const { containerId, exec } = opts
  const findArgs = (mountRoots: string[]): string[] => [
    "exec",
    containerId,
    "find",
    ...mountRoots,
    "-type",
    "f",
    "-printf",
    "%s %T@ %p\\n",
  ]
  return {
    async list(mountRoots) {
      const res = await exec(findArgs(mountRoots))
      return parseFindListing(res.stdout)
    },
    async read(relpath) {
      const res = await exec(["exec", containerId, "cat", relpath])
      return Buffer.from(res.stdout, "binary")
    },
    async write(relpath, bytes) {
      const tmp = `${relpath}.synapse-tmp`
      await exec(["exec", "-i", containerId, "sh", "-c", `cat > '${tmp}'`], {
        stdin: bytes,
      })
      await exec(["exec", containerId, "mv", "-f", tmp, relpath])
    },
    async remove(relpath) {
      await exec(["exec", containerId, "rm", "-f", relpath])
    },
    async makeDir(relpath) {
      await exec(["exec", containerId, "mkdir", "-p", relpath])
    },
  }
}

export interface DetachedBridgeOptions {
  /** API-local scratch MIRROR dir — materializeSnapshot/scanCommitDir operate here. */
  mirrorDir: string
  /** In-container/VM mount roots to enumerate (VM-absolute for envd, e.g.
   *  ["/workspace/conversation"]; container-absolute for docker). */
  mountRoots: string[]
  /** The container/VM transport (docker-exec or envd). */
  transport: WorkingSetTransport
  /** Per-sandbox stat-cache (caller owns lifetime; survives across scans). */
  statCache: StatCache
  /** Injected: read a mirror file's bytes (default = empty). */
  readMirrorFile?: (relpath: string) => Promise<Buffer>
  /** Injected: list the mirror's files as canonical relpaths (default = []). */
  listMirrorFiles?: () => Promise<string[]>
  /** Injected: write fetched container/VM bytes back into the mirror. */
  writeMirrorFile?: (relpath: string, bytes: Buffer) => Promise<void>
  /** (F1) Injected: remove a mirror file the VM no longer has (delete-prune). */
  removeMirrorFile?: (relpath: string) => Promise<void>
  /** (#5) Injected: create an (empty) directory + parents in the mirror (mkdir -p).
   *  Used to round-trip an empty VM dir into the mirror so scanCommitDir commits it. */
  makeMirrorDir?: (relpath: string) => Promise<void>
  /** (#5) Injected: list the mirror's EMPTY directories as canonical relpaths
   *  (default = []). Drives the empty-dir prune (delete-propagation) + the PUSH. */
  listMirrorEmptyDirs?: () => Promise<string[]>
  /** (#5) Injected: remove an (empty) mirror directory the VM no longer has. */
  removeMirrorDir?: (relpath: string) => Promise<void>
  /**
   * (R6 #3) Injected: STREAM a VM file into the mirror via the transport's readStream,
   * with a rolling sha256 — writes to a tmp path then renames over the target ATOMICALLY.
   * Used for files LARGER than `maxReadBytes` so an arbitrarily large file transfers
   * without a whole-body buffer (no OOM) AND without loss (the R5 preserve-and-skip lost
   * >10 MiB files). Returns the streamed sha + byte count for the stat-cache.
   */
  writeMirrorFileStream?: (
    relpath: string,
    source: Readable
  ) => Promise<{ sha256: string; size: number }>
  /**
   * (R6 #3) STREAM THRESHOLD — a file whose listed size EXCEEDS this is STREAMED
   * (readStream → writeMirrorFileStream) instead of whole-read, so it never buffers
   * whole. Small files stay whole-read (one round-trip). Undefined / no readStream ⇒
   * whole-read always (the docker CI-proof + unit tests). Set to caps.maxReadBytes
   * off-box. (This REPLACES the R5 preserve-and-skip: streamed, never skipped.)
   */
  maxReadBytes?: number
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
 * removed in-container, not silently left behind. (This is the PUSH-side delete
 * set; its PULL-side twin is the mirror prune in fetchChangedIntoMirror — F1.)
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
 * (F6) Does a cached stat still identify the listed file? Size must match, and the
 * mtime is compared at FULL resolution when EITHER side carries a `mtimeKey` (the
 * envd RFC-3339 ms stamp) — so a same-size same-SECOND in-place edit is a MISS
 * (re-fetched), never a false hit. Only when NEITHER side has a full-resolution
 * key (the docker `find %T@` path) does it fall back to the truncated second.
 */
function statCacheHit(hit: StatCacheEntry, f: ContainerFileStat): boolean {
  if (hit.size !== f.size) return false
  if (f.mtimeKey !== undefined || hit.mtimeKey !== undefined) {
    // Full-resolution compare: an absent key on either side is treated as a
    // mismatch (fetch) rather than silently degrading to the truncated second.
    return (
      f.mtimeKey !== undefined &&
      hit.mtimeKey !== undefined &&
      f.mtimeKey === hit.mtimeKey
    )
  }
  return hit.mtimeSec === f.mtimeSec
}

/**
 * Reconcile a container/VM listing against the stat-cache: a stat match ⇒ reuse
 * the cached sha (NO re-hash); mismatch/miss ⇒ the file must be fetched + hashed.
 * Returns the shas to reuse and the relpaths to fetch. (F6-aware — see statCacheHit.)
 */
export function reconcileStatCache(
  listing: readonly ContainerFileStat[],
  cache: StatCache
): { reused: Array<{ relpath: string; sha256: string }>; toFetch: string[] } {
  const reused: Array<{ relpath: string; sha256: string }> = []
  const toFetch: string[] = []
  for (const f of listing) {
    const hit = cache.get(f.relpath)
    if (hit && statCacheHit(hit, f)) {
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
    // "/conversation/x.py"). Canonical + stable across scans. No mtimeKey — `find
    // %T@` carries no sub-second precision, so docker keeps its (size, sec) key.
    if (!Number.isFinite(size) || !Number.isFinite(mtime)) continue
    // `find -type f` yields only regular files → kind:'file'. (The detached docker
    // transport is the CI proof of the FILE algorithm; off-box empty-dir round-trip
    // is exercised over the envd transport, which emits 'dir' entries.)
    out.push({ relpath: abs, kind: "file", size, mtimeSec: mtime })
  }
  return out
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * The detached remote bridge (S12/R4). Implements the SAME WorkingSetBridge
 * contract the product bridge does, but drives the working set through a
 * WorkingSetTransport + host-computed plans. This is the exercisable model of the
 * envd wire bridge AND (over the envd transport) the prod off-box bridge itself.
 */
export interface DetachedWorkingSetBridge extends WorkingSetBridge {
  /** Enumerate the container/VM tree (exposed for the stash/scan paths + tests). */
  listContainer(): Promise<ContainerFileStat[]>
  planFor(mirrorFiles: string[]): Promise<ReplicationPlan>
  /**
   * The PULL primitive: enumerate the container/VM tree, reconcile against the
   * stat-cache, fetch + hash + cache + mirror-write ONLY the changed files, then
   * (F1) PRUNE the mirror — remove every mirror file absent from the listing so
   * the mirror reflects EXACTLY the VM (a VM-deleted file must not resurrect from
   * the base copy) BEFORE any scanCommitDir. Returns the fetched/reused/pruned
   * relpaths.
   */
  fetchChangedIntoMirror(): Promise<{
    fetched: string[]
    reused: string[]
    pruned: string[]
    /** (R6 #3) files the transport could NOT read (read/stream error) — NOT captured,
     *  so the VM's bytes are the sole copy and the caller MUST NOT delete the VM.
     *  Empty ⇒ the pull captured everything. (A large file is STREAMED, never skipped.) */
    unreadable: string[]
  }>
  /**
   * (R5 #8) Replicate the ALREADY-POPULATED mirror INTO the container/VM — the
   * NON-destructive PUSH. Unlike `applyManifest`, it does NOT re-run
   * materializeSnapshot (which CLEARS the mirror tree first): the spine has already
   * materialized base AND restored the `.synapse-conflicts` sidecars into the mirror
   * before an off-box push, so re-materializing would DELETE the restored sidecars
   * (while sidecarRestoreOk stayed true — a false positive). This only diffs the
   * current mirror against the VM and writes/removes the delta.
   */
  pushMirrorToContainer(): Promise<void>
}

export function createDetachedWorkingSetBridge(
  opts: DetachedBridgeOptions
): DetachedWorkingSetBridge {
  const { mirrorDir, mountRoots, transport, statCache } = opts
  const readMirrorFile = opts.readMirrorFile ?? (async () => Buffer.alloc(0))
  const listMirrorFiles = opts.listMirrorFiles ?? (async () => [])
  const listMirrorEmptyDirs = opts.listMirrorEmptyDirs ?? (async () => [])

  const listContainer = (): Promise<ContainerFileStat[]> =>
    transport.list(mountRoots)

  const planFor = async (mirrorFiles: string[]): Promise<ReplicationPlan> => {
    const container = await listContainer()
    // (#5) The FILE replication plan diffs FILES only — a container 'dir' entry must
    // never land in `removes` (that would rm an empty VM dir the mirror doesn't
    // separately list). Empty-dir push is handled explicitly in pushMirrorToContainer.
    return planReplication(
      mirrorFiles,
      container.filter((c) => c.kind === "file").map((c) => c.relpath)
    )
  }

  const fetchChangedIntoMirror = async (): Promise<{
    fetched: string[]
    reused: string[]
    pruned: string[]
    unreadable: string[]
  }> => {
    const listing = await listContainer()
    // (#5) Split the listing: only FILES go through the stat-cache reconcile + fetch
    // (a 'dir' entry has no bytes to read/hash). 'dir' entries are the EMPTY
    // directories the VM carries — they are mkdir'd into the mirror below so
    // scanCommitDir commits them.
    const fileListing = listing.filter((f) => f.kind === "file")
    const dirListing = listing.filter((f) => f.kind === "dir")
    const { reused, toFetch } = reconcileStatCache(fileListing, statCache)
    const byPath = new Map(fileListing.map((f) => [f.relpath, f]))
    const maxReadBytes = opts.maxReadBytes
    const fetched: string[] = []
    const unreadable: string[] = []

    // (F1 / §6.4 / #5 collision-fix) PRUNE runs BEFORE the writes. Rebuild the mirror
    // to EXACTLY the VM listing FIRST — every mirror file/empty-dir absent from the
    // VM is deleted upstream, so remove it. Pruning first is what makes a file↔dir
    // REPLACEMENT safe: if the base mirror holds a FILE at `/x` and the VM now has a
    // DIR `/x/…` (or vice-versa), the stale node is removed here so the write below
    // can mkdir/writeFile at `/x` without an ENOTDIR/EISDIR collision that would
    // otherwise abort the WHOLE pull every turn. File-prune precedes empty-dir-prune
    // (removing a file can leave its dir empty); a dir the VM still carries is kept,
    // and a mirror dir the fetch needs is re-created by the write's parent-mkdir.
    const presentFiles = new Set(fileListing.map((f) => f.relpath))
    // (#5) A mirror empty-dir is still NEEDED if the VM lists it as an empty dir OR
    // it is an ANCESTOR of any VM file/dir — otherwise pruning a transiently-empty
    // ancestor (e.g. /conversation after its only file is pruned) would rmdir a dir
    // the fetch is about to write back into (harmless churn, but it also wrongly
    // reports the ancestor as 'pruned'). Only a dir the VM genuinely dropped is
    // rmdir'd (empty-dir delete-propagation).
    const neededDirs = new Set<string>()
    const addAncestors = (p: string): void => {
      let cur = p
      let i = cur.lastIndexOf("/")
      while (i > 0) {
        cur = cur.slice(0, i)
        neededDirs.add(cur)
        i = cur.lastIndexOf("/")
      }
    }
    for (const f of fileListing) addAncestors(f.relpath)
    for (const d of dirListing) {
      neededDirs.add(d.relpath)
      addAncestors(d.relpath)
    }
    const pruned: string[] = []
    for (const rel of await listMirrorFiles()) {
      if (!presentFiles.has(rel)) {
        await opts.removeMirrorFile?.(rel)
        statCache.delete(rel)
        pruned.push(rel)
      }
    }
    // (#5 collision-fix) Collapse empty-dir CHAINS to a fixpoint. listMirrorEmptyDirs
    // reports LEAF empty dirs only, so removing a leaf can expose a newly-empty
    // PARENT that a single pass would miss — leaving e.g. `/x` as an empty directory
    // when the base held `/x/sub/deep.txt` and the VM now has a FILE at `/x`, which
    // would then EISDIR on the write. Re-walk + prune until no non-needed empty dir
    // remains, so the whole stale chain is gone before the file write lands. (Bounded:
    // each pass removes ≥1 dir or stops; a needed ancestor is always spared.)
    let prunedADir = true
    while (prunedADir) {
      prunedADir = false
      for (const rel of await listMirrorEmptyDirs()) {
        if (!neededDirs.has(rel)) {
          await opts.removeMirrorDir?.(rel)
          pruned.push(rel)
          prunedADir = true
        }
      }
    }

    // Fetch the changed files INTO the (now-pruned) mirror. A per-file read/stream
    // FAILURE is caught into `unreadable` (never buffered-and-lost): the pull returns
    // NOT-durable so the caller keeps the VM (its bytes are the sole copy) — this is
    // the R6 #3 fix that replaces the R5 preserve-and-SKIP that silently lost >10 MiB
    // files at teardown.
    const canStream =
      typeof transport.readStream === "function" &&
      typeof opts.writeMirrorFileStream === "function"
    for (const rel of toFetch) {
      const f = byPath.get(rel)
      try {
        // (#3) STREAM a large file (size > threshold) — never a whole-body buffer, so
        // no OOM AND no loss, any size.
        if (
          f &&
          canStream &&
          maxReadBytes !== undefined &&
          f.size > maxReadBytes
        ) {
          const src = await transport.readStream!(rel)
          const { sha256, size } = await opts.writeMirrorFileStream!(rel, src)
          statCache.set(rel, {
            size,
            mtimeSec: f.mtimeSec,
            mtimeKey: f.mtimeKey,
            sha256,
          })
          fetched.push(rel)
          continue
        }
        // Small file (or the docker CI transport with no readStream): whole-read.
        const bytes = await transport.read(rel)
        const sha = sha256Hex(bytes)
        if (f) {
          statCache.set(rel, {
            size: f.size,
            mtimeSec: f.mtimeSec,
            mtimeKey: f.mtimeKey,
            sha256: sha,
          })
        }
        fetched.push(rel)
        await opts.writeMirrorFile?.(rel, bytes)
      } catch {
        // A gone VM surfaces on list() before this loop; a per-file failure here is a
        // file-level read error. Mark it unreadable (pull NOT durable → VM kept) and
        // continue so the other files still pull.
        unreadable.push(rel)
      }
    }
    // (#5) Round-trip EMPTY directories: mkdir every VM 'dir' entry into the mirror
    // so the following scanCommitDir commits it. (A non-empty dir already exists via
    // its files' writeMirrorFile parent-mkdir, so this only materially adds the empty
    // ones; mkdir -p is idempotent.)
    for (const rel of dirListing) {
      await opts.makeMirrorDir?.(rel.relpath)
    }
    return {
      fetched,
      reused: reused.map((r) => r.relpath),
      pruned,
      unreadable,
    }
  }

  const pushMirrorToContainer = async (): Promise<void> => {
    // NON-destructive PUSH (#8): replicate the mirror (already base+sidecars) into
    // the VM — write-then-Move + explicit Removes — WITHOUT re-materializing.
    const mirrorFiles = await listMirrorFiles()
    const plan = await planFor(mirrorFiles)
    for (const rel of plan.writes) {
      const bytes = await readMirrorFile(rel)
      await transport.write(rel, bytes)
    }
    for (const rel of plan.removes) {
      await transport.remove(rel)
    }
    // (#5) Replicate EMPTY directories the mirror carries into the VM — a non-empty
    // dir is created by its files' write above, but an empty base dir has no file to
    // imply it, so it must be mkdir'd explicitly or it never reaches the VM.
    for (const rel of await listMirrorEmptyDirs()) {
      await transport.makeDir(rel)
    }
  }

  return {
    listContainer,
    planFor,
    fetchChangedIntoMirror,
    pushMirrorToContainer,

    async applyManifest(input) {
      // ① materialize base into the API-local scratch MIRROR (CAS-world), then ②
      //    replicate the mirror INTO the container/VM. (The off-box spine uses the
      //    NON-destructive pushMirrorToContainer directly — #8 — because it has
      //    already materialized base + restored sidecars into the mirror.)
      await materializeSnapshot({
        manifestSha256: input.manifestSha256,
        targetDir: mirrorDir,
      })
      await pushMirrorToContainer()
    },

    async scanManifest(input) {
      // ①②③ enumerate + reconcile via the stat-cache + fetch only the changed
      //      files into the mirror + (F1) PRUNE the mirror to the VM listing.
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
