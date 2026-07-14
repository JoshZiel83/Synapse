// OFF-BOX working-set bridge (R4 §1.4 / §6.4 / §6.8, P0). The envd realization of
// the detached working-set bridge: it drives the CI-proven delete-aware-mirror +
// stat-cache algorithm (working-set-bridge.ts) over the cube plane's
// RemoteEnvdTransport instead of `docker exec`. NO new wire client — the SAME envd
// client the data plane holds.
//
// HARD INVARIANTS (§6.8):
//   2d — mirror relpath keys, stat-cache keys and the scanCommitDir dir are ALL
//        VFS/mount-rooted (post-vmToVfs → "/conversation/x.py"); the listDir roots
//        are VM-absolute ("${vmRoot}/conversation"). A raw VM path leaking into a
//        mirror key would make base(VFS) and pulled(VM) sets disjoint → every base
//        file reads deleted + every pulled file new.
//   2b — the envd `list` replicates `find <roots> -type f` EXACTLY: REGULAR files
//        only (symlink/other excluded), descend all subdirs incl dotdirs, include
//        dotfiles.
//   F6 — the stat-cache keys on FULL-MS mtime (mtimeKey), never the docker
//        second-truncation, so a same-size same-second in-place edit is re-fetched.
//
// The spine drives ONE bridge per off-box sandbox; each applyManifest/scanManifest/
// pull call is SCOPED to a single mount by the mirror mount dir it is handed (=
// the mount's materializedDir, `<sandboxRoot>/<subpath>`), from which the VM mount
// root (`${vmRoot}/<subpath>`) and the VFS key prefix (`/<subpath>`) are derived.

import { Buffer } from "node:buffer"
import {
  basename,
  dirname,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path"
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises"
import { createWriteStream } from "node:fs"
import { createHash } from "node:crypto"
import { Transform, type Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createLogger } from "../../../infrastructure/logger/index.js"
import type { PullOutcome, OffBoxWorkingSetBridge } from "../data-plane.js"
import {
  createDetachedWorkingSetBridge,
  type ContainerFileStat,
  type StatCache,
  type WorkingSetTransport,
} from "../working-set-bridge.js"
import {
  rfc3339ToEpochMs,
  trimTrailingSlash,
  vfsToVm,
  vmToVfs,
  type RemoteEnvdTransport,
} from "./data-plane.js"
import { CubeEnvdError, CubeEnvdNotFoundError } from "./types.js"

const log = createLogger("sandbox.cubesandbox")

/**
 * (R5 #5) Max directory-recursion depth. A GENUINE on-disk directory cycle (a
 * bind-mount of a parent into a child) makes recursion unbounded → OOM/hang the
 * SHARED API, so exceeding this FAILS LOUD (a typed error the pull path surfaces as
 * a preservation warning), never the old silent `return` that dropped every deeper
 * file → pruned the mirror → committed spurious deletes. Raised far above any real
 * agent working set. (Symlink cycles are already safe — listOne never follows a
 * symlink type.)
 */
const MAX_LIST_DEPTH = 4096

/** A working-set transport invariant was violated (path traversal / depth cycle).
 *  Thrown fail-loud so the pull/push aborts + preserves rather than corrupting. */
export class WorkingSetTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkingSetTransportError"
  }
}

/**
 * (R5 #1 SECURITY) POSIX-only working-set key normalizer + mount-scope guard.
 *
 * The working-set channel maps envd-returned entry paths onto BOTH host (mirror) and
 * VM filesystem sinks, and envd is UNTRUSTED (the agent runs code inside the VM — the
 * exact adversary the tool plane's canonicalVfsPath defends against). This is the
 * working-set channel's equivalent guard. It deliberately does NOT reuse
 * canonicalVfsPath: that is a DOS/Windows validator that THROWS on legal Linux names
 * (aux/con/com1/trailing dot or space/`:`/`\`) — using it here would DROP legitimate
 * base files → prune them from the mirror → commit spurious deletes. Instead this
 * ONLY collapses `.`/`..` (posix.normalize, which drops `..` past the root) and
 * REJECTS a key that escapes its mount VFS root. Returns the canonical mount-rooted
 * key, or null for a non-absolute / escaping key (an attacker-crafted envd path).
 */
