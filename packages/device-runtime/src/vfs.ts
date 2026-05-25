// VFS — Virtual File System projection inside the device runtime. Per spec
// §6 Notes, VFS is NOT a capability_kind — it is a projection layered on top
// of filesystem / browser / cua exposures. This module ports
// relay/internal/vfs/ to TS at the abstraction level (path tree, sessions,
// exposures, capability-grant bridge). The FUSE mount adapter is deferred
// (v3.0 non-goal).

import { promises as fsp } from "node:fs"
import { randomUUID } from "node:crypto"
import { resolve, sep } from "node:path"

export type VfsNodeKind = "directory" | "file"

export interface VfsEntry {
  name: string
  path: string
  kind: VfsNodeKind
  size?: number
  writable?: boolean
  mimeType?: string
  modTime?: string
}

export interface VfsReadResult {
  data: Uint8Array
  mimeType: string
  writable: boolean
}

export interface VfsWriteResult {
  data: Uint8Array
  mimeType: string
}

export interface VfsExposure {
  capability: "filesystem" | "browser" | "cua"
  stableKey: string
  name: string
  metadata?: Record<string, unknown>
}

export interface VfsSessionState {
  capability: VfsExposure["capability"]
  exposureStableKey: string
  sessionId: string
  runtimeSessionId: string
  selectedPageId?: number
  createdAt: string
}

export interface VfsBackend {
  start(): Promise<void>
  list(path: string): Promise<VfsEntry[]>
  stat(path: string): Promise<VfsEntry | null>
  read(path: string): Promise<VfsReadResult>
  write(path: string, data: Uint8Array): Promise<VfsWriteResult>
}

export interface VfsServiceOptions {
  backend: VfsBackend
}

/**
 * VfsService — TS port of relay/internal/vfs/service.go. The backend layer
 * is abstracted so the v3.0 filesystem builtin can plug in a local-fs
 * implementation while future browser / cua backends provide their own.
 */
export class VfsService {
  private exposures = new Map<string, VfsExposure>()
  private sessions = new Map<string, VfsSessionState>()
  private sessionSeq = 0

  constructor(private readonly opts: VfsServiceOptions) {}

  async start(): Promise<void> {
    await this.opts.backend.start()
  }

  registerExposure(exposure: VfsExposure): void {
    this.exposures.set(exposure.stableKey, exposure)
  }

  listExposures(): VfsExposure[] {
    return Array.from(this.exposures.values())
  }

  openSession(input: {
    capability: VfsExposure["capability"]
    exposureStableKey: string
    runtimeSessionId: string
  }): VfsSessionState {
    this.sessionSeq += 1
    const state: VfsSessionState = {
      capability: input.capability,
      exposureStableKey: input.exposureStableKey,
      sessionId: `vfs-${this.sessionSeq}`,
      runtimeSessionId: input.runtimeSessionId,
      createdAt: new Date().toISOString(),
    }
    this.sessions.set(state.sessionId, state)
    return state
  }

  closeSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  list(path: string): Promise<VfsEntry[]> {
    return this.opts.backend.list(path)
  }
  stat(path: string): Promise<VfsEntry | null> {
    return this.opts.backend.stat(path)
  }
  read(path: string): Promise<VfsReadResult> {
    return this.opts.backend.read(path)
  }
  write(path: string, data: Uint8Array): Promise<VfsWriteResult> {
    return this.opts.backend.write(path, data)
  }
}

/**
 * Local-filesystem VfsBackend. Roots browsing at a configurable directory.
 * Every input path is resolved against the root and rejected if it escapes
 * outside (defeats `../../etc/passwd`-style traversal). The runtime
 * authorization layer (§4.5 step 6) is enforced upstream; this backend
 * still gates path containment defensively because VFS exposures are
 * commonly the seed for user-visible file pickers.
 */
export function createLocalFsBackend(opts: { rootPath: string }): VfsBackend {
  const root = resolve(opts.rootPath)
  // Normalize so `root === "/srv/data"` and a child like `/srv/data/foo` both
  // share the same `/srv/data/` prefix. Without the trailing sep, `/srv/data2`
  // would slip past the containment check.
  const rootWithSep = root.endsWith(sep) ? root : root + sep

  function safeResolve(input: string): string {
    // resolve() collapses `..` segments and produces an absolute path; we
    // anchor at root so relative inputs cannot escape via an absolute prefix.
    const cleaned = input.replace(/^\/+/, "")
    const candidate = resolve(root, cleaned)
    if (candidate !== root && !candidate.startsWith(rootWithSep)) {
      throw new Error(
        `vfs: path escapes root (input=${JSON.stringify(input)})`
      )
    }
    return candidate
  }

  return {
    async start() {
      await fsp.mkdir(root, { recursive: true })
    },
    async list(path: string) {
      const target = safeResolve(path)
      const entries = await fsp.readdir(target, { withFileTypes: true })
      const out: VfsEntry[] = []
      for (const e of entries) {
        const childPath = `${path.replace(/\/$/, "")}/${e.name}`
        try {
          const st = await fsp.stat(safeResolve(childPath))
          out.push({
            name: e.name,
            path: childPath,
            kind: e.isDirectory() ? "directory" : "file",
            size: e.isFile() ? st.size : undefined,
            writable: true,
            modTime: st.mtime.toISOString(),
          })
        } catch {
          /* skip */
        }
      }
      return out
    },
    async stat(path: string) {
      let target: string
      try {
        target = safeResolve(path)
      } catch {
        return null
      }
      try {
        const st = await fsp.stat(target)
        return {
          name: target.split(sep).pop() ?? "",
          path,
          kind: st.isDirectory() ? "directory" : "file",
          size: st.isFile() ? st.size : undefined,
          writable: true,
          modTime: st.mtime.toISOString(),
        }
      } catch {
        return null
      }
    },
    async read(path: string) {
      const target = safeResolve(path)
      const data = await fsp.readFile(target)
      return {
        data: new Uint8Array(data),
        mimeType: "application/octet-stream",
        writable: true,
      }
    },
    async write(path: string, data: Uint8Array) {
      const target = safeResolve(path)
      await fsp.writeFile(target, data)
      return { data, mimeType: "application/octet-stream" }
    },
  }
}

export function createVfsService(opts: VfsServiceOptions): VfsService {
  return new VfsService(opts)
}

void randomUUID
