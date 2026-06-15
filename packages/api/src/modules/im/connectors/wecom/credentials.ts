/**
 * WeCom (Enterprise WeChat) credentials + config extraction.
 *
 * WeCom 智能机器人 API 模式（长连接）只需要 BotID + Secret 两项凭据。
 * baseWsUrl 是部署级配置，不是凭据 —— 走 transport_accounts.config，
 * 与 credentials 分开存。TransportConnector.validateCredentials 拿不到
 * config，所以 validateWecomCredentialsForMode 只校验 credentials。
 */

import type { TransportAccountSummary } from "@synapse/shared/types"
import { WECOM_BASE_WS_URL_MAX_BYTES } from "@synapse/shared/constants"

export interface WecomCredentials {
  botId: string
  secret: string
}

export interface WecomConfig {
  baseWsUrl?: string
}

export const DEFAULT_WECOM_WS_URL = "wss://openws.work.weixin.qq.com"

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function firstNonEmpty(
  source: Record<string, unknown> | null | undefined,
  keys: readonly string[]
): string | undefined {
  if (!source) return undefined
  for (const key of keys) {
    const value = nonEmpty(source[key])
    if (value) return value
  }
  return undefined
}

export function extractWecomCredentials(
  credentials: Record<string, unknown> | null | undefined
): { credentials?: WecomCredentials; errors: string[] } {
  const errors: string[] = []
  const botId = firstNonEmpty(credentials, ["botId"])
  const secret = firstNonEmpty(credentials, ["secret"])
  if (!botId) errors.push("botId is required")
  if (!secret) errors.push("secret is required")
  if (errors.length > 0) return { errors }
  return { credentials: { botId: botId!, secret: secret! }, errors: [] }
}

const WECOM_BASE_WS_URL_KEYS = ["baseWsUrl"] as const

export function extractWecomConfig(
  config: Record<string, unknown> | null | undefined
): WecomConfig {
  const baseWsUrl = firstNonEmpty(config, WECOM_BASE_WS_URL_KEYS)
  return baseWsUrl ? { baseWsUrl } : {}
}

export function validateWecomCredentialsForMode(
  credentials: Record<string, unknown> | null | undefined,
  connectionMode: string
): { ok: boolean; errors: string[]; normalized?: WecomCredentials } {
  if (connectionMode !== "long_connection") {
    return {
      ok: false,
      errors: [`wecom only supports long_connection (got ${connectionMode})`],
    }
  }
  const { credentials: c, errors } = extractWecomCredentials(credentials)
  if (errors.length > 0 || !c) return { ok: false, errors }
  return { ok: true, errors: [], normalized: c }
}

/**
 * Connector-level config validation. Used by
 * `service/account-credentials.ts:validateAndNormalizeAccountConfig` to
 * close the gap left by the generic `accountSchema.config:
 * z.record(z.string(), z.unknown())` — without this, a POST to the generic
 * `/im/accounts` route could write any `config` blob (including an
 * `http://` `baseWsUrl`) and bypass the per-transport schema
 * refinement in `controller/_shared.ts`.
 *
 * The wecom-specific `controller/wecom.ts` route is still the user-
 * friendly path (it does schema-level validation up front with a clean
 * error), but this hook ensures the same constraints hold no matter
 * which API entry point a caller uses.
 *
 * URL validation uses `new URL()` rather than a bare regex so we catch
 * malformed inputs (e.g. `"wss://"` with no host, `"wss://bad host"`
 * with whitespace) that the SDK's `options.wsUrl` would otherwise see.
 * The per-route Zod schema in `_shared.ts` is `.url()` + a wss?/ refine,
 * which catches the same cases at the schema layer. Without parser
 * parity here, the generic `/im/accounts` route would silently accept
 * malformed URLs the per-route schema rejects.
 */
const WECOM_ALLOWED_WS_PROTOCOLS = new Set(["wss:", "ws:"])

function checkBaseWsUrl(value: string): string | null {
  if (Buffer.byteLength(value, "utf8") > WECOM_BASE_WS_URL_MAX_BYTES) {
    return `wecom config.baseWsUrl exceeds ${WECOM_BASE_WS_URL_MAX_BYTES} bytes`
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return `wecom config.baseWsUrl is not a valid URL: ${value}`
  }
  if (!WECOM_ALLOWED_WS_PROTOCOLS.has(parsed.protocol)) {
    return `wecom config.baseWsUrl must use wss:// (or ws:// for dev), got: ${value}`
  }
  if (!parsed.hostname) {
    return `wecom config.baseWsUrl is missing a host: ${value}`
  }
  return null
}

export function validateWecomConfig(
  config: Record<string, unknown> | null | undefined
): { ok: boolean; errors: string[]; normalized?: WecomConfig } {
  // First: catch "baseWsUrl is PRESENT but not a usable string" before
  // calling extractWecomConfig (which silently drops non-strings via
  // firstNonEmpty). Without this, POST /im/accounts with body
  // `config: { baseWsUrl: 123 }` would return 201 + lose the value
  // silently — the caller thinks it set a custom WSS URL but the row
  // has empty config. `undefined` / `null` / absent keys are treated
  // as "field not provided" (the update controller also maps null to
  // an explicit clear).
  if (config) {
    for (const key of WECOM_BASE_WS_URL_KEYS) {
      const raw = config[key]
      if (raw === undefined || raw === null) continue
      if (typeof raw !== "string") {
        return {
          ok: false,
          errors: [`wecom config.${key} must be a string (got ${typeof raw})`],
        }
      }
      if (raw.trim() === "") {
        return {
          ok: false,
          errors: [`wecom config.${key} must be a non-empty string`],
        }
      }
    }
  }
  const normalized = extractWecomConfig(config)
  if (normalized.baseWsUrl) {
    const err = checkBaseWsUrl(normalized.baseWsUrl)
    if (err) return { ok: false, errors: [err] }
  }
  return { ok: true, errors: [], normalized }
}

export function getWecomCredentialsOrThrow(
  account: TransportAccountSummary
): WecomCredentials {
  const { credentials, errors } = extractWecomCredentials(account.credentials)
  if (!credentials) {
    throw new Error(
      `WeCom account ${account.id} credentials invalid: ${errors.join(", ")}`
    )
  }
  return credentials
}
