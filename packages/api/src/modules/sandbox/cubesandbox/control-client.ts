// CubeSandbox control plane (E2B-compatible REST lifecycle).
//
// Talks to CubeAPI over plain HTTP: create / getInfo / kill / setTimeout /
// health. Note the create/list/connect/timeout routes are E2B-compat routes NOT
// present in openapi.yml — their shapes are pinned against the live deployment.

import { fetch } from "undici"

import { createLogger } from "../../../infrastructure/logger/index.js"
import {
  CubeControlError,
  CubeSandboxNotFoundError,
  DEFAULT_CONTROL_BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SANDBOX_DOMAIN,
  type ControlClientConfig,
  type CreateSandboxParams,
  type CreateSandboxResult,
  type HealthStatus,
  type SandboxInfo,
  type SandboxState,
} from "./types.js"

const log = createLogger("sandbox.cubesandbox")

/** A CubeAPI error body: `{ code, message }` (code may be numeric or string). */
interface ApiErrorBody {
  code?: number | string
  message?: string
  detail?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

async function parseErrorBody(text: string): Promise<ApiErrorBody> {
  if (!text) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? (parsed as ApiErrorBody) : {}
  } catch {
    return {}
  }
}

/**
 * REST client for the CubeSandbox control plane. All requests are unauthenticated
 * against the local dev deployment; when `apiKey` is set it is attached as both
 * `X-API-Key` and `Authorization: Bearer`.
 */
export class CubeControlClient {
  private readonly baseUrl: string
  private readonly apiKey?: string
  private readonly requestTimeoutMs: number
  private readonly defaultDomain: string

