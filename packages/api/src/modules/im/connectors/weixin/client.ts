/**
 * Personal-WeChat (ilinkai) HTTP client primitives.
 */

import crypto from "node:crypto"
import type { TransportAccountSummary } from "@synapse/shared/types"
import {
  DEFAULT_WEIXIN_BASE_URL,
  extractWeixinCredentials,
  type WeixinCredentials,
} from "./credentials.js"

export function getWeixinCredentialsOrThrow(
  account: TransportAccountSummary
): WeixinCredentials {
  const { credentials, errors } = extractWeixinCredentials(
    account.credentials,
    account.config
  )
  if (!credentials) {
    throw new Error(
      `Weixin account ${account.id} credentials invalid: ${errors.join(", ")}`
    )
  }
  return credentials
}

export function buildWeixinHeaders(
  body: string,
  token?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
    "X-WECHAT-UIN": Buffer.from(
      String(crypto.randomBytes(4).readUInt32BE(0)),
      "utf8"
    ).toString("base64"),
  }
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`
  }
  return headers
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

function parseWeixinProviderJsonObjectText(
  text: string,
  endpoint: string
): Record<string, unknown> {
  const trimmed = text.trim()
  if (!trimmed) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error(`Weixin API ${endpoint} returned invalid JSON`)
  }

  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }

  throw new Error(`Weixin API ${endpoint} returned non-object JSON`)
}

export async function postWeixinJson(params: {
  baseUrl: string
  endpoint: string
  body: Record<string, unknown>
  token?: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), params.timeoutMs)
  const externalAbort = params.signal
  const onAbort = () => controller.abort()
  if (externalAbort) externalAbort.addEventListener("abort", onAbort)
  try {
    const body = JSON.stringify(params.body)
    const response = await fetch(
      `${params.baseUrl.replace(/\/+$/, "")}/${params.endpoint.replace(/^\/+/, "")}`,
      {
        method: "POST",
        headers: buildWeixinHeaders(body, params.token),
        body,
        signal: controller.signal,
      }
    )
    const text = await response.text()
    if (!response.ok) {
      throw new Error(
        `Weixin API ${params.endpoint} failed with ${response.status}: ${text}`
      )
    }
    return parseWeixinProviderJsonObjectText(text, params.endpoint)
  } finally {
    clearTimeout(timer)
    if (externalAbort) externalAbort.removeEventListener("abort", onAbort)
  }
}

export const WEIXIN_LONG_POLL_TIMEOUT_MS = 35_000
export { nonEmpty, DEFAULT_WEIXIN_BASE_URL }
