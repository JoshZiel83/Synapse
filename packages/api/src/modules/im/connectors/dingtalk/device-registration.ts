/**
 * DingTalk Device Flow registration provider (strategy).
 *
 * Only covers the *automated* registration path — manual AppKey/AppSecret
 * entry bypasses this entirely via a dedicated controller route.
 *
 * Two typed error classes drive the controller's HTTP behavior:
 *
 *   - `RegistrationBusinessError` — the provider responded with a
 *     well-formed `errcode != 0` (source disabled, non-public endpoint
 *     closed, etc.). The controller surfaces this as
 *     `providerStartFailed: true` (during start) or `status: "fail"`
 *     (during poll) so the UI can fall back to manual entry. NOT retried.
 *
 *   - `RegistrationTransientError` — network failure, 5xx, timeout.
 *     The controller increments the per-session failure counter and
 *     returns HTTP 502 for the first four; the fifth flips the session
 *     to `fail` so the UI doesn't loop forever.
 *
 * The OpenClaw connector reference (`dingtalk-openclaw-connector/src/
 * device-auth.ts:46`) throws a plain `Error` on errcode != 0 — we
 * deliberately wrap into a typed class because controller-side string
 * matching is too fragile when the provider's error catalog evolves.
 */

import { DINGTALK_DEVICE_FLOW_STATUS } from "@synapse/shared"
import type { DingtalkDeviceFlowStatus } from "@synapse/shared/types"
import { parseDingtalkProviderResponseText } from "./response-codec.js"

export class RegistrationBusinessError extends Error {
  readonly providerErrcode?: number | string
  constructor(message: string, providerErrcode?: number | string) {
    super(message)
    this.name = "RegistrationBusinessError"
    this.providerErrcode = providerErrcode
  }
}

export class RegistrationTransientError extends Error {
  readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "RegistrationTransientError"
    this.cause = cause
  }
}

export interface RegistrationBeginResult {
  deviceCode: string
  userCode?: string
  verificationUri?: string
  verificationUriComplete: string
  expiresInSeconds: number
  intervalSeconds: number
}

export interface RegistrationPollResult {
  status: DingtalkDeviceFlowStatus
  clientId?: string
  clientSecret?: string
  message?: string
}

export interface RegistrationProvider {
  readonly kind: "openclaw"
  init(): Promise<{ nonce: string }>
  begin(input: { nonce: string }): Promise<RegistrationBeginResult>
  poll(input: { deviceCode: string }): Promise<RegistrationPollResult>
}

// ───────────────────────── OpenClaw provider ─────────────────────────

const DEFAULT_BASE_URL = "https://oapi.dingtalk.com"
const DEFAULT_SOURCE = "DING_DWS_CLAW"
const DEFAULT_EXPIRES_IN = 7200
const DEFAULT_INTERVAL = 5

function envBaseUrl(): string {
  const v = process.env.DINGTALK_REGISTRATION_BASE_URL
  return typeof v === "string" && v.trim() ? v.trim() : DEFAULT_BASE_URL
}

function envSource(): string {
  const v = process.env.DINGTALK_REGISTRATION_SOURCE
  return typeof v === "string" && v.trim() ? v.trim() : DEFAULT_SOURCE
}

interface OpenclawApiResponse {
  errcode?: number | string
  errmsg?: string
  [key: string]: unknown
}

