/**
 * DingTalk OpenAPI HTTP client + sessionWebhook sender + access-token cache.
 *
 * Two reply paths share one access_token cache:
 *   1. sessionWebhook (preferred): POST to the per-message webhook URL
 *      that came in with the inbound payload. Body shape:
 *      {msgtype, markdown:{title,text}, at:{atUserIds, isAtAll}}
 *      The sessionWebhook is a temporary self-authenticating URL, so an
 *      access token is NOT a protocol requirement here (the official Python
 *      Stream SDK replies with only Content-Type). We still attach the
 *      `x-acs-dingtalk-access-token` header when a token is readily available
 *      — the dominant production pattern (official Node.js sample, OpenClaw,
 *      LangBot) — but never let acquiring it block this reply path.
 *   2. OpenAPI (fallback): /v1.0/robot/{oToMessages/batchSend |
 *      groupMessages/send}, body shape {robotCode, userIds|openConversationId,
 *      msgKey, msgParam: JSON.stringify(...)}, token in same header.
 *
 * `isDingtalkBusinessSuccess` is explicit-failure-first so an HTTP 200 with
 * `{errcode: 88001, success: true}` is correctly classified as failure
 * (otherwise the response shape lottery could cause webhook errors to be
 * silently swallowed).
 */

import { createHash } from "crypto"
import type { TransportAccountSummary } from "@synapse/shared/types"
import { getDingtalkCredentialsOrThrow } from "./credentials.js"
import {
  readDingtalkProviderResponse,
  type DingtalkProviderResponse,
} from "./response-codec.js"

const ACCESS_TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken"
// Legacy OAPI token endpoint. Needed ONLY by the media-upload path
// (oapi.dingtalk.com/media/upload), which authenticates via a `?access_token=`
// QUERY param rather than the v1.0 `x-acs-dingtalk-access-token` header.
// Minting it via gettoken (rather than reusing the v1.0 token value as the
// query param) is the proven production choice across the official Python SDK
// and OpenClaw references.
const OAPI_ACCESS_TOKEN_URL = "https://oapi.dingtalk.com/gettoken"
const GROUP_MESSAGES_SEND_URL =
  "https://api.dingtalk.com/v1.0/robot/groupMessages/send"
const OTO_MESSAGES_BATCH_SEND_URL =
  "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend"

// Refresh 5 minutes before the published expiry so a token that is just
// about to lapse isn't handed out and causes the very next request to fail.
const TOKEN_REFRESH_LEAD_MS = 5 * 60 * 1000
const DEFAULT_TOKEN_TTL_SECONDS = 7200

interface CachedToken {
  token: string
  /** Absolute ms timestamp at which the token should be refreshed. */
  refreshAfter: number
}

const tokenCache = new Map<string, CachedToken>()
// Separate cache for the legacy OAPI (gettoken) token — a different token
// family from the v1.0 accessToken, used only for /media/upload.
const oapiTokenCache = new Map<string, CachedToken>()

/**
 * Cache key intentionally derived from BOTH clientId and clientSecret so a
 * secret rotation invalidates the cached token (same clientId + different
 * secret => different cache slot). SHA-256 keeps the secret out of any
 * logged map iteration.
 */
function tokenCacheKey(clientId: string, clientSecret: string): string {
  return createHash("sha256")
    .update(`${clientId}:${clientSecret}`)
    .digest("hex")
}

export async function getAccessToken(
  account: TransportAccountSummary
): Promise<string> {
  const { clientId, clientSecret } = getDingtalkCredentialsOrThrow(account)
  const key = tokenCacheKey(clientId, clientSecret)
  const cached = tokenCache.get(key)
  if (cached && Date.now() < cached.refreshAfter) {
    return cached.token
  }
  const resp = await fetch(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new Error(
      `DingTalk getAccessToken HTTP ${resp.status}: ${body.slice(0, 200)}`
    )
  }
  const data = await readDingtalkProviderResponse(resp)
  const accessToken =
    typeof data.accessToken === "string" ? data.accessToken.trim() : ""
  if (!accessToken) {
    throw new Error(
      `DingTalk getAccessToken returned no accessToken: ${JSON.stringify(data)}`
    )
  }
  const ttlSeconds =
    typeof data.expireIn === "number" && data.expireIn > 0
      ? data.expireIn
      : DEFAULT_TOKEN_TTL_SECONDS
  tokenCache.set(key, {
    token: accessToken,
    refreshAfter: Date.now() + ttlSeconds * 1000 - TOKEN_REFRESH_LEAD_MS,
  })
  return accessToken
}

/**
 * Legacy OAPI access token (GET oapi.dingtalk.com/gettoken). Used ONLY as the
 * `?access_token=` query param for /media/upload — the legacy endpoint does
 * not accept the v1.0 `x-acs-dingtalk-access-token` header. Cached separately
 * from the v1.0 token.
 */
export async function getOapiAccessToken(
  account: TransportAccountSummary
): Promise<string> {
  const { clientId, clientSecret } = getDingtalkCredentialsOrThrow(account)
  const key = tokenCacheKey(clientId, clientSecret)
  const cached = oapiTokenCache.get(key)
  if (cached && Date.now() < cached.refreshAfter) {
    return cached.token
  }
  const url = `${OAPI_ACCESS_TOKEN_URL}?appkey=${encodeURIComponent(clientId)}&appsecret=${encodeURIComponent(clientSecret)}`
  const resp = await fetch(url, { method: "GET" })
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new Error(
      `DingTalk gettoken HTTP ${resp.status}: ${body.slice(0, 200)}`
    )
  }
  const data = await readDingtalkProviderResponse(resp)
  if (!isDingtalkBusinessSuccess(data)) {
    throw new Error(`DingTalk gettoken failed: ${JSON.stringify(data)}`)
  }
  const accessToken =
    typeof data.access_token === "string" ? data.access_token.trim() : ""
  if (!accessToken) {
    throw new Error(
      `DingTalk gettoken returned no access_token: ${JSON.stringify(data)}`
    )
  }
  const ttlSeconds =
    typeof data.expires_in === "number" && data.expires_in > 0
      ? data.expires_in
      : DEFAULT_TOKEN_TTL_SECONDS
  oapiTokenCache.set(key, {
    token: accessToken,
    refreshAfter: Date.now() + ttlSeconds * 1000 - TOKEN_REFRESH_LEAD_MS,
  })
  return accessToken
}

