// CubeSandbox data plane — envd over CubeProxy with Host-header vhost routing.
//
// Reaching a sandbox's envd means connecting to CubeProxy (e.g. 127.0.0.1:11080)
// while presenting `Host: {envdPort}-{sandboxID}.{domain}` (the proxy port must
// NOT appear in the Host header). fetch forbids setting `Host` directly, so we
// build the request URL FROM the vhost and use an undici dispatcher whose
// `connect` dials the proxy IP:port instead — the URL-derived Host header is
// what CubeProxy routes on. This mirrors the SDK's IPOverrideTransport /
// buildDataDispatcher (`curl --resolve host:port:ip`).
//
// Surfaces: exec (Connect server-stream), byte-file read/write (HTTP /files),
// and unary filesystem RPCs (stat/list/mkdir/move/remove, Connect unary JSON).

import { Buffer } from "node:buffer"

import { Agent, buildConnector, fetch, type Dispatcher } from "undici"

import { createLogger } from "../../../infrastructure/logger/index.js"
import {
  isCompressedFlag,
  isEndStreamFlag,
  encodeJsonEnvelope,
  parseEndStreamError,
  readFrames,
} from "./connect-codec.js"
import {
  CubeEnvdError,
  CubeEnvdNotFoundError,
  DEFAULT_ENVD_USER,
  DEFAULT_PROXY_BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SANDBOX_DOMAIN,
  ENVD_PORT,
  type EnvdClientConfig,
  type ExecOptions,
  type ExecRequest,
  type ExecResult,
  type FileEntry,
  type FileType,
  type ReadFileOptions,
  type WriteFileOptions,
} from "./types.js"

const log = createLogger("sandbox.cubesandbox")

const CONNECT_CONTENT_TYPE = "application/connect+json"
const CONNECT_PROTOCOL_VERSION = "1"

