/**
 * QQ open-platform HTTP client — Stage 1 skeleton.
 *
 * Responsibilities:
 *   - access_token cache per-appId with singleflight (concurrent first
 *     hits don't N-fan-out POST /getAppAccessToken)
 *   - thin `qqApiFetch(account, path, init)` that adds the bearer
 *     header, baseUrl prefix, and timeout
 *
 * Out of scope for Stage 1:
 *   - retries with backoff (lives in the connector code that calls this;
 *     QQ has multiple distinct retry budgets that depend on the
 *     operation — passive-reply quota, msg_seq dedupe, etc.)
 *   - message-specific body builders (Stage 4)
 *   - chunked upload (Stage 5)
 *   - WebSocket gateway (Stage 3)
 *
 * The token cache is process-local. Multiple replicas each maintain
 * their own — fine because `getAppAccessToken` should be cached rather
 * than fetched per-request, and we refresh ahead of expiry so each
 * replica issues at most one token per TTL window (~7100s). The official
 * wiki documents no numeric per-app issuance cap (a "~100/min" figure
 * appeared in the openclaw reference but is not in the docs), and a token
 * fetched within ~60s of expiry leaves the previous token valid for that
 * overlap window.
 */

import {
  QQ_API_BASE,
  QQ_DEFAULT_TOKEN_TTL_SECONDS,
  QQ_TOKEN_URL,
} from "./types.js"
import { getQqCredentialsOrThrow, type QqCredentials } from "./credentials.js"
import { readQqProviderJsonObjectResponse } from "./response-codec.js"

interface AccessTokenEntry {
  token: string
  /** Epoch ms at which we should re-fetch. */
  refreshAtMs: number
}

const tokenCache = new Map<string, AccessTokenEntry>()
const tokenInflight = new Map<string, Promise<AccessTokenEntry>>()

const TOKEN_FETCH_TIMEOUT_MS = 10_000
const DEFAULT_API_TIMEOUT_MS = 30_000

interface TokenResponse extends Record<string, unknown> {
  access_token?: unknown
  // On the wire getAppAccessToken returns expires_in as a JSON STRING
  // ("7200") per the official example; the param table nominally types it
  // as number. We keep number|string and coerce defensively below.
  expires_in?: string | number
  code?: unknown
  message?: unknown
  err_code?: unknown
}

/**
 * Fetch (or read cached) bearer token. Cache key is appId so multiple
 * QQ accounts under different appIds don't share state.
 */
export async function getAccessToken(creds: QqCredentials): Promise<string> {
  const key = creds.appId
  const now = Date.now()
  const cached = tokenCache.get(key)
  if (cached && cached.refreshAtMs > now) {
    return cached.token
  }
  const inflight = tokenInflight.get(key)
  if (inflight) {
    const entry = await inflight
    return entry.token
  }
  const promise = fetchAccessToken(creds).finally(() => {
    tokenInflight.delete(key)
  })
  tokenInflight.set(key, promise)
  const entry = await promise
  tokenCache.set(key, entry)
  return entry.token
}

async function fetchAccessToken(
  creds: QqCredentials
): Promise<AccessTokenEntry> {
  const res = await fetch(QQ_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appId: creds.appId,
      clientSecret: creds.clientSecret,
    }),
    signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(
      `QQ getAppAccessToken HTTP ${res.status}: ${await safeText(res)}`
    )
  }
  const json = (await readQqProviderJsonObjectResponse(res)) as TokenResponse
  const accessToken =
    typeof json.access_token === "string" ? json.access_token.trim() : ""
  if (!accessToken) {
    throw new Error(
      `QQ getAppAccessToken returned no token: code=${json.code} message=${json.message}`
    )
  }
  const ttlSeconds = Math.max(60, resolveTtlSeconds(json.expires_in))
  // Refresh 60s before expiry, or 1/3 of TTL whichever is smaller.
  // For 7200s tokens this is 5 minutes' headroom.
  const headroomSec = Math.min(300, Math.floor(ttlSeconds / 3))
  const refreshAtMs = Date.now() + (ttlSeconds - headroomSec) * 1000
  return { token: accessToken, refreshAtMs }
}

function resolveTtlSeconds(expiresIn: string | number | undefined): number {
  switch (typeof expiresIn) {
    case "number":
      return expiresIn
    case "string":
      return Number.parseInt(expiresIn, 10) || QQ_DEFAULT_TOKEN_TTL_SECONDS
    default:
      return QQ_DEFAULT_TOKEN_TTL_SECONDS
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ""
  }
}

/**
 * Generic QQ OpenAPI fetch. Adds bearer header and URL prefix; caller
 * supplies the path (relative or absolute) + JSON body. Returns the
 * raw `Response` so caller code can inspect status / streaming /
 * headers; common error decoding lives in the call sites that need it
 * (Stage 4+).
 */
export async function qqApiFetch(
  account: { credentials?: Record<string, unknown> },
  path: string,
  init: Omit<RequestInit, "headers"> & {
    headers?: Record<string, string>
    timeoutMs?: number
  } = {}
): Promise<Response> {
  const creds = getQqCredentialsOrThrow(account)
  const token = await getAccessToken(creds)
  const url = path.startsWith("http") ? path : `${QQ_API_BASE}${path}`
  const headers: Record<string, string> = {
    Authorization: `QQBot ${token}`,
    // X-Union-Appid is required on every OpenAPI v2 call — both official
    // SDKs (botpy http.py, botgo) send it alongside Authorization.
    "X-Union-Appid": creds.appId,
    "Content-Type": "application/json",
    "User-Agent": "Synapse-IM-QQ/0.1",
    ...(init.headers ?? {}),
  }
  return await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_API_TIMEOUT_MS),
  })
}

/**
 * Test-only: drop cached tokens. Not exported through index.ts; used by
 * unit tests in this directory and the future credential-rotation tests.
 */
export function _resetQqTokenCacheForTests(): void {
  tokenCache.clear()
  tokenInflight.clear()
}
