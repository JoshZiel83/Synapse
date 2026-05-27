// Client wrapper around the synapse-device-fs-helper Rust sidecar.
// Adds per-RPC timeout, restart-on-unexpected-exit (single retry inside 60s
// window then parks), method-specific timeouts, stderr-tail capture for
// helper_log_tail in error _meta.

import { existsSync } from "node:fs"
import type { SidecarHandle } from "../sidecar.js"
import { startSidecar } from "../sidecar.js"
import type {
  HistorySnapshotInput,
  HistorySnapshotResult,
  HistorySnapshotDeleteInput,
  HistoryGetInput,
  HistoryGetResult,
  HistoryListInput,
  HistoryListResult,
  HistoryDiffInput,
  HistoryDiffResult,
  HistoryRestoreInput,
  HistoryRestoreResult,
  IndexRebuildInput,
  IndexRebuildResult,
  IndexStatusInput,
  IndexStatusResult,
  IndexUpsertInput,
  IndexRemoveInput,
  SearchContentInput,
  SearchContentResult,
  SearchPathInput,
  SearchPathResult,
  ExtractTextInput,
  ExtractTextResult,
} from "./fs-helper-types.js"

export interface FsHelperClientOptions {
  helperPath: string
  rootPath: string
  workDir: string
  tikaEndpoint?: string
  indexIgnore?: string
  maxSnapshotBytes: number
  maxExtractBytes: number
  maxDiffSourceBytes: number
  maxDiffOutputBytes: number
  maxSearchLimit: number
  maxHistoryListLimit: number
  maxOffset: number
  maxHistoryBytes: number
  maxVersionsPerPath: number
  keepRecentVersions: number
  defaultRpcTimeoutMs?: number
  // For tests: override startSidecar.
  startSidecarImpl?: typeof startSidecar
  logger?: {
    warn(msg: string, data?: Record<string, unknown>): void
    error(msg: string, data?: Record<string, unknown>): void
  }
}

export class FsHelperUnavailableError extends Error {
  constructor(reason: string) {
    super(`fs-helper unavailable: ${reason}`)
    this.name = "FsHelperUnavailableError"
  }
}

export class FsHelperTimeoutError extends Error {
  constructor(
    public method: string,
    public timeoutMs: number
  ) {
    super(`fs-helper RPC timed out after ${timeoutMs}ms: ${method}`)
    this.name = "FsHelperTimeoutError"
  }
}

export class FsHelperRpcError extends Error {
  constructor(
    public method: string,
    public rpcCode: number,
    public rpcMessage: string
  ) {
    super(`fs-helper ${method} error ${rpcCode}: ${rpcMessage}`)
    this.name = "FsHelperRpcError"
  }
}

const DEFAULT_TIMEOUT_MS = 30_000
const METHOD_TIMEOUT_OVERRIDES: Record<string, number> = {
  "fs.history.snapshot": 60_000,
  "fs.history.snapshot_delete": 60_000,
  "fs.extract.text": 60_000,
  // Sidecar dispatches the actual walk to a background tokio task; the
  // RPC itself just registers the task and returns a task_id, so the
  // dispatch turnaround is fast. Keep the timeout modest but not 5s —
  // generating the task_id + first SQLite writes can spike on slow disks.
  "fs.index.rebuild": 15_000,
}

const STDERR_TAIL_BYTES = 4096
const PARK_WINDOW_MS = 60_000

interface RestartHistory {
  lastRestartAt: number | null
  parked: boolean
}

export interface FsHelperClient {
  /** Returns true if the helper is configured + available + not parked. */
  isAvailable(): boolean
  /** Stop the supervised sidecar (best-effort). */
  stop(): Promise<void>

  historyGet(input: HistoryGetInput): Promise<HistoryGetResult>
  historySnapshot(input: HistorySnapshotInput): Promise<HistorySnapshotResult>
  historySnapshotDelete(
    input: HistorySnapshotDeleteInput
  ): Promise<HistorySnapshotResult>
  historyList(input: HistoryListInput): Promise<HistoryListResult>
  historyDiff(input: HistoryDiffInput): Promise<HistoryDiffResult>
  historyRestore(input: HistoryRestoreInput): Promise<HistoryRestoreResult>

  indexRebuild(input: IndexRebuildInput): Promise<IndexRebuildResult>
  indexStatus(input: IndexStatusInput): Promise<IndexStatusResult>
  indexUpsert(input: IndexUpsertInput): Promise<void>
  indexRemove(input: IndexRemoveInput): Promise<void>

  searchContent(input: SearchContentInput): Promise<SearchContentResult>
  searchPath(input: SearchPathInput): Promise<SearchPathResult>

  extractText(input: ExtractTextInput): Promise<ExtractTextResult>
}