async function postOpenclaw<T extends OpenclawApiResponse>(
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<T> {
  let resp: Response
  try {
    resp = await fetchImpl(`${envBaseUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new RegistrationTransientError(
      `dingtalk registration ${path} request failed: ${(err as Error).message}`,
      err
    )
  }
  if (resp.status >= 500) {
    const text = await resp.text().catch(() => "")
    throw new RegistrationTransientError(
      `dingtalk registration ${path} returned HTTP ${resp.status}: ${text.slice(0, 200)}`
    )
  }
  const text = await resp.text().catch(() => "")
  const data = parseDingtalkProviderResponseText(text) as T | null
  if (!data) {
    throw new RegistrationTransientError(
      `dingtalk registration ${path} returned non-JSON body`,
      text
    )
  }
  const errcodeRaw = data.errcode
  const errcodeNum =
    typeof errcodeRaw === "number"
      ? errcodeRaw
      : typeof errcodeRaw === "string" && errcodeRaw.trim() !== ""
        ? Number(errcodeRaw)
        : undefined
  if (errcodeNum != null && errcodeNum !== 0) {
    throw new RegistrationBusinessError(
      `dingtalk registration ${path} errcode=${errcodeRaw}: ${data.errmsg ?? "unknown"}`,
      errcodeRaw
    )
  }
  return data
}

interface OpenclawInitResp extends OpenclawApiResponse {
  nonce?: string
}

interface OpenclawBeginResp extends OpenclawApiResponse {
  device_code?: string
  user_code?: string
  verification_uri?: string
  verification_uri_complete?: string
  expires_in?: number
  interval?: number
}

interface OpenclawPollResp extends OpenclawApiResponse {
  status?: string
  client_id?: string
  client_secret?: string
  fail_reason?: string
}

export interface OpenclawProviderOptions {
  fetch?: typeof fetch
}

export function createOpenclawProvider(
  options: OpenclawProviderOptions = {}
): RegistrationProvider {
  const fetchImpl = options.fetch ?? fetch
  return {
    kind: "openclaw",
    async init() {
      const data = await postOpenclaw<OpenclawInitResp>(
        "/app/registration/init",
        { source: envSource() },
        fetchImpl
      )
      const nonce = typeof data.nonce === "string" ? data.nonce.trim() : ""
      if (!nonce) {
        throw new RegistrationBusinessError(
          "dingtalk registration init returned no nonce"
        )
      }
      return { nonce }
    },
    async begin({ nonce }) {
      const data = await postOpenclaw<OpenclawBeginResp>(
        "/app/registration/begin",
        { nonce },
        fetchImpl
      )
      const deviceCode =
        typeof data.device_code === "string" ? data.device_code.trim() : ""
      const verificationUriComplete =
        typeof data.verification_uri_complete === "string"
          ? data.verification_uri_complete.trim()
          : ""
      if (!deviceCode || !verificationUriComplete) {
        throw new RegistrationBusinessError(
          "dingtalk registration begin missing device_code or verification_uri_complete"
        )
      }
      const expiresInSeconds =
        typeof data.expires_in === "number" && data.expires_in > 0
          ? data.expires_in
          : DEFAULT_EXPIRES_IN
      const intervalSeconds =
        typeof data.interval === "number" && data.interval > 0
          ? data.interval
          : DEFAULT_INTERVAL
      return {
        deviceCode,
        userCode:
          typeof data.user_code === "string" && data.user_code.trim() !== ""
            ? data.user_code.trim()
            : undefined,
        verificationUri:
          typeof data.verification_uri === "string" &&
          data.verification_uri.trim() !== ""
            ? data.verification_uri.trim()
            : undefined,
        verificationUriComplete,
        expiresInSeconds,
        intervalSeconds,
      }
    },
    async poll({ deviceCode }) {
      const data = await postOpenclaw<OpenclawPollResp>(
        "/app/registration/poll",
        { device_code: deviceCode },
        fetchImpl
      )
      const statusRaw =
        typeof data.status === "string" ? data.status.trim().toUpperCase() : ""
      switch (statusRaw) {
        case "WAITING":
          return { status: DINGTALK_DEVICE_FLOW_STATUS.WAITING }
        case "SUCCESS": {
          const clientId =
            typeof data.client_id === "string" ? data.client_id.trim() : ""
          const clientSecret =
            typeof data.client_secret === "string"
              ? data.client_secret.trim()
              : ""
          if (!clientId || !clientSecret) {
            return {
              status: DINGTALK_DEVICE_FLOW_STATUS.FAIL,
              message:
                "provider reported success but did not include credentials",
            }
          }
          return {
            status: DINGTALK_DEVICE_FLOW_STATUS.SUCCESS,
            clientId,
            clientSecret,
          }
        }
        case "FAIL":
          return {
            status: DINGTALK_DEVICE_FLOW_STATUS.FAIL,
            message:
              (typeof data.fail_reason === "string" && data.fail_reason) ||
              "registration provider reported failure",
          }
        case "EXPIRED":
          return { status: DINGTALK_DEVICE_FLOW_STATUS.EXPIRED }
        case "UNKNOWN":
        case "":
        default:
          // UNKNOWN is mapped to fail per plan: don't let an unrecognized
          // status leak into the shared lowercase enum, and surface a
          // clear message to drive the UI to manual fallback.
          return {
            status: DINGTALK_DEVICE_FLOW_STATUS.FAIL,
            message:
              "registration provider returned unknown status; please retry or fall back to manual",
          }
      }
    },
  }
}

export type RegistrationProviderMode = "auto" | "openclaw" | "disabled"

export function resolveProviderMode(): RegistrationProviderMode {
  const v = process.env.DINGTALK_REGISTRATION_PROVIDER
  if (v === "openclaw" || v === "disabled" || v === "auto") return v
  return "auto"
}

export function getActiveProvider(
  options: OpenclawProviderOptions = {}
): RegistrationProvider | null {
  const mode = resolveProviderMode()
  if (mode === "disabled") return null
  // For now `auto` and `openclaw` resolve to the same provider; if a
  // second automated provider is added later, `auto` picks the first
  // that succeeds.
  return createOpenclawProvider(options)
}
