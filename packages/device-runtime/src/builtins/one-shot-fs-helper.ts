// One-shot fs-helper driver: spawn a fresh synapse-device-fs-helper process,
// drive a handful of CAS/manifest RPCs over line-delimited JSON-RPC, then
// shut it down. Used supervisor-side (the API sandbox manager) to
// materialize / commit / sync file spaces against the shared CAS without
// keeping a long-lived helper around.
//
// Deliberately self-contained (only node:child_process + node:readline) so
// it can be imported by the API package without dragging in the rest of the
// device-runtime. The long-lived FsHelperClient (fs-helper-client.ts) is the
// right tool when a device-runtime serves a live sandbox; this is the right
// tool for short supervisor-side batches.

import { spawn, type ChildProcess } from "node:child_process"
import { createInterface, type Interface } from "node:readline"
import type {
  CasGcInput,
  CasGcResult,
  CasHasInput,
  CasHasResult,
  CasPutInput,
  CasPutResult,
  DirSyncInput,
  DirSyncResult,
  ManifestCleanupInput,
  ManifestMaterializeInput,
  ManifestScanCommitInput,
  ManifestScanCommitResult,
  SidecarRestoreInput,
} from "./fs-helper-types.js"

export interface OneShotFsHelperOptions {
  /** Absolute path to the synapse-device-fs-helper binary. */
  helperPath: string
  /** Shared CAS dir (--cas-dir). Required for cas/manifest RPCs. */
  casDir: string
  /**
   * --root / --work-dir are required by the binary's CLI even though the
   * one-shot CAS/manifest ops don't touch the per-device sqlite. We point
   * them at scratch (defaults to casDir-relative throwaways) so a one-shot
   * invocation never collides with a live device-runtime's work-dir.
   */
  rootPath?: string
  workDir?: string
  /** Per-RPC timeout (default 120s — big trees take a while to ingest). */
  rpcTimeoutMs?: number
  /** Spawn override (tests). */
  spawnImpl?: typeof spawn
}

export class OneShotFsHelperError extends Error {
  constructor(
    public method: string,
    public rpcCode: number,
    public rpcMessage: string
  ) {
    super(`one-shot fs-helper ${method} error ${rpcCode}: ${rpcMessage}`)
    this.name = "OneShotFsHelperError"
  }
}

interface Pending {
  resolve(v: unknown): void
  reject(e: Error): void
  method: string
}

const DEFAULT_RPC_TIMEOUT_MS = 120_000

/**
 * A handle over a spawned one-shot helper. Call the typed methods, then
 * `close()` (which flushes stdin + waits for exit). Always close it — prefer
 * `withOneShotFsHelper` which closes in a finally.
 */
export class OneShotFsHelper {
  private child: ChildProcess
  private rl: Interface
  private pending = new Map<string, Pending>()
  private nextId = 1
  private exited = false
  private exitErr: Error | null = null
  private readonly timeoutMs: number

  constructor(opts: OneShotFsHelperOptions) {
    const spawnImpl = opts.spawnImpl ?? spawn
    this.timeoutMs = opts.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
    const root = opts.rootPath ?? `${opts.casDir}/.oneshot-root`
    const work = opts.workDir ?? `${opts.casDir}/.oneshot-work`
    const args = ["--root", root, "--work-dir", work, "--cas-dir", opts.casDir]
    this.child = spawnImpl(opts.helperPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.rl = createInterface({ input: this.child.stdout! })
    this.rl.on("line", (line) => this.onLine(line))
    this.child.on("exit", (code) => {
      this.exited = true
      this.exitErr = new Error(
        `one-shot fs-helper exited (code=${code ?? "null"})`
      )
      for (const [, p] of this.pending) p.reject(this.exitErr)
      this.pending.clear()
    })
    this.child.on("error", (err) => {
      this.exited = true
      this.exitErr = err
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
    })
  }

  private onLine(line: string): void {
    if (!line.trim()) return
    let frame: {
      id?: string | number
      result?: unknown
      error?: { code: number; message: string }
    }
    try {
      frame = JSON.parse(line)
    } catch {
      return
    }
    if (frame.id === undefined || frame.id === null) return
    const key = String(frame.id)
    const p = this.pending.get(key)
    if (!p) return
    this.pending.delete(key)
    if (frame.error) {
      p.reject(
        new OneShotFsHelperError(
          p.method,
          frame.error.code,
          frame.error.message
        )
      )
    } else {
      p.resolve(frame.result)
    }
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    if (this.exited) {
      return Promise.reject(
        this.exitErr ?? new Error("one-shot fs-helper already exited")
      )
    }
    const id = String(this.nextId++)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`one-shot fs-helper RPC timed out (${method})`))
        // Kill the wedged process; close() will reap it.
        try {
          this.child.kill("SIGKILL")
        } catch {
          /* ignore */
        }
      }, this.timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v as T)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      const frame = { jsonrpc: "2.0", id, method, params }
      this.child.stdin?.write(JSON.stringify(frame) + "\n")
    })
  }

  casPut(input: CasPutInput): Promise<CasPutResult> {
    return this.request("fs.cas.put", input)
  }
  casHas(input: CasHasInput): Promise<CasHasResult> {
    return this.request("fs.cas.has", input)
  }
  casGc(input: CasGcInput): Promise<CasGcResult> {
    return this.request("fs.cas.gc", input)
  }
  manifestMaterialize(input: ManifestMaterializeInput): Promise<void> {
    return this.request("fs.manifest.materialize", input)
  }
  manifestScanCommit(
    input: ManifestScanCommitInput
  ): Promise<ManifestScanCommitResult> {
    return this.request("fs.manifest.scan_commit", input)
  }
  dirSync(input: DirSyncInput): Promise<DirSyncResult> {
    return this.request("fs.dir.sync", input)
  }
  manifestCleanup(input: ManifestCleanupInput): Promise<void> {
    return this.request("fs.manifest.cleanup", input)
  }
  sidecarRestore(input: SidecarRestoreInput): Promise<void> {
    return this.request("fs.sidecar.restore", input)
  }

  /** Flush stdin (signals EOF → graceful exit) and wait for the child. */
  async close(): Promise<void> {
    try {
      this.child.stdin?.end()
    } catch {
      /* ignore */
    }
    if (this.exited) return
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          this.child.kill("SIGKILL")
        } catch {
          /* ignore */
        }
        resolve()
      }, 2_000)
      this.child.once("exit", () => {
        clearTimeout(t)
        resolve()
      })
    })
  }
}

/**
 * Run `fn` with a freshly-spawned one-shot helper, closing it in a finally
 * (even on throw). The common entry point — callers rarely manage the
 * handle lifecycle themselves.
 */
export async function withOneShotFsHelper<T>(
  opts: OneShotFsHelperOptions,
  fn: (helper: OneShotFsHelper) => Promise<T>
): Promise<T> {
  const helper = new OneShotFsHelper(opts)
  try {
    return await fn(helper)
  } finally {
    await helper.close()
  }
}
