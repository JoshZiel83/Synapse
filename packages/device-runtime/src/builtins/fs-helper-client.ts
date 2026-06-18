// Client wrapper around the synapse-device-fs-helper Rust sidecar.
// Adds per-RPC timeout, restart-on-unexpected-exit (single retry inside 60s
// window then parks), method-specific timeouts, stderr-tail capture for
// helper_log_tail in error _meta.

import { existsSync } from "node:fs"
import { assertIsoInstantString } from "@synapse/shared/datetime"
import type { SidecarHandle } from "../sidecar.js"
import { startSidecar } from "../sidecar.js"
import { createDeviceLogger } from "../logger.js"
import {
  FS_HELPER_PROTO_VERSION,
  FsHelperProtoMismatchError,
  assertFsHelperProto,
} from "./fs-helper-resolve.js"
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
  IndexTaskStatusInput,
  IndexTaskStatusResult,
  IndexUpsertInput,
  IndexRemoveInput,
  SearchContentInput,
  SearchContentResult,
  SearchPathInput,
  SearchPathResult,
  ExtractTextInput,
  ExtractTextResult,
  CasPutInput,
  CasPutResult,
  CasHasInput,
  CasHasResult,
  CasGcInput,
  CasGcResult,
  ManifestMaterializeInput,
  ManifestScanCommitInput,
  ManifestScanCommitResult,
  DirSyncInput,
  DirSyncResult,
  ManifestCleanupInput,
} from "./fs-helper-types.js"

export interface FsHelperClientOptions {
  helperPath: string
  rootPath: string
  workDir: string
  /** Shared content-addressed store dir; enables fs.cas.* / fs.manifest.* */
  casDir?: string
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
  // CAS/manifest ops scan + ingest whole directory trees; a large
  // conversation working set can take a while. Generous ceiling so a real
  // commit/sync of a big tree doesn't get killed mid-ingest.
  "fs.manifest.scan_commit": 120_000,
  "fs.dir.sync": 120_000,
  "fs.manifest.materialize": 120_000,
  "fs.cas.gc": 120_000,
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
  indexTaskStatus(input: IndexTaskStatusInput): Promise<IndexTaskStatusResult>
  indexUpsert(input: IndexUpsertInput): Promise<void>
  indexRemove(input: IndexRemoveInput): Promise<void>

  searchContent(input: SearchContentInput): Promise<SearchContentResult>
  searchPath(input: SearchPathInput): Promise<SearchPathResult>

  extractText(input: ExtractTextInput): Promise<ExtractTextResult>

  // CAS + manifest (Step 1/2). Require the helper to have been started with
  // a --cas-dir; otherwise the helper returns invalid_params.
  casPut(input: CasPutInput): Promise<CasPutResult>
  casHas(input: CasHasInput): Promise<CasHasResult>
  casGc(input: CasGcInput): Promise<CasGcResult>
  manifestMaterialize(input: ManifestMaterializeInput): Promise<void>
  manifestScanCommit(
    input: ManifestScanCommitInput
  ): Promise<ManifestScanCommitResult>
  dirSync(input: DirSyncInput): Promise<DirSyncResult>
  manifestCleanup(input: ManifestCleanupInput): Promise<void>
}

