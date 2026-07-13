// Shared types + typed errors for the CubeSandbox wire client.
//
// This module is the transport that ships as the `cubesandbox:bare` provider.
// It talks to two planes:
//   - the E2B-compatible control plane (REST lifecycle) — see control-client.ts
//   - the sandbox's envd data plane over CubeProxy (Host-header vhost routing) —
//     see envd-client.ts
//
// All wire response shapes below were pinned against a live CubeSandbox
// (envd 0.5.11, template tpl-529b45c345d9494496c59ff3). Notable envd quirks the
// normalizers here paper over:
//   - entry `type` is `FILE_TYPE_FILE`/`FILE_TYPE_DIRECTORY` on stat/list/mkdir/
//     move, but lowercase `file`/`directory` on the POST /files write response.
//   - entry `size` is a decimal STRING, not a number.

/** Control plane (E2B-compat REST) default base URL for the dev deployment. */
export const DEFAULT_CONTROL_BASE_URL = "http://127.0.0.1:13000"
/** CubeProxy data-plane default base URL (Host-header vhost routing). */
export const DEFAULT_PROXY_BASE_URL = "http://127.0.0.1:11080"
/** Sandbox vhost domain suffix. */
export const DEFAULT_SANDBOX_DOMAIN = "cube.app"
/** envd listens on this port inside every sandbox. */
export const ENVD_PORT = 49983
/** Default envd user; sent as `username=` query + `Authorization: Basic base64("root:")`. */
export const DEFAULT_ENVD_USER = "root"
/** Default per-request timeout for control-plane + unary data-plane calls. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

// ── Control plane ────────────────────────────────────────────────────────────

/** Configuration for {@link CubeControlClient}. */
export interface ControlClientConfig {
  /** Control-plane base URL. Default {@link DEFAULT_CONTROL_BASE_URL}. */
  readonly baseUrl?: string
  /**
   * Optional management-plane API key. When set it is sent as BOTH `X-API-Key`
   * and `Authorization: Bearer <key>`. Unused on the local dev deployment
   * (unauthenticated), present for parity with a hosted CubeAPI.
   */
  readonly apiKey?: string
  /** Per-request timeout in milliseconds. Default {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  readonly requestTimeoutMs?: number
  /**
   * Fallback vhost domain used when the create/info response omits `domain`.
   * Default {@link DEFAULT_SANDBOX_DOMAIN}.
   */
  readonly defaultDomain?: string
}

/** Parameters for {@link CubeControlClient.create} (POST /sandboxes). */
export interface CreateSandboxParams {
  readonly templateID: string
  /** Idle TTL in seconds. Omitted from the wire body when undefined. */
  readonly timeoutSeconds?: number
  readonly metadata?: Record<string, string>
  readonly envVars?: Record<string, string>
  /**
   * When `false`, CubeProxy rejects unauthenticated public traffic to the
   * sandbox and the create response carries a `trafficAccessToken`. Mapped onto
   * the wire body under `network.allowPublicTraffic`.
   */
  readonly allowPublicTraffic?: boolean
}

/** Result of {@link CubeControlClient.create}. */
export interface CreateSandboxResult {
  readonly sandboxID: string
  readonly templateID: string
  readonly clientID: string
  readonly domain: string
  readonly envdVersion: string
  /** Present only when the deployment gates envd RPCs behind a token. */
  readonly envdAccessToken?: string
  /** Present only when `allowPublicTraffic:false`. Persist it — delivered once. */
  readonly trafficAccessToken?: string
}

/** Sandbox lifecycle state (CubeAPI `SandboxState` enum). */
export type SandboxState = "running" | "paused" | "pausing"

/** Result of {@link CubeControlClient.getInfo} (GET /sandboxes/{id}). */
export interface SandboxInfo {
  readonly sandboxID: string
  readonly templateID: string
  readonly clientID: string
  readonly state: SandboxState
  readonly envdVersion: string
  readonly domain?: string
  readonly cpuCount?: number
  readonly memoryMB?: number
  readonly diskSizeMB?: number
  readonly metadata?: Record<string, string>
}

/** Result of {@link CubeControlClient.health} (GET /health). */
export interface HealthStatus {
  readonly status: string
  readonly sandboxes: number
}

// ── Data plane (envd) ────────────────────────────────────────────────────────