export function createFsHelperClient(
  opts: FsHelperClientOptions
): FsHelperClient {
  const logger = opts.logger ?? {
    warn(msg, data) {
      console.warn(`[fs-helper] ${msg}`, data ?? "")
    },
    error(msg, data) {
      console.error(`[fs-helper] ${msg}`, data ?? "")
    },
  }
  const startImpl = opts.startSidecarImpl ?? startSidecar
  const defaultTimeoutMs = opts.defaultRpcTimeoutMs ?? DEFAULT_TIMEOUT_MS

  let handle: SidecarHandle | null = null
  let stderrTail = ""
  let stopped = false
  let history: RestartHistory = { lastRestartAt: null, parked: false }
  let helperMissing = false

  if (!opts.helperPath || !existsSync(opts.helperPath)) {
    helperMissing = true
  }

  function buildArgs(): string[] {
    const args = ["--root", opts.rootPath, "--work-dir", opts.workDir]
    if (opts.tikaEndpoint) args.push("--tika-endpoint", opts.tikaEndpoint)
    if (opts.indexIgnore) args.push("--fs-index-ignore", opts.indexIgnore)
    args.push("--max-snapshot-bytes", String(opts.maxSnapshotBytes))
    args.push("--max-extract-bytes", String(opts.maxExtractBytes))
    args.push("--max-diff-source-bytes", String(opts.maxDiffSourceBytes))
    args.push("--max-diff-output-bytes", String(opts.maxDiffOutputBytes))
    args.push("--max-search-limit", String(opts.maxSearchLimit))
    args.push("--max-history-list-limit", String(opts.maxHistoryListLimit))
    args.push("--max-offset", String(opts.maxOffset))
    args.push("--max-history-bytes", String(opts.maxHistoryBytes))
    args.push("--max-versions-per-path", String(opts.maxVersionsPerPath))
    args.push("--keep-recent-versions", String(opts.keepRecentVersions))
    return args
  }

  function ensureHandle(): SidecarHandle {
    if (stopped) {
      throw new FsHelperUnavailableError("client stopped")
    }
    if (helperMissing) {
      throw new FsHelperUnavailableError("helper binary not found")
    }
    if (history.parked) {
      throw new FsHelperUnavailableError("helper parked after repeated crashes")
    }
    if (handle) return handle
    const h = startImpl({
      binaryPath: opts.helperPath,
      args: buildArgs(),
    })
    handle = h
    if (h.on) {
      h.on("exit", (code) => {
        const wasIntentional = stopped
        handle = null
        if (wasIntentional) return
        const now = Date.now()
        if (
          history.lastRestartAt !== null &&
          now - history.lastRestartAt < PARK_WINDOW_MS
        ) {
          history.parked = true
          logger.error("fs-helper parked: second exit within 60s window", {
            code,
          })
          return
        }
        history.lastRestartAt = now
        logger.warn("fs-helper unexpectedly exited; will restart on next RPC", {
          code,
        })
      })
    }
    // Capture stderr tail for helper_log_tail. Sidecar's child.stderr is
    // piped but otherwise untouched — wire a listener.
    try {
      const stderr = (
        h as unknown as {
          // We can't reach the child easily; use the sidecar's emitter for
          // exits but ignore stderr for now (the helper logs via stderr to
          // its console; future iteration may surface to TS).
          stderr?: NodeJS.ReadableStream
        }
      ).stderr
      if (stderr && typeof stderr.on === "function") {
        stderr.on("data", (chunk: Buffer | string) => {
          const text =
            typeof chunk === "string" ? chunk : chunk.toString("utf8")
          stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES)
        })
      }
    } catch {
      /* swallow — stderr capture is best-effort */
    }
    return h
  }

  function timeoutMs(method: string): number {
    return METHOD_TIMEOUT_OVERRIDES[method] ?? defaultTimeoutMs
  }

  async function request<T>(method: string, params: unknown): Promise<T> {
    const h = ensureHandle()
    const ms = timeoutMs(method)
    let timer: NodeJS.Timeout | null = null
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        timer = setTimeout(() => {
          // Kill the wedged helper; the exit handler triggers restart logic.
          try {
            void h.stop()
          } catch {
            /* swallow */
          }
          handle = null
          reject(new FsHelperTimeoutError(method, ms))
        }, ms)
        h.request(method, params).then(resolve, reject)
      })
      return result as T
    } catch (err) {
      // Translate sidecar's "code: msg" string error into a structured one.
      const m = (err as Error).message?.match(/^(-?\d+):\s*(.+)$/)
      if (m) {
        throw new FsHelperRpcError(method, Number.parseInt(m[1]!, 10), m[2]!)
      }
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    isAvailable(): boolean {
      if (stopped) return false
      if (helperMissing) return false
      if (history.parked) return false
      return true
    },
    async stop() {
      stopped = true
      if (handle) {
        const h = handle
        handle = null
        await h.stop().catch(() => {})
      }
    },
    historyGet: (input) => request("fs.history.get", input),
    historySnapshot: (input) => request("fs.history.snapshot", input),
    historySnapshotDelete: (input) =>
      request("fs.history.snapshot_delete", input),
    historyList: (input) => request("fs.history.list", input),
    historyDiff: (input) => request("fs.history.diff", input),
    historyRestore: (input) => request("fs.history.restore", input),
    indexRebuild: (input) => request("fs.index.rebuild", input),
    indexStatus: (input) => request("fs.index.status", input),
    indexUpsert: (input) => request<void>("fs.index.upsert", input),
    indexRemove: (input) => request<void>("fs.index.remove", input),
    searchContent: (input) => request("fs.search.content", input),
    searchPath: (input) => request("fs.search.path", input),
    extractText: (input) => request("fs.extract.text", input),
    // expose internal for tests
    [Symbol.for("fs-helper-client.stderrTail")]: () => stderrTail,
  } as FsHelperClient
}

export function getHelperStderrTail(client: FsHelperClient): string {
  const fn = (client as unknown as Record<symbol, () => string>)[
    Symbol.for("fs-helper-client.stderrTail")
  ]
  return typeof fn === "function" ? fn() : ""
}
