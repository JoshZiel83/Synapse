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
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createLogger } from "../../../infrastructure/logger/index.js"
import type { WorkingSetBridge } from "../data-plane.js"
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
import { CubeEnvdNotFoundError } from "./types.js"

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
    out: ContainerFileStat[]
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
      if (e.type === "directory") {
        // Descend the RE-DERIVED clean VM path (not the raw envd path) — ALL subdirs
        // incl dotdirs (find parity — 2b).
        await listOne(vfsToVm(key, vmRoot), depth + 1, mountVfsRoot, out)
        continue
      }
      // REGULAR files only — symlink/unknown are excluded (find -type f parity).
      if (e.type !== "file") continue
      const ms = rfc3339ToEpochMs(e.modifiedTime)
      out.push({
        relpath: key,
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
        await listOne(trimmed, 0, mountVfsRoot, out)
      }
      return out
    },
    async read(relpath) {
      return envd.readFile(toVm(relpath))
    },
    async write(relpath, bytes) {
      // envd writeFile auto-creates parents + is a whole-file replace (NOT atomic;
      // acceptable for the base PUSH — the file is created fresh, no concurrent
      // reader of an unfinished tmp).
      await envd.writeFile(toVm(relpath), bytes)
    },
    async remove(relpath) {
      await envd.remove(toVm(relpath))
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

/**
 * (R4 §1.4c) The off-box working-set bridge over the plane's envd transport. ONE
 * per sandbox (shared stat-cache); each call is scoped to a single mount by the
 * mirror mount dir handed to it (= the mount's materializedDir). Exposes the
 * WorkingSetBridge contract PLUS `pull` — the teardown/recovery PULL-only primitive
 * (fetchChangedIntoMirror + F1 prune, WITHOUT scanCommitDir; the spine's separate
 * commitSpaces scan of the same mirror does the commit).
 */
export function createCubeEnvdWorkingSetBridge(opts: {
  envd: RemoteEnvdTransport
  vmRoot: string
  statCache: StatCache
  /** (#14) per-file PULL byte budget (= caps.maxReadBytes). An oversize VM file is
   *  preserved-and-excluded rather than buffered whole (OOM). */
  maxReadBytes?: number
}): WorkingSetBridge & { pull(input: { dir: string }): Promise<void> } {
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
      readMirrorFile: (rel) => {
        const target = join(sandboxRoot, rel)
        assertUnderMirror(target, mirrorMountDir)
        return readFile(target)
      },
      writeMirrorFile: async (rel, bytes) => {
        const target = join(sandboxRoot, rel)
        assertUnderMirror(target, mirrorMountDir) // (#1 belt) never write outside the mount
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, bytes)
      },
      listMirrorFiles: () => walkMirror(mirrorMountDir, sandboxRoot),
      removeMirrorFile: (rel) => {
        const target = join(sandboxRoot, rel)
        assertUnderMirror(target, mirrorMountDir) // (#1 belt) never delete outside the mount
        return rm(target, { force: true }).catch(() => {})
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
    async pull(input) {
      const res = await scopedBridge(input.dir).fetchChangedIntoMirror()
      if (res.preserved.length > 0) {
        // (#14) preservation marker: an oversize VM file was NOT pulled (would OOM
        // the shared API). It stays in the VM; its mirror bytes (base, if any) are
        // untouched → it is excluded from this turn's commit rather than truncated.
        log.warn(
          { dir: input.dir, preserved: res.preserved },
          "working-set PULL preserved-and-excluded oversize file(s) (> maxReadBytes) — not committed this turn"
        )
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