/** Configuration for {@link CubeEnvdClient}. */
export interface EnvdClientConfig {
  readonly sandboxID: string
  /** CubeProxy base URL. Default {@link DEFAULT_PROXY_BASE_URL}. */
  readonly proxyBaseUrl?: string
  /** Sandbox vhost domain. Default {@link DEFAULT_SANDBOX_DOMAIN}. */
  readonly domain?: string
  /** envd port for the vhost. Default {@link ENVD_PORT}. */
  readonly envdPort?: number
  /** Default envd user. Default {@link DEFAULT_ENVD_USER}. */
  readonly username?: string
  /**
   * Per-sandbox traffic token (from a `allowPublicTraffic:false` create). Sent
   * as `e2b-traffic-access-token` on every data-plane request, and — when no
   * separate {@link EnvdClientConfig.envdAccessToken} is given — also as
   * `X-Access-Token`.
   */
  readonly trafficAccessToken?: string
  /** envd RPC access token, sent as `X-Access-Token` (takes precedence). */
  readonly envdAccessToken?: string
  /** Connect timeout in milliseconds. Default {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  readonly requestTimeoutMs?: number
}

/** A shell command to run via {@link CubeEnvdClient.exec}. */
export interface ExecRequest {
  /**
   * The command. When {@link ExecRequest.args} is empty this is passed verbatim
   * to `/bin/bash -l -c <cmd>` (so shell syntax like `&&`, `|`, `>` works). When
   * args are present they are shell-quoted and appended, giving argv semantics.
   */
  readonly cmd: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly envs?: Record<string, string>
}

/** Options for {@link CubeEnvdClient.exec}. */
export interface ExecOptions {
  /**
   * Overall wall-clock deadline in milliseconds, applied two ways: as
   * `Connect-Timeout-Ms` (envd-side hard deadline) and as a client-side abort.
   * Default: no timeout.
   */
  readonly timeoutMs?: number
  /**
   * Cap on total captured stdout+stderr bytes. Once exceeded, further output is
   * dropped and {@link ExecResult.truncated} is set — but the stream is still
   * drained so the exit code is captured. Default: unbounded.
   */
  readonly maxOutputBytes?: number
  /** Override the default envd user for this call. */
  readonly user?: string
}

/** Result of {@link CubeEnvdClient.exec}. */
export interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  /** Present and `true` only when output was capped by `maxOutputBytes`. */
  readonly truncated?: boolean
}

/** Normalized filesystem entry kind. */
export type FileType = "file" | "directory" | "symlink" | "unknown"

/** A normalized filesystem entry returned by stat/list/write/makeDir/move. */
export interface FileEntry {
  readonly name: string
  readonly path: string
  readonly type: FileType
  /** Size in bytes (envd reports this as a decimal string; parsed here). */
  readonly size?: number
  /** POSIX mode bits (decimal). */
  readonly mode?: number
  /** Symbolic permission string, e.g. `-rw-r--r--`. */
  readonly permissions?: string
  readonly owner?: string
  readonly group?: string
  /** RFC-3339 modified time. */
  readonly modifiedTime?: string
}

/** Options for {@link CubeEnvdClient.writeFile}. */
export interface WriteFileOptions {
  readonly username?: string
}

/** A byte range for {@link CubeEnvdClient.readFile}; `end` is inclusive. */
export interface ReadRange {
  readonly start: number
  readonly end?: number
}

/** Options for {@link CubeEnvdClient.readFile}. */
export interface ReadFileOptions {
  readonly username?: string
  /** Request a partial read via HTTP `Range`. envd supports byte ranges. */
  readonly range?: ReadRange
}

// ── Typed errors ─────────────────────────────────────────────────────────────

/** Base class for every error thrown by the CubeSandbox client. */
export class CubeSandboxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** A control-plane (CubeAPI REST) request failed with a non-2xx status. */
export class CubeControlError extends CubeSandboxError {
  readonly status: number
  readonly code?: string | number
  constructor(message: string, status: number, code?: string | number) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** A control-plane resource (sandbox/template) was not found (HTTP 404). */
export class CubeSandboxNotFoundError extends CubeControlError {}

/** A data-plane (envd) request failed. */
export class CubeEnvdError extends CubeSandboxError {
  readonly status?: number
  readonly code?: string | number
  constructor(message: string, status?: number, code?: string | number) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** A data-plane path was not found (HTTP 404 / envd `not_found`). */
export class CubeEnvdNotFoundError extends CubeEnvdError {}

/** A Connect-protocol framing/decode error (malformed or oversized frame). */
export class ConnectProtocolError extends CubeSandboxError {}