export function scopeWorkingSetKey(
  vfsKey: string,
  mountVfsRoot: string
): string | null {
  if (!vfsKey || !vfsKey.startsWith("/")) return null
  const norm = posix.normalize(vfsKey)
  if (norm !== mountVfsRoot && !norm.startsWith(`${mountVfsRoot}/`)) return null
  return norm
}

/** (R5 #1 belt) Assert a host mirror target resolves UNDER the mirror mount dir
 *  before any write/read/remove touches it. Fail-loud on an escape. */
function assertUnderMirror(target: string, mirrorMountDir: string): void {
  const root = resolve(mirrorMountDir)
  const abs = resolve(target)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new WorkingSetTransportError(
      `working-set mirror write escapes the mount dir (blocked): ${target}`
    )
  }
}

/**
 * (R6 #1 SECURITY) Walk `target`'s path components UNDER the mirror mount, NO-FOLLOW,
 * and return the first component that is a symlink (leaf or ancestor), else null.
 *
 * `lstat` only refuses to follow its LAST component, so we must check each component
 * top-down and STOP at the first symlink — never `lstat` a path whose ancestor is a
 * symlink (that would follow it). Because we return at the first symlink, every path
 * we lstat has only real-dir ancestors, so this correctly detects a symlink at ANY
 * depth without ever following one. The mount root itself is trusted (it is created by
 * the spine under STORAGE_DIR, not from a snapshot), so the walk starts BELOW it.
 */
async function firstSymlinkComponentUnderMirror(
  target: string,
  mirrorMountDir: string
): Promise<string | null> {
  const root = resolve(mirrorMountDir)
  const rel = relative(root, resolve(target))
  if (rel === "" || rel.startsWith("..")) return null // == mount root or outside (assertUnderMirror covers outside)
  let cur = root
  for (const part of rel.split(sep)) {
    if (!part) continue
    cur = join(cur, part)
    let st
    try {
      st = await lstat(cur)
    } catch {
      return null // component absent → nothing below it to follow
    }
    if (st.isSymbolicLink()) return cur
  }
  return null
}

/**
 * (R6 #1 SECURITY) Neutralize a symlink on the WRITE path. CAS materializes a base
 * snapshot symlink as a REAL host symlink in the off-box mirror; a lexical
 * assertUnderMirror cannot see it, so mkdir/writeFile would FOLLOW it and write
 * OUTSIDE the mirror as the shared API process. Before creating the real node, UNLINK
 * the first symlink component so the subsequent mkdir/writeFile lands on a REAL path
 * inside the mount — the actor's bytes stay inside the mount (no legit data loss) and
 * the weaponized symlink is dropped (off-box can't round-trip symlinks anyway, H-7).
 * The one symlink is the only one on the path (everything below it lived under its
 * target, outside the mirror), so a single unlink suffices.
 */
async function neutralizeMirrorSymlink(
  target: string,
  mirrorMountDir: string
): Promise<void> {
  const sym = await firstSymlinkComponentUnderMirror(target, mirrorMountDir)
  if (sym !== null) {
    log.warn(
      { symlink: sym, mount: mirrorMountDir, target },
      "working-set: unlinked a mirror symlink on the write path (off-box escape blocked)"
    )
    await unlink(sym).catch(() => {})
  }
}

/**
 * (R6 #1 SECURITY) Refuse a READ whose mirror path traverses a symlink — reading
 * THROUGH a host symlink would exfiltrate an arbitrary host file INTO the VM/CAS.
 * (In practice `walkMirror` never emits a symlink-traversing path, so this is a
 * fail-loud belt for a corrupt/hostile mirror.)
 */
async function assertNoSymlinkOnReadPath(
  target: string,
  mirrorMountDir: string
): Promise<void> {
  const sym = await firstSymlinkComponentUnderMirror(target, mirrorMountDir)
  if (sym !== null) {
    throw new WorkingSetTransportError(
      `working-set read path traverses a symlink (blocked): ${sym}`
    )
  }
}

/** (R5 #1 belt) Assert a lowered VM path stays UNDER the VM mount root before the
 *  raw envd read/write/remove leg (closes the in-VM boundary erosion). */