/** POSIX single-quote a shell word so argv elements survive `bash -l -c`. */
function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** Map an envd entry `type` (either `FILE_TYPE_*` or lowercase) to {@link FileType}. */
function normalizeFileType(raw: unknown): FileType {
  const value = typeof raw === "string" ? raw.toUpperCase() : ""
  switch (value) {
    case "FILE_TYPE_FILE":
    case "FILE":
      return "file"
    case "FILE_TYPE_DIRECTORY":
    case "DIRECTORY":
    case "DIR":
      return "directory"
    case "FILE_TYPE_SYMLINK":
    case "SYMLINK":
    case "LINK":
      return "symlink"
    default:
      return "unknown"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Normalize one raw envd entry into a typed {@link FileEntry} (size string→number). */
function normalizeEntry(raw: unknown): FileEntry {
  if (!isRecord(raw)) {
    return { name: "", path: "", type: "unknown" }
  }
  const sizeRaw = raw.size
  let size: number | undefined
  if (typeof sizeRaw === "number" && Number.isFinite(sizeRaw)) {
    size = sizeRaw
  } else if (typeof sizeRaw === "string" && sizeRaw.trim() !== "") {
    const parsed = Number(sizeRaw)
    size = Number.isFinite(parsed) ? parsed : undefined
  }
  const entry: FileEntry = {
    name: typeof raw.name === "string" ? raw.name : "",
    path: typeof raw.path === "string" ? raw.path : "",
    type: normalizeFileType(raw.type),
    ...(size !== undefined ? { size } : {}),
    ...(typeof raw.mode === "number" ? { mode: raw.mode } : {}),
    ...(typeof raw.permissions === "string"
      ? { permissions: raw.permissions }
      : {}),
    ...(typeof raw.owner === "string" ? { owner: raw.owner } : {}),
    ...(typeof raw.group === "string" ? { group: raw.group } : {}),
    ...(typeof raw.modifiedTime === "string"
      ? { modifiedTime: raw.modifiedTime }
      : {}),
  }
  return entry
}

/** Extract a process exit code from an envd `event.end`. */
function exitCodeFromStatus(status: unknown): number | null {
  if (typeof status !== "string") {
    return null
  }
  const exitMatch = status.match(/(?:exit status|exited with code)\s+(-?\d+)/)
  if (exitMatch) {
    return Number.parseInt(exitMatch[1], 10)
  }
  const signalMatch = status.match(/(?:signal|terminated by signal)\s+(\d+)/)
  if (signalMatch) {
    return 128 + Number.parseInt(signalMatch[1], 10)
  }
  if (status === "exited") {
    return 0
  }
  return null
}

/**
 * Resolve the exit code from an `event.end`. CRITICAL: envd omits `exitCode`
 * from the JSON when it is 0 (proto3 default-omission), so a successful command
 * has NO `exitCode` field — fall back to `status` ("exit status 0") then the
 * `exited` flag. Conversely a normal non-zero exit ALSO sets `error` (e.g.
 * "exit status 127"), so `exitCode`/`status` must be consulted BEFORE `error`.
 */
function extractExitCode(end: Record<string, unknown>): number | null {
  if (typeof end.exitCode === "number") {
    return end.exitCode
  }
  if (typeof end.exit_code === "number") {
    return end.exit_code
  }
  const fromStatus = exitCodeFromStatus(end.status)
  if (fromStatus !== null) {
    return fromStatus
  }
  if (end.exited === true) {
    return 0
  }
  return null
}

async function readErrorBody(
  resp: Awaited<ReturnType<typeof fetch>>
): Promise<{ code?: string | number; message: string }> {
  const text = await resp.text().catch(() => "")
  if (!text) {
    return { message: `HTTP ${resp.status}` }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (isRecord(parsed)) {
      const code = parsed.code
      const message =
        (typeof parsed.message === "string" && parsed.message) ||
        (typeof parsed.detail === "string" && parsed.detail) ||
        text
      return {
        code:
          typeof code === "string" || typeof code === "number"
            ? code
            : undefined,
        message,
      }
    }
  } catch {
    // not JSON — fall through to raw text
  }
  return { message: text }
}

/**
 * Data-plane client for one sandbox's envd, routed through CubeProxy. Build one
 * per sandbox; call {@link CubeEnvdClient.close} to release the pooled
 * dispatcher when done.
 */
export class CubeEnvdClient {
  private readonly sandboxID: string
  private readonly envdPort: number
  private readonly domain: string
  private readonly username: string
  private readonly requestTimeoutMs: number
  private readonly baseVhostUrl: string
  private readonly dispatcher: Dispatcher
  private readonly tokenHeaders: Record<string, string>

  constructor(config: EnvdClientConfig) {
    this.sandboxID = config.sandboxID
    this.envdPort = config.envdPort ?? ENVD_PORT
    this.domain = config.domain ?? DEFAULT_SANDBOX_DOMAIN
    this.username = config.username ?? DEFAULT_ENVD_USER
    this.requestTimeoutMs =
      config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

    const proxy = new URL(config.proxyBaseUrl ?? DEFAULT_PROXY_BASE_URL)
    const scheme = proxy.protocol.replace(/:$/, "")
    const proxyHost = proxy.hostname
    let proxyPort: number
    if (proxy.port) {
      proxyPort = Number(proxy.port)
    } else {
      proxyPort = proxy.protocol === "https:" ? 443 : 80
    }

    // Request URL is built from the vhost (so the Host header is the vhost with
    // no proxy port); the dispatcher redials the proxy IP:port underneath.
    this.baseVhostUrl = `${scheme}://${this.envdPort}-${this.sandboxID}.${this.domain}`
    this.dispatcher = buildProxyDispatcher(
      proxyHost,
      proxyPort,
      this.requestTimeoutMs
    )

    const headers: Record<string, string> = {}
    if (config.trafficAccessToken) {
      headers["e2b-traffic-access-token"] = config.trafficAccessToken
    }
    const accessToken = config.envdAccessToken ?? config.trafficAccessToken
    if (accessToken) {
      headers["X-Access-Token"] = accessToken
    }
    this.tokenHeaders = headers
  }

  /** Release the pooled data-plane dispatcher, awaiting in-flight requests. */
  async close(): Promise<void> {
    log.debug(
      { sandboxID: this.sandboxID },
      "closing envd data-plane dispatcher"
    )
    await this.dispatcher.close().catch(() => undefined)
  }

  /**
   * FORCE-close the pooled dispatcher, ABORTING any in-flight request
   * (undici `Agent.destroy()`). The bounded teardown path (the plane's dispose)
   * calls this when the graceful {@link CubeEnvdClient.close} has not settled within
   * its grace window, so a request hung near its per-request timeout cannot stall
   * teardown past the drain budget.
   */
  async destroy(): Promise<void> {
    log.debug(
      { sandboxID: this.sandboxID },
      "destroying envd data-plane dispatcher (force-close in-flight)"
    )
    await this.dispatcher.destroy().catch(() => undefined)
  }

  private url(path: string): string {
    return `${this.baseVhostUrl}${path}`
  }

  private authHeaders(user: string): Record<string, string> {
    return {
      ...this.tokenHeaders,
      Authorization: `Basic ${Buffer.from(`${user}:`).toString("base64")}`,
    }
  }

  /**
   * Run a shell command via `POST /process.Process/Start` (Connect server-stream).
   * Streams the frames, base64-decodes stdout/stderr, and resolves the exit code.
   */
  async exec(
    request: ExecRequest,
    options: ExecOptions = {}
  ): Promise<ExecResult> {
    const user = options.user ?? this.username
    const args = request.args ?? []
    const command =
      args.length > 0
        ? [request.cmd, ...args].map(shellQuote).join(" ")
        : request.cmd

    const process: Record<string, unknown> = {
      cmd: "/bin/bash",
      args: ["-l", "-c", command],
      envs: request.envs ?? {},
    }
    if (request.cwd) {
      process.cwd = request.cwd
    }

    const headers: Record<string, string> = {
      ...this.authHeaders(user),
      "Content-Type": CONNECT_CONTENT_TYPE,
      "Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
      "Connect-Content-Encoding": "identity",
    }
    if (options.timeoutMs !== undefined) {
      headers["Connect-Timeout-Ms"] = String(Math.trunc(options.timeoutMs))
    }

    const resp = await fetch(this.url("/process.Process/Start"), {
      method: "POST",
      headers,
      body: encodeJsonEnvelope({ process, stdin: false }),
      dispatcher: this.dispatcher,
      signal:
        options.timeoutMs !== undefined
          ? AbortSignal.timeout(options.timeoutMs)
          : undefined,
    })

    if (resp.status >= 400) {
      const { message } = await readErrorBody(resp)
      throw new CubeEnvdError(
        `exec failed: HTTP ${resp.status}: ${message}`,
        resp.status
      )
    }
    if (!resp.body) {
      throw new CubeEnvdError("exec failed: empty response stream")
    }

    return this.collectProcessStream(
      resp.body as ReadableStream<Uint8Array>,
      options.maxOutputBytes
    )
  }

  private async collectProcessStream(
    body: ReadableStream<Uint8Array>,
    maxOutputBytes: number | undefined
  ): Promise<ExecResult> {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let captured = 0
    let truncated = false
    let exitCode: number | null = null

    const capture = (into: Buffer[], chunk: Buffer): void => {
      if (maxOutputBytes === undefined) {
        into.push(chunk)
        return
      }
      if (captured >= maxOutputBytes) {
        truncated = true
        return
      }
      const room = maxOutputBytes - captured
      if (chunk.length <= room) {
        into.push(chunk)
        captured += chunk.length
      } else {
        into.push(chunk.subarray(0, room))
        captured += room
        truncated = true
      }
    }

    for await (const { flags, payload } of readFrames(body)) {
      if (isCompressedFlag(flags)) {
        throw new CubeEnvdError("unsupported compressed Connect stream frame")
      }
      if (isEndStreamFlag(flags)) {
        const err = parseEndStreamError(payload)
        if (err) {
          throw new CubeEnvdError(
            err.code ? `${err.code}: ${err.message}` : err.message
          )
        }
        break
      }

      const parsed: unknown = JSON.parse(payload.toString("utf-8"))
      const event =
        isRecord(parsed) && isRecord(parsed.event) ? parsed.event : undefined
      if (!event) {
        continue
      }
      if (isRecord(event.data)) {
        const { stdout: out, stderr: errOut } = event.data
        if (typeof out === "string" && out) {
          capture(stdout, Buffer.from(out, "base64"))
        }
        if (typeof errOut === "string" && errOut) {
          capture(stderr, Buffer.from(errOut, "base64"))
        }
      }
      if (isRecord(event.end)) {
        const code = extractExitCode(event.end)
        if (code !== null) {
          exitCode = code
        } else if (typeof event.end.error === "string" && event.end.error) {
          throw new CubeEnvdError(`process failed: ${event.end.error}`)
        } else {
          throw new CubeEnvdError("process end event missing exit code")
        }
      }
    }

    if (exitCode === null) {
      throw new CubeEnvdError("process stream ended without an end event")
    }
    if (truncated) {
      log.debug(
        { sandboxID: this.sandboxID, maxOutputBytes },
        "exec output truncated"
      )
    }
    const result: ExecResult = {
      exitCode,
      stdout: Buffer.concat(stdout).toString("utf-8"),
      stderr: Buffer.concat(stderr).toString("utf-8"),
    }
    return truncated ? { ...result, truncated: true } : result
  }

  /**
   * Write raw bytes to `path` via `POST /files` (octet-stream). envd creates any
   * missing parent directories and truncates an existing file. Returns the
   * entry array envd reports for the write.
   */
  async writeFile(
    path: string,
    bytes: Uint8Array,
    options: WriteFileOptions = {}
  ): Promise<FileEntry[]> {
    const user = options.username ?? this.username
    const params = new URLSearchParams({ path, username: user })
    const resp = await fetch(this.url(`/files?${params.toString()}`), {
      method: "POST",
      headers: {
        ...this.authHeaders(user),
        "Content-Type": "application/octet-stream",
      },
      body: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
      dispatcher: this.dispatcher,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    if (resp.status >= 400) {
      const { code, message } = await readErrorBody(resp)
      throw new CubeEnvdError(
        `write ${path} failed: ${message}`,
        resp.status,
        code
      )
    }
    const text = await resp.text()
    const parsed: unknown = text ? JSON.parse(text) : []
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.map(normalizeEntry)
  }

  /**
   * Read a whole file (or a byte range) via `GET /files`. envd supports HTTP
   * `Range` (206 Partial Content); pass `options.range` for a partial read.
   */
  async readFile(path: string, options: ReadFileOptions = {}): Promise<Buffer> {
    const user = options.username ?? this.username
    const params = new URLSearchParams({ path, username: user })
    const headers = this.authHeaders(user)
    if (options.range) {
      const { start, end } = options.range
      headers.Range = `bytes=${start}-${end !== undefined ? end : ""}`
    }
    const resp = await fetch(this.url(`/files?${params.toString()}`), {
      method: "GET",
      headers,
      dispatcher: this.dispatcher,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    if (resp.status === 404) {
      const { code, message } = await readErrorBody(resp)
      throw new CubeEnvdNotFoundError(
        `read ${path} failed: ${message}`,
        404,
        code
      )
    }
    if (resp.status !== 200 && resp.status !== 206) {
      const { code, message } = await readErrorBody(resp)
      throw new CubeEnvdError(
        `read ${path} failed: ${message}`,
        resp.status,
        code
      )
    }
    return Buffer.from(await resp.arrayBuffer())
  }

  /** Stat a path (`filesystem.Filesystem/Stat`). Throws {@link CubeEnvdNotFoundError} if absent. */
  async stat(path: string): Promise<FileEntry> {
    const result = await this.filesystemRpc("Stat", { path })
    return normalizeEntry(result.entry)
  }

  /** List a directory's entries (`filesystem.Filesystem/ListDir`). */
  async listDir(path: string): Promise<FileEntry[]> {
    const result = await this.filesystemRpc("ListDir", { path })
    const entries = result.entries
    return Array.isArray(entries) ? entries.map(normalizeEntry) : []
  }

  /**
   * Create a directory (`filesystem.Filesystem/MakeDir`). Creates missing parents
   * (recursive); a pre-existing directory is an `already_exists` error (HTTP 409).
   */
  async makeDir(path: string): Promise<FileEntry> {
    const result = await this.filesystemRpc("MakeDir", { path })
    return normalizeEntry(result.entry)
  }

  /**
   * Move/rename (`filesystem.Filesystem/Move`). Works across directories and
   * silently overwrites an existing destination.
   */
  async move(source: string, destination: string): Promise<FileEntry> {
    const result = await this.filesystemRpc("Move", { source, destination })
    return normalizeEntry(result.entry)
  }

  /** Remove a file or directory (`filesystem.Filesystem/Remove`). Idempotent (no error if absent). */
  async remove(path: string): Promise<void> {
    await this.filesystemRpc("Remove", { path })
  }

  private async filesystemRpc(
    method: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const resp = await fetch(this.url(`/filesystem.Filesystem/${method}`), {
      method: "POST",
      headers: {
        ...this.authHeaders(this.username),
        "Content-Type": "application/json",
        "Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
      },
      body: JSON.stringify(payload),
      dispatcher: this.dispatcher,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })

    const text = await resp.text()
    if (resp.status >= 400) {
      let code: string | number | undefined
      let message = text || `HTTP ${resp.status}`
      try {
        const body: unknown = text ? JSON.parse(text) : {}
        if (isRecord(body)) {
          if (typeof body.code === "string" || typeof body.code === "number") {
            code = body.code
          }
          if (typeof body.message === "string" && body.message) {
            message = body.message
          } else if (typeof body.detail === "string" && body.detail) {
            message = body.detail
          }
        }
      } catch {
        // raw text
      }
      const detail = code !== undefined ? `${code}: ${message}` : message
      if (resp.status === 404 || code === "not_found") {
        throw new CubeEnvdNotFoundError(
          `filesystem ${method} failed: ${detail}`,
          resp.status,
          code
        )
      }
      throw new CubeEnvdError(
        `filesystem ${method} failed: ${detail}`,
        resp.status,
        code
      )
    }

    if (!text) {
      return {}
    }
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : {}
  }
}

/**
 * Build an undici dispatcher whose every TCP connection is redialed to
 * `proxyHost:proxyPort`, while the request URL's vhost is preserved for the Host
 * header (and TLS SNI). The Node equivalent of `curl --resolve host:port:ip`.
 */
function buildProxyDispatcher(
  proxyHost: string,
  proxyPort: number,
  connectTimeoutMs: number
): Dispatcher {
  const baseConnect = buildConnector({ timeout: connectTimeoutMs })
  return new Agent({
    connect(opts, callback) {
      const servername =
        (opts as { servername?: string }).servername ??
        (typeof opts.hostname === "string" ? opts.hostname : undefined)
      baseConnect(
        { ...opts, hostname: proxyHost, port: String(proxyPort), servername },
        callback
      )
    },
  })
}