export function createFsHelperClient(
  opts: FsHelperClientOptions
): FsHelperClient {
  // Unified device-runtime logger (structured NDJSON to stderr); see logger.ts.
  const logger = opts.logger ?? createDeviceLogger("fs-helper")
  const startImpl = opts.startSidecarImpl ?? startSidecar
  const defaultTimeoutMs = opts.defaultRpcTimeoutMs ?? DEFAULT_TIMEOUT_MS

  let handle: SidecarHandle | null = null
  let stderrTail = ""
  let stopped = false
  let history: RestartHistory = { lastRestartAt: null, parked: false }
  let helperMissing = false
  // Handles that have completed the fs.hello handshake. A WeakSet (not a bool)
  // so a respawned handle is naturally treated as un-handshaked — the old
  // handle is GC'd, the new one isn't in the set, so request() re-handshakes.
  const handshaked = new WeakSet<SidecarHandle>()
  // Handles deliberately discarded (e.g. failed the handshake). The exit
  // handler checks this so a discard-stop is NOT counted toward the crash-park
  // window — a proto mismatch is not a crash loop, and recovery is
  // rebuild-then-respawn, so each later RPC must get a fresh spawn rather than
  // hitting a parked client.
  const discarded = new WeakSet<SidecarHandle>()

  if (!opts.helperPath || !existsSync(opts.helperPath)) {
    helperMissing = true
  }

  function buildArgs(): string[] {
    const args = ["--root", opts.rootPath, "--work-dir", opts.workDir]
    if (opts.casDir) args.push("--cas-dir", opts.casDir)
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
        // A deliberately discarded handle (handshake failure) must not count
        // toward the crash-park window — recovery is rebuild + respawn.
        const wasIntentional = stopped || discarded.has(h)
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

  /**
   * Tear down a handle we no longer trust (handshake failure / wedge): stop the
   * process and clear `handle` so the next RPC spawns a fresh one. This is what
   * lets a rebuilt binary actually take over — without it a proto-mismatch throw
   * would leave the OLD process alive and every later RPC would reuse it until
   * the whole device-runtime restarted.
   *
   * `skipPark` controls crash-park accounting:
   *   - true  → STALE-BINARY failure (wrong proto_version / pre-handshake
   *     binary). Not a crash loop; recovery is rebuild + respawn, so mark the
   *     handle discarded and the exit handler skips the park window.
   *   - false → TIMEOUT / wedge / generic startup error. This IS crash-loop-
   *     like, so leave it OUT of `discarded` and let the exit handler count it
   *     toward the park window — repeated wedges must still park.
   */
  function discardHandle(h: SidecarHandle, skipPark: boolean): void {
    if (skipPark) discarded.add(h)
    try {
      void h.stop()
    } catch {
      /* swallow */
    }
    if (handle === h) handle = null
  }

  /**
   * Verify a freshly-spawned handle speaks our wire protocol before its first
   * real RPC. Calls h.request("fs.hello") DIRECTLY (not the gated request()
   * below) to avoid recursing through the gate. On ANY failure the handle is
   * torn down so the next RPC spawns a fresh helper, but only a STALE-BINARY
   * failure (proto mismatch / pre-handshake binary) skips crash-park accounting
   * — a timeout/wedge still counts toward the park window so a stuck helper
   * can't be re-spawned forever. Throws FsHelperProtoMismatchError for
   * version/pre-handshake failures. Idempotent per handle via the WeakSet.
   */
  async function ensureHandshake(h: SidecarHandle): Promise<void> {
    if (handshaked.has(h)) return
    const ms = timeoutMs("fs.hello")
    let timer: NodeJS.Timeout | null = null
    try {
      const hello = await new Promise<unknown>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new FsHelperTimeoutError("fs.hello", ms))
        }, ms)
        h.request("fs.hello", {}).then(resolve, reject)
      })
      assertFsHelperProto(hello)
      handshaked.add(h)
    } catch (err) {
      // Classify: a stale-binary handshake failure (wrong proto_version, or a
      // pre-handshake binary answering method_not_found -32601) is NOT a crash
      // loop — recovery is rebuild + respawn, so it must skip the park window.
      // Anything else (fs.hello timeout/wedge, other RPC error, spawn failure)
      // IS crash-loop-like and must count toward park.
      const isProtoMismatch = err instanceof FsHelperProtoMismatchError
      const m = (err as Error).message?.match(/^(-?\d+):\s*(.+)$/)
      const isMethodNotFound = !!m && Number.parseInt(m[1]!, 10) === -32601
      const staleBinary = isProtoMismatch || isMethodNotFound

      discardHandle(h, staleBinary)

      if (isMethodNotFound) {
        throw new FsHelperProtoMismatchError(
          FS_HELPER_PROTO_VERSION,
          undefined,
          undefined
        )
      }
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function request<T>(method: string, params: unknown): Promise<T> {
    const h = ensureHandle()
    await ensureHandshake(h)
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

  // ── Targeted time-field validation at the cross-language boundary ──────────
  // The Rust sidecar emits a single canonical wire instant
  // (`instant::iso_instant_now()` → `YYYY-MM-DDTHH:MM:SS.mmmZ`). A blind
  // `result as T` would let a malformed/legacy stamp flow straight to MCP
  // output. We validate ONLY the known time fields on the few responses that
  // carry them (Option/undefined/null fields pass through untouched). Hot
  // paths with zero time fields (search/CAS/dir-sync/manifest) keep the cheap
  // `return result as T`.
  function validatedHistoryGet(result: HistoryGetResult): HistoryGetResult {
    assertIsoInstantString(result.recorded_at)
    return result
  }
  function validatedHistoryList(result: HistoryListResult): HistoryListResult {
    for (const entry of result.entries) {
      assertIsoInstantString(entry.recorded_at)
    }
    return result
  }
  function validatedIndexStatus(result: IndexStatusResult): IndexStatusResult {
    if (result.last_indexed_at != null) {
      assertIsoInstantString(result.last_indexed_at)
    }
    if (result.rebuild_task) {
      validatedIndexTaskStatus(result.rebuild_task)
    }
    return result
  }
  function validatedIndexTaskStatus(
    result: IndexTaskStatusResult
  ): IndexTaskStatusResult {
    assertIsoInstantString(result.started_at)
    if (result.finished_at != null) {
      assertIsoInstantString(result.finished_at)
    }
    return result
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
    historyGet: async (input) =>
      validatedHistoryGet(await request("fs.history.get", input)),
    historySnapshot: (input) => request("fs.history.snapshot", input),
    historySnapshotDelete: (input) =>
      request("fs.history.snapshot_delete", input),
    historyList: async (input) =>
      validatedHistoryList(await request("fs.history.list", input)),
    historyDiff: (input) => request("fs.history.diff", input),
    historyRestore: (input) => request("fs.history.restore", input),
    indexRebuild: (input) => request("fs.index.rebuild", input),
    indexStatus: async (input) =>
      validatedIndexStatus(await request("fs.index.status", input)),
    indexTaskStatus: async (input) =>
      validatedIndexTaskStatus(await request("fs.index.task_status", input)),
    indexUpsert: (input) => request<void>("fs.index.upsert", input),
    indexRemove: (input) => request<void>("fs.index.remove", input),
    searchContent: (input) => request("fs.search.content", input),
    searchPath: (input) => request("fs.search.path", input),
    extractText: (input) => request("fs.extract.text", input),
    casPut: (input) => request("fs.cas.put", input),
    casHas: (input) => request("fs.cas.has", input),
    casGc: (input) => request("fs.cas.gc", input),
    manifestMaterialize: (input) =>
      request<void>("fs.manifest.materialize", input),
    manifestScanCommit: (input) => request("fs.manifest.scan_commit", input),
    dirSync: (input) => request("fs.dir.sync", input),
    manifestCleanup: (input) => request<void>("fs.manifest.cleanup", input),
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