  constructor(config: ControlClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_CONTROL_BASE_URL).replace(
      /\/+$/,
      ""
    )
    this.apiKey =
      config.apiKey && config.apiKey.trim() ? config.apiKey.trim() : undefined
    this.requestTimeoutMs =
      config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.defaultDomain = config.defaultDomain ?? DEFAULT_SANDBOX_DOMAIN
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra }
    if (this.apiKey) {
      headers["X-API-Key"] = this.apiKey
      headers.Authorization = `Bearer ${this.apiKey}`
    }
    return headers
  }

  private async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; text: string }> {
    const extra =
      body !== undefined ? { "Content-Type": "application/json" } : undefined
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(extra),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    return { status: resp.status, text: await resp.text() }
  }

  private async fail(
    action: string,
    status: number,
    text: string
  ): Promise<never> {
    const body = await parseErrorBody(text)
    const message = body.message || body.detail || text || `HTTP ${status}`
    if (status === 404) {
      throw new CubeSandboxNotFoundError(
        `${action}: ${message}`,
        status,
        body.code
      )
    }
    throw new CubeControlError(`${action}: ${message}`, status, body.code)
  }

  /** POST /sandboxes — create a sandbox and return its connection descriptor. */
  async create(params: CreateSandboxParams): Promise<CreateSandboxResult> {
    const payload: Record<string, unknown> = { templateID: params.templateID }
    if (params.timeoutSeconds !== undefined) {
      payload.timeout = params.timeoutSeconds
    }
    if (params.metadata) {
      payload.metadata = params.metadata
    }
    if (params.envVars) {
      payload.envVars = params.envVars
    }
    if (params.allowPublicTraffic !== undefined) {
      payload.network = { allowPublicTraffic: params.allowPublicTraffic }
    }

    const { status, text } = await this.request("POST", "/sandboxes", payload)
    if (status < 200 || status >= 300) {
      await this.fail("create sandbox failed", status, text)
    }
    const raw: unknown = text ? JSON.parse(text) : {}
    if (!isRecord(raw) || typeof raw.sandboxID !== "string") {
      throw new CubeControlError(
        "create sandbox: malformed response body",
        status
      )
    }
    return {
      sandboxID: raw.sandboxID,
      templateID: asString(raw.templateID) ?? params.templateID,
      clientID: asString(raw.clientID) ?? "",
      domain: asString(raw.domain) ?? this.defaultDomain,
      envdVersion: asString(raw.envdVersion) ?? "",
      envdAccessToken: asString(raw.envdAccessToken),
      trafficAccessToken: asString(raw.trafficAccessToken),
    }
  }

  /**
   * POST /sandboxes/{id}/connect — E2B-compat reconnect to a LIVE sandbox.
   * Returns a create-shaped connection descriptor. A gated deployment MAY re-mint
   * `envd/trafficAccessToken` here (E2B does); the local UNAUTHENTICATED
   * deployment returns the descriptor with NO tokens (live-verified) — so the
   * caller prefers a fresh token when present, else falls back to the persisted
   * decrypted creds (§6.2 / §1.3).
   */
  async connect(sandboxID: string): Promise<CreateSandboxResult> {
    const { status, text } = await this.request(
      "POST",
      `/sandboxes/${sandboxID}/connect`
    )
    if (status < 200 || status >= 300) {
      await this.fail("connect sandbox failed", status, text)
    }
    const raw: unknown = text ? JSON.parse(text) : {}
    if (!isRecord(raw) || typeof raw.sandboxID !== "string") {
      throw new CubeControlError(
        "connect sandbox: malformed response body",
        status
      )
    }
    return {
      sandboxID: raw.sandboxID,
      templateID: asString(raw.templateID) ?? "",
      clientID: asString(raw.clientID) ?? "",
      domain: asString(raw.domain) ?? this.defaultDomain,
      envdVersion: asString(raw.envdVersion) ?? "",
      envdAccessToken: asString(raw.envdAccessToken),
      trafficAccessToken: asString(raw.trafficAccessToken),
    }
  }

  /** GET /sandboxes/{id} — sandbox detail, or `null` when it no longer exists. */
  async getInfo(sandboxID: string): Promise<SandboxInfo | null> {
    const { status, text } = await this.request(
      "GET",
      `/sandboxes/${sandboxID}`
    )
    if (status === 404) {
      return null
    }
    if (status < 200 || status >= 300) {
      await this.fail("get sandbox info failed", status, text)
    }
    const raw: unknown = text ? JSON.parse(text) : {}
    if (!isRecord(raw) || typeof raw.sandboxID !== "string") {
      throw new CubeControlError(
        "get sandbox info: malformed response body",
        status
      )
    }
    const metadata = isRecord(raw.metadata)
      ? (raw.metadata as Record<string, string>)
      : undefined
    return {
      sandboxID: raw.sandboxID,
      templateID: asString(raw.templateID) ?? "",
      clientID: asString(raw.clientID) ?? "",
      state: (asString(raw.state) ?? "running") as SandboxState,
      envdVersion: asString(raw.envdVersion) ?? "",
      domain: asString(raw.domain),
      cpuCount: asNumber(raw.cpuCount),
      memoryMB: asNumber(raw.memoryMB),
      diskSizeMB: asNumber(raw.diskSizeMB),
      metadata,
    }
  }

  /**
   * DELETE /sandboxes/{id} — destroy a sandbox. Idempotent: a 404 (already gone)
   * is treated as success.
   */
  async kill(sandboxID: string): Promise<void> {
    const { status, text } = await this.request(
      "DELETE",
      `/sandboxes/${sandboxID}`
    )
    if (status === 404) {
      log.debug({ sandboxID }, "kill: sandbox already gone (404)")
      return
    }
    if (status < 200 || status >= 300) {
      await this.fail("kill sandbox failed", status, text)
    }
  }

  /**
   * POST /sandboxes/{id}/timeout — set the idle TTL in seconds. `-1` disables
   * the idle timeout entirely (never times out).
   */
  async setTimeout(sandboxID: string, seconds: number): Promise<void> {
    const { status, text } = await this.request(
      "POST",
      `/sandboxes/${sandboxID}/timeout`,
      { timeout: seconds }
    )
    if (status < 200 || status >= 300) {
      await this.fail("set sandbox timeout failed", status, text)
    }
  }

  /** GET /health — CubeAPI liveness + running sandbox count. */
  async health(): Promise<HealthStatus> {
    const { status, text } = await this.request("GET", "/health")
    if (status < 200 || status >= 300) {
      await this.fail("health check failed", status, text)
    }
    const raw: unknown = text ? JSON.parse(text) : {}
    if (!isRecord(raw)) {
      throw new CubeControlError("health: malformed response body", status)
    }
    return {
      status: asString(raw.status) ?? "unknown",
      sandboxes: asNumber(raw.sandboxes) ?? 0,
    }
  }
}