/** Test-only: drop both token caches. */
export function _resetDingtalkTokenCache(): void {
  tokenCache.clear()
  oapiTokenCache.clear()
}

// ───────────────────────── Business success ─────────────────────────

/**
 * Normalize a raw `errcode` (which may arrive as a number or a string) to a
 * number, or `undefined` when it is neither a number nor a non-empty string.
 */
function parseErrcodeNum(errcodeRaw: unknown): number | undefined {
  if (typeof errcodeRaw === "number") return errcodeRaw
  if (typeof errcodeRaw === "string" && errcodeRaw.trim() !== "") {
    return Number(errcodeRaw)
  }
  return undefined
}

/**
 * Explicit-failure-first response classifier.
 *
 * Failure signals (any one wins): errcode != 0, success === false,
 * subCode non-empty, or code is set but isn't one of "ok"/"0"/"success".
 *
 * Success signals (any one): errcode === 0, success === true, code === "ok".
 *
 * If no failure AND at least one success signal: success. If no signals
 * at all, fall back to HTTP 2xx (which the caller already vouched for
 * before calling this).
 */
export function isDingtalkBusinessSuccess(resp: unknown): boolean {
  if (!resp || typeof resp !== "object") return true
  const r = resp as Record<string, unknown>

  // Normalize: errcode could be string or number; code is string.
  const errcodeRaw = r.errcode
  const errcodeNum = parseErrcodeNum(errcodeRaw)
  const errcode = Number.isFinite(errcodeNum) ? errcodeNum : undefined

  const codeRaw = r.code
  const code =
    codeRaw == null ? undefined : String(codeRaw).trim().toLowerCase()

  const successRaw = r.success
  const subCodeRaw = r.subCode
  const subCode =
    typeof subCodeRaw === "string" && subCodeRaw.trim() !== ""
      ? subCodeRaw.trim()
      : undefined

  // ─── Failure signals (any one wins) ───
  if (errcode != null && errcode !== 0) return false
  if (successRaw === false) return false
  if (subCode != null) return false
  if (code != null && code !== "ok" && code !== "0" && code !== "success") {
    return false
  }

  // ─── Success signals ───
  if (errcode === 0) return true
  if (successRaw === true) return true
  if (code === "ok" || code === "0" || code === "success") return true

  // No signal — caller already vouched HTTP 2xx, treat as success.
  return true
}

// ───────────────────────── sessionWebhook ─────────────────────────

export interface SessionWebhookBody {
  msgtype: "markdown" | "text"
  markdown?: { title: string; text: string }
  text?: { content: string }
  at?: {
    atUserIds?: string[]
    atMobiles?: string[]
    isAtAll?: boolean
  }
}

export type SessionWebhookResponse = DingtalkProviderResponse

export async function sendViaSessionWebhook(
  webhook: string,
  body: SessionWebhookBody,
  accessToken?: string
): Promise<{ httpOk: boolean; status: number; body: SessionWebhookResponse }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  // The token is optional on this path (the sessionWebhook URL is
  // self-authenticating). Attach it when available — the dominant production
  // pattern — but a missing/failed token must not block the reply.
  if (accessToken) headers["x-acs-dingtalk-access-token"] = accessToken
  const resp = await fetch(webhook, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  const parsed = await readDingtalkProviderResponse(resp)
  return { httpOk: resp.ok, status: resp.status, body: parsed }
}

// ───────────────────────── OpenAPI senders ─────────────────────────

export type OpenApiSendResponse = DingtalkProviderResponse

export async function sendGroupOpenApi(input: {
  openConversationId: string
  msgKey: string
  msgParam: string
  accessToken: string
  robotCode?: string
}): Promise<{ httpOk: boolean; status: number; body: OpenApiSendResponse }> {
  const resp = await fetch(GROUP_MESSAGES_SEND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acs-dingtalk-access-token": input.accessToken,
    },
    body: JSON.stringify({
      openConversationId: input.openConversationId,
      msgKey: input.msgKey,
      msgParam: input.msgParam,
      ...(input.robotCode ? { robotCode: input.robotCode } : {}),
    }),
  })
  const parsed = await readDingtalkProviderResponse(resp)
  return { httpOk: resp.ok, status: resp.status, body: parsed }
}

export async function sendDirectOpenApi(input: {
  userId: string
  msgKey: string
  msgParam: string
  accessToken: string
  robotCode?: string
}): Promise<{ httpOk: boolean; status: number; body: OpenApiSendResponse }> {
  const resp = await fetch(OTO_MESSAGES_BATCH_SEND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acs-dingtalk-access-token": input.accessToken,
    },
    body: JSON.stringify({
      userIds: [input.userId],
      msgKey: input.msgKey,
      msgParam: input.msgParam,
      ...(input.robotCode ? { robotCode: input.robotCode } : {}),
    }),
  })
  const parsed = await readDingtalkProviderResponse(resp)
  return { httpOk: resp.ok, status: resp.status, body: parsed }
}