function assertUnderVmRoot(vmPath: string, vmMountRoot: string): void {
  const root = trimTrailingSlash(vmMountRoot)
  // normalize FIRST — a raw string-prefix check passes "/workspace/../etc" (it
  // literally starts with "/workspace/"), so collapse `..` before comparing.
  const norm = posix.normalize(vmPath)
  if (norm !== root && !norm.startsWith(`${root}/`)) {
    throw new WorkingSetTransportError(
      `working-set VM op escapes the mount root (blocked): ${vmPath}`
    )
  }
}

/**
 * (R4 §1.4b / 2b / 2d) The envd WorkingSetTransport. `list` recurses `listDir`
 * over the VM-absolute mount roots and back-translates each REGULAR file's VM path
 * to a VFS key (vmToVfs), carrying the FULL-MS mtime (F6). read/write/remove lower
 * the VFS key to the VM path (vfsToVm) and dial the raw envd — NO grant confinement
 * (the working set is the supervisor's whole-mount view, not a per-tool grant).
 */
export function makeEnvdWorkingSetTransport(opts: {
  envd: RemoteEnvdTransport
  vmRoot: string
}): WorkingSetTransport {
  const { envd, vmRoot } = opts

  const listOne = async (
    vmDir: string,
    depth: number,
    mountVfsRoot: string,
    out: ContainerFileStat[],
    // (#5) The current directory's own VFS key (null for the mount root, which is
    // never emitted as an entry). When this dir turns out EMPTY, it is emitted as a
    // 'dir' entry so an empty directory round-trips (create/delete survives a turn).
    currentKey: string | null
  ): Promise<void> => {
    if (depth > MAX_LIST_DEPTH) {
      throw new WorkingSetTransportError(
        `working-set list depth ${depth} exceeds ${MAX_LIST_DEPTH} under ${mountVfsRoot} (possible directory cycle)`
      )
    }
    let entries
    try {
      entries = await envd.listDir(vmDir)
    } catch (err) {
      // A not-yet-created mount root (fresh VM, pre-push) lists as empty — NOT an
      // error. Any other transport error propagates (fail-loud on the pull path).
      if (err instanceof CubeEnvdNotFoundError) return
      throw err
    }
    // (#5) An EMPTY nested directory has no file to imply it → emit an explicit
    // 'dir' entry so it round-trips. The mount root itself (currentKey===null) is
    // never emitted (it always exists as the mount; an empty mount = empty manifest).
    if (entries.length === 0 && currentKey !== null) {
      out.push({ relpath: currentKey, kind: "dir", size: 0, mtimeSec: 0 })
      return
    }
    for (const e of entries) {
      // (R5 #1 SECURITY) The envd entry path is UNTRUSTED. Normalize + scope-check it
      // to the mount VFS root BEFORE it is used as a recursion root OR a mirror key.
      // An escaping key (a malicious/compromised envd injecting `..`) is DROPPED —
      // never dialed, never a host/VM sink. This is the working-set channel's mirror
      // of the tool plane's canonicalVfsPath on the same untrusted-VM surface.
      const key = scopeWorkingSetKey(vmToVfs(e.path, vmRoot, ""), mountVfsRoot)
      if (key === null) {
        log.warn(
          { vmDir, rawPath: e.path, mountVfsRoot },
          "working-set: dropped an out-of-scope envd entry (path traversal blocked)"
        )
        continue
      }
      // (R6 #1 read-side SECURITY) envd STAT-FOLLOWS symlinks: a VM symlink is reported
      // with the TARGET's `type` ('file'/'directory'), so `type !== 'file'` alone does
      // NOT exclude it — a symlink to /etc/passwd would be read THROUGH (exfiltrating an
      // out-of-mount file into this mount's CAS), and a symlink to a dir would be
      // RECURSED INTO (pulling an external tree in). The `permissions` field is
      // LSTAT-based (a symlink's symbolic mode leads with 'l'/'L'), so it is the
      // reliable no-follow signal. EXCLUDE any symlink here, BEFORE the dir-recursion —
      // the read-side twin of the write-side neutralizeMirrorSymlink. (Symlinks do not
      // round-trip off-box anyway; see the factory doc H-7.)
      if (typeof e.permissions === "string" && /^[lL]/.test(e.permissions)) {
        log.warn(
          { vmDir, rawPath: e.path, permissions: e.permissions },
          "working-set: excluded a VM symlink (envd stat-follows type; lstat permissions reveal the link) — no read-through"
        )
        continue
      }
      if (e.type === "directory") {
        // Descend the RE-DERIVED clean VM path (not the raw envd path) — ALL subdirs
        // incl dotdirs (find parity — 2b). Pass the child's key so an EMPTY subdir
        // emits its own 'dir' entry (#5).
        await listOne(vfsToVm(key, vmRoot), depth + 1, mountVfsRoot, out, key)
        continue
      }
      // REGULAR files only — symlink/unknown are excluded (find -type f parity).
      if (e.type !== "file") continue
      const ms = rfc3339ToEpochMs(e.modifiedTime)
      out.push({
        relpath: key,
        kind: "file",
        size: e.size ?? 0,
        // display-only whole-second (docker parity); NOT the reconcile key.
        mtimeSec: ms !== undefined ? Math.trunc(ms / 1000) : 0,
        // F6: FULL-MS key — a same-second in-place edit changes this, so the
        // reconcile re-fetches it. Absent mtime → undefined → reconcile fetches.
        mtimeKey: ms !== undefined ? String(ms) : undefined,
      })
    }
  }

  /** Lower a validated VFS key to the VM path + belt-assert it stays under vmRoot. */
  const toVm = (relpath: string): string => {
    const vm = vfsToVm(relpath, vmRoot)
    assertUnderVmRoot(vm, trimTrailingSlash(vmRoot))
    return vm
  }

  return {
    async list(mountRoots) {
      const out: ContainerFileStat[] = []
      for (const root of mountRoots) {
        const trimmed = trimTrailingSlash(root)
        // The mount's VFS root (e.g. "/conversation") — the scope every entry key
        // under this root must stay within.
        const mountVfsRoot = vmToVfs(trimmed, vmRoot, "")
        if (!mountVfsRoot.startsWith("/")) {
          throw new WorkingSetTransportError(
            `working-set mount root is not under the VM root: ${root}`
          )
        }
        await listOne(trimmed, 0, mountVfsRoot, out, null)
      }
      return out
    },
    async read(relpath) {
      return envd.readFile(toVm(relpath))
    },
    // (R6 #3) STREAM read — present only when the underlying envd supports it (prod
    // CubeEnvdClient does; a test stub may not). The bridge streams VM→mirror through
    // this so a large file never buffers whole.
    readStream: envd.readFileStream
      ? (relpath) => envd.readFileStream!(toVm(relpath))
      : undefined,
    async write(relpath, bytes) {
      // envd writeFile auto-creates parents + is a whole-file replace (NOT atomic;
      // acceptable for the base PUSH — the file is created fresh, no concurrent
      // reader of an unfinished tmp).
      await envd.writeFile(toVm(relpath), bytes)
    },
    async remove(relpath) {
      await envd.remove(toVm(relpath))
    },
    async makeDir(relpath) {
      // envd MakeDir is recursive (creates parents). A pre-existing dir is a 409
      // already_exists — success for our idempotent makeDir (#5).
      try {
        await envd.makeDir(toVm(relpath))
      } catch (err) {
        if (
          err instanceof CubeEnvdError &&
          (err.status === 409 || err.code === "already_exists")
        ) {
          return
        }
        throw err
      }
    },
  }
}

