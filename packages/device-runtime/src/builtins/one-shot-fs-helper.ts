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
import {
  FS_HELPER_PROTO_VERSION,
  FsHelperProtoMismatchError,
  assertFsHelperProto,
} from "./fs-helper-resolve.js"
import type {
  CasGcInput,
  CasGcResult,
  CasHasInput,
  CasHasResult,
  CasImportUrlInput,
  CasImportUrlResult,
  CasExportUrlInput,
  CasExportUrlResult,
  CasPutInput,
  CasPutResult,
  DirSyncInput,
  DirApplyHeadInput,
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
  /**
   * Axis-B SSRF allowlist (plan §9.3③): the host(s) the helper is permitted to
   * GET/PUT against for `casImportUrl`/`casExportUrl`. Threaded to the binary's
   * `--presign-allow-host` (repeatable AND comma-separated; main.rs:46). Omitted
   * for the same-host axis-A path, which issues no network presigned transfers.
   */
  presignAllowHost?: string[]
  /**
   * W3C `traceparent` (P7). When set, it is stamped onto every outbound
   * JSON-RPC frame so the spawned helper's spans continue the supervisor's
   * trace (api → one-shot fs-helper). The api caller passes its active
   * traceparent; omitted = the helper starts root spans. Kept as a plain
   * string so this driver stays OTel-SDK-free (node-only, per the file header).
   */
  traceparent?: string
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
const hasOwn = Object.prototype.hasOwnProperty

type OneShotFsHelperFrame =
  | { id: string; result: unknown }
  | { id: string; error: { code: number; message: string } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseOneShotFsHelperFrame(
  line: string
): OneShotFsHelperFrame | null {
  if (!line.trim()) return null
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(value) || value.jsonrpc !== "2.0") return null
  const rawId = value.id
  if (
    (typeof rawId !== "string" && typeof rawId !== "number") ||
    rawId === ""
  ) {
    return null
  }
  const hasResult = hasOwn.call(value, "result")
  const hasError = hasOwn.call(value, "error")
  if (hasResult === hasError) return null

  if (hasError) {
    const error = value.error
    if (
      !isRecord(error) ||
      typeof error.code !== "number" ||
      !Number.isInteger(error.code) ||
      typeof error.message !== "string"
    ) {
      return null
    }
    return {
      id: String(rawId),
      error: { code: error.code, message: error.message },
    }
  }

  return { id: String(rawId), result: value.result }
}

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
  private readonly traceparent?: string

  constructor(opts: OneShotFsHelperOptions) {
    const spawnImpl = opts.spawnImpl ?? spawn
    this.timeoutMs = opts.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
    this.traceparent = opts.traceparent
    const root = opts.rootPath ?? `${opts.casDir}/.oneshot-root`
    const work = opts.workDir ?? `${opts.casDir}/.oneshot-work`
    const args = ["--root", root, "--work-dir", work, "--cas-dir", opts.casDir]
    // Axis-B SSRF allowlist (plan §9.3③): pin the hosts the helper may transfer
    // to/from for presigned import/export. The flag is repeatable.
    for (const host of opts.presignAllowHost ?? []) {
      args.push("--presign-allow-host", host)
    }
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
    const frame = parseOneShotFsHelperFrame(line)
    if (!frame) return
    const key = frame.id
    const p = this.pending.get(key)
    if (!p) return
    this.pending.delete(key)
    if ("error" in frame) {
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
      // Stamp the supervisor's traceparent (P7) so the helper's spans continue
      // this trace; mirrors the long-lived sidecar transport (sidecar.ts).
      const frame = this.traceparent
        ? { jsonrpc: "2.0", id, method, params, traceparent: this.traceparent }
        : { jsonrpc: "2.0", id, method, params }
      this.child.stdin?.write(`${JSON.stringify(frame)}\n`)
    })
  }

  /**
   * Verify the spawned binary speaks our wire protocol before any real RPC.
   * Throws FsHelperProtoMismatchError on version mismatch, or if the binary
   * predates the handshake (method_not_found). Call once, right after spawn —
   * withOneShotFsHelper does this automatically.
   */
  async handshake(): Promise<void> {
    let hello: unknown
    try {
      hello = await this.request("fs.hello", {})
    } catch (err) {
      // A pre-handshake binary has no fs.hello → method_not_found (-32601).
      // Surface that as a proto mismatch (rebuild needed), not a generic error.
      if (err instanceof OneShotFsHelperError && err.rpcCode === -32601) {
        throw new FsHelperProtoMismatchError(
          FS_HELPER_PROTO_VERSION,
          undefined,
          undefined
        )
      }
      throw err
    }
    assertFsHelperProto(hello)
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
  /** Axis-B import: GET a supervisor-minted presigned URL into --cas-dir (plan §8.4). */
  casImportUrl(input: CasImportUrlInput): Promise<CasImportUrlResult> {
    return this.request("fs.cas.import_url", input)
  }
  /** Axis-B export: PUT a local blob to a supervisor-minted presigned URL (plan §8.4). */
  casExportUrl(input: CasExportUrlInput): Promise<CasExportUrlResult> {
    return this.request("fs.cas.export_url", input)
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
  dirApplyHead(input: DirApplyHeadInput): Promise<void> {
    return this.request("fs.dir.apply_head", input)
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
    await helper.handshake()
    return await fn(helper)
  } finally {
    await helper.close()
  }
}
