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
import { basename, dirname, join, relative } from "node:path"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
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

/** Cap on directory-recursion depth (defensive against a symlink-loop / pathological
 *  tree; the mount trees are shallow agent working sets). */
const MAX_LIST_DEPTH = 64

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
    out: ContainerFileStat[]
  ): Promise<void> => {
    if (depth > MAX_LIST_DEPTH) return
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
      if (e.type === "directory") {
        // Descend ALL subdirs incl dotdirs (find parity — 2b).
        await listOne(e.path, depth + 1, out)
        continue
      }
      // REGULAR files only — symlink/unknown are excluded (find -type f parity).
      if (e.type !== "file") continue
      // 2d: the mirror/stat-cache key is the VFS path (vmRoot stripped). A path not
      // under the VM root is skipped rather than leaked as a raw key.
      const relpath = vmToVfs(e.path, vmRoot, "")
      if (!relpath || !relpath.startsWith("/")) continue
      const ms = rfc3339ToEpochMs(e.modifiedTime)
      out.push({
        relpath,
        size: e.size ?? 0,
        // display-only whole-second (docker parity); NOT the reconcile key.
        mtimeSec: ms !== undefined ? Math.trunc(ms / 1000) : 0,
        // F6: FULL-MS key — a same-second in-place edit changes this, so the
        // reconcile re-fetches it. Absent mtime → undefined → reconcile fetches.
        mtimeKey: ms !== undefined ? String(ms) : undefined,
      })
    }
  }

  return {
    async list(mountRoots) {
      const out: ContainerFileStat[] = []
      for (const root of mountRoots) {
        await listOne(trimTrailingSlash(root), 0, out)
      }
      return out
    },
    async read(relpath) {
      return envd.readFile(vfsToVm(relpath, vmRoot))
    },
    async write(relpath, bytes) {
      // envd writeFile auto-creates parents + is a whole-file replace (NOT atomic;
      // acceptable for the base PUSH — the file is created fresh, no concurrent
      // reader of an unfinished tmp).
      await envd.writeFile(vfsToVm(relpath, vmRoot), bytes)
    },
    async remove(relpath) {
      await envd.remove(vfsToVm(relpath, vmRoot))
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
      readMirrorFile: (rel) => readFile(join(sandboxRoot, rel)),
      writeMirrorFile: async (rel, bytes) => {
        const target = join(sandboxRoot, rel)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, bytes)
      },
      listMirrorFiles: () => walkMirror(mirrorMountDir, sandboxRoot),
      removeMirrorFile: (rel) =>
        rm(join(sandboxRoot, rel), { force: true }).catch(() => {}),
    })
  }

  return {
    // PUSH: replicate the mount's already-materialized mirror into the VM
    // (materialize is idempotent — the spine wrote base into the mirror first).
    applyManifest: (input) =>
      scopedBridge(input.targetDir).applyManifest(input),
    // Full pull + prune + scanCommitDir (used by the round-trip test / future).
    scanManifest: (input) => scopedBridge(input.dir).scanManifest(input),
    // PULL-only (teardown/recovery): reconcile VM → mirror with delete-prune (F1),
    // leaving the commit scan to the spine's commitSpaces on the same mirror dir.
    async pull(input) {
      await scopedBridge(input.dir).fetchChangedIntoMirror()
    },
    // (R4 review fix) Release the per-bridge envd client's undici Agent — the spine
    // calls this after each push/pull so the keep-alive socket pool to CubeProxy is
    // not leaked on every provision/teardown/recovery under sustained session churn.
    async dispose() {
      await opts.envd.close().catch(() => {})
    },
  }
}