/** Recursively walk the mirror mount dir, returning VFS keys ("/subpath/rel")
 *  rooted at the sandbox root (dirname of the mount dir) so the keys align with the
 *  transport's vmToVfs keys (2d). */
async function walkMirror(
  mountDir: string,
  sandboxRoot: string
): Promise<string[]> {
  const out: string[] = []
  const recurse = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // dir absent → nothing to list
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        await recurse(full)
      } else if (e.isFile()) {
        // "/" + POSIX-relative(sandboxRoot, full) → "/subpath/rel".
        out.push(`/${relative(sandboxRoot, full).split(/[\\/]/).join("/")}`)
      }
      // symlinks/other: excluded (find -type f parity on the mirror side too).
    }
  }
  await recurse(mountDir)
  return out
}

/** (#5) Walk the mirror mount dir, returning VFS keys for EMPTY directories (never
 *  the mount root itself — it always exists as the mount). Mirrors the transport's
 *  listOne empty-dir emission so the PULL prune + the PUSH replicate the same set. */
async function walkMirrorEmptyDirs(
  mountDir: string,
  sandboxRoot: string
): Promise<string[]> {
  const out: string[] = []
  const recurse = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // dir absent → nothing to list
    }
    if (entries.length === 0) {
      if (dir !== mountDir) {
        out.push(`/${relative(sandboxRoot, dir).split(/[\\/]/).join("/")}`)
      }
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) await recurse(join(dir, e.name))
    }
  }
  await recurse(mountDir)
  return out
}

/**
 * (R4 §1.4c) The off-box working-set bridge over the plane's envd transport. ONE
 * per sandbox (shared stat-cache); each call is scoped to a single mount by the
 * mirror mount dir handed to it (= the mount's materializedDir). Exposes the
 * WorkingSetBridge contract PLUS `pull` — the teardown/recovery PULL-only primitive
 * (fetchChangedIntoMirror + F1 prune, WITHOUT scanCommitDir; the spine's separate
 * commitSpaces scan of the same mirror does the commit).
 *
 * (R6 H-7) OFF-BOX FIDELITY LIMITATIONS — the working set is REGULAR FILES + empty
 * dirs only; two POSIX attributes do NOT round-trip a VM→mirror→CAS→push cycle:
 *   • SYMLINKS: neutralized on the write path + excluded from the walk (find -type f
 *     parity). This is DELIBERATE and SECURITY-LOAD-BEARING (R6 #1): a VM-controlled
 *     symlink materialized into the host mirror would let a malicious VM escape the
 *     mirror on the next write/read (host-file exfil / arbitrary-write). Preserving
 *     symlinks would reopen that hole, so it is a PERMANENT limitation, not a gap.
 *   • FILE MODE (the exec bit): the pull writes each mirror file at the host default
 *     (umask) mode, NOT the VM entry's mode, so an executable authored in the VM loses
 *     +x across a teardown/re-provision boundary. The CAS manifest itself DOES carry
 *     mode (fs-helper materialize/scan), so this is fixable by threading the envd
 *     FileEntry.mode through the working-set transport + chmod-on-write — deferred as a
 *     documented fidelity gap (a P2 that would touch the security-sensitive write path)
 *     rather than plumbed here. Host planes (local/docker) are unaffected: their mirror
 *     IS the live dir, so mode + symlinks are native.
 */
export function createCubeEnvdWorkingSetBridge(opts: {
  envd: RemoteEnvdTransport
  vmRoot: string
  statCache: StatCache
  /** (#14) per-file PULL byte budget (= caps.maxReadBytes). An oversize VM file is
   *  preserved-and-excluded rather than buffered whole (OOM). */
  maxReadBytes?: number
}): OffBoxWorkingSetBridge {
  const transport = makeEnvdWorkingSetTransport({
    envd: opts.envd,
    vmRoot: opts.vmRoot,
  })

  const scopedBridge = (mirrorMountDir: string) => {
    const subpath = basename(mirrorMountDir)
    const sandboxRoot = dirname(mirrorMountDir)
    const vmMountRoot = vfsToVm(`/${subpath}`, opts.vmRoot)
    return createDetachedWorkingSetBridge({
      mirrorDir: mirrorMountDir,
      mountRoots: [vmMountRoot],
      transport,
      statCache: opts.statCache,
      readMirrorFile: async (rel) => {
        const target = join(sandboxRoot, rel)
        assertUnderMirror(target, mirrorMountDir)
        // (#1) never READ through a symlink (would exfil a host file into the VM/CAS).
        await assertNoSymlinkOnReadPath(target, mirrorMountDir)
        return readFile(target)
      },
      writeMirrorFile: async (rel, bytes) => {
        const target = join(sandboxRoot, rel)
        assertUnderMirror(target, mirrorMountDir) // lexical belt (never OUTSIDE the mount)
        // (#1) NO-FOLLOW: unlink any symlink component so writeFile lands on a REAL
        // node inside the mount, never followed outside it.
        await neutralizeMirrorSymlink(target, mirrorMountDir)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, bytes)
      },
      // (R6 #3) STREAM a large VM file into the mirror — pipe the transport Readable
      // through a rolling sha256 into a tmp file, then rename over the target ATOMICALLY.
      // Never buffers the whole file (no OOM) and never skips it (no loss). Same #1
      // symlink-neutralize + lexical belt as writeMirrorFile.
      writeMirrorFileStream: async (rel, source: Readable) => {
        const target = join(sandboxRoot, rel)
        assertUnderMirror(target, mirrorMountDir)
        await neutralizeMirrorSymlink(target, mirrorMountDir)
        await mkdir(dirname(target), { recursive: true })
        const tmp = `${target}.synapse-tmp`
        const hash = createHash("sha256")
        let size = 0
        const meter = new Transform({
          transform(chunk, _enc, cb) {
            hash.update(chunk)
            size += chunk.length
            cb(null, chunk)
          },
        })
        try {
          await pipeline(source, meter, createWriteStream(tmp))
          await rename(tmp, target)
        } catch (err) {
          await rm(tmp, { force: true }).catch(() => {})
          throw err
        }
        return { sha256: hash.digest("hex"), size }
      },
      listMirrorFiles: () => walkMirror(mirrorMountDir, sandboxRoot),
      removeMirrorFile: (rel) => {
        const target = join(sandboxRoot, rel)
        assertUnderMirror(target, mirrorMountDir) // (#1 belt) never delete outside the mount
        // rm removes the LEAF (symlink or file) without following it; walkMirror never
        // emits a symlink-ancestor path, so no ancestor-follow can occur here.
        return rm(target, { force: true }).catch(() => {})
      },
      // (#5) empty-dir round-trip: create/list/remove empty mirror directories, each
      // belt-asserted under the mount (never escape it — the same #1 guard as files).
      makeMirrorDir: async (rel) => {
        const target = join(sandboxRoot, rel)
        assertUnderMirror(target, mirrorMountDir)
        // (#1) NO-FOLLOW: unlink any symlink component so the dir is created REAL.
        await neutralizeMirrorSymlink(target, mirrorMountDir)
        await mkdir(target, { recursive: true })
      },
      listMirrorEmptyDirs: () =>
        walkMirrorEmptyDirs(mirrorMountDir, sandboxRoot),
      removeMirrorDir: (rel) => {
        const target = join(sandboxRoot, rel)
        assertUnderMirror(target, mirrorMountDir)
        // rmdir removes ONLY an empty dir (fails loud if a race left it non-empty);
        // best-effort like removeMirrorFile (a concurrent delete is not an error).
        return rmdir(target).catch(() => {})
      },
      maxReadBytes: opts.maxReadBytes,
    })
  }

  return {
    // PUSH (#8): replicate the mount's already-populated mirror into the VM. The
    // spine has ALREADY materialized base AND restored `.synapse-conflicts` sidecars
    // into the mirror before this call, so we must NOT re-materialize (which would
    // CLEAR the tree and delete the restored sidecars). Use the non-destructive
    // replicate-only push instead of applyManifest.
    applyManifest: (input) =>
      scopedBridge(input.targetDir).pushMirrorToContainer(),
    // Full pull + prune + scanCommitDir (used by the round-trip test / future).
    scanManifest: (input) => scopedBridge(input.dir).scanManifest(input),
    // PULL-only (teardown/recovery): reconcile VM → mirror with delete-prune (F1),
    // leaving the commit scan to the spine's commitSpaces on the same mirror dir.
    async pull(input): Promise<PullOutcome> {
      const res = await scopedBridge(input.dir).fetchChangedIntoMirror()
      if (res.unreadable.length > 0) {
        // (#3) DURABILITY: some file(s) could not be read/streamed, so the pull did
        // NOT capture them — the VM's bytes are still the sole copy. The caller MUST
        // treat this pull as NOT durable and keep the VM (never delete it).
        log.error(
          { dir: input.dir, unreadable: res.unreadable },
          "working-set PULL could not read file(s) — pull is NOT durable; the VM must be preserved for recovery"
        )
      }
      return {
        pulled: res.fetched,
        pruned: res.pruned,
        unreadable: res.unreadable,
      }
    },
    // (R4 review fix) Release the per-bridge envd client's undici Agent — the spine
    // calls this after each push/pull so the keep-alive socket pool to CubeProxy is
    // not leaked on every provision/teardown/recovery under sustained session churn.
    async dispose() {
      await opts.envd.close().catch(() => {})
    },
  }
}
