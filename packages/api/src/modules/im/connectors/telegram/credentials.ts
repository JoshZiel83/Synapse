/**
 * Telegram Bot API credentials extraction + validation.
 *
 * A Telegram bot authenticates with a single BotFather token. Webhook mode
 * additionally requires a `webhookSecretToken` (sent by Telegram in the
 * `X-Telegram-Bot-Api-Secret-Token` header on every inbound POST and
 * compared constant-time — mirrors feishu's "encryptKey required when
 * webhook").
 *
 * Optional `apiRoot` points at a self-hosted local Bot API server; it
 * defaults to the public cloud host. The async `getMe` probe (confirm token,
 * learn bot username) does NOT live here — validators are SYNC; the probe
 * runs in `controller/telegram.ts`.
 */

import { TELEGRAM_API_ROOT } from "./types.js"

export interface TelegramCredentials {
  botToken: string
  /** Required for webhook mode; the inbound secret-token header value. */
  webhookSecretToken?: string
  /** Self-hosted Bot API root; defaults to the public cloud host. */
  apiRoot?: string
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function extractTelegramCredentials(
  credentials: Record<string, unknown> | null | undefined
): { credentials?: TelegramCredentials; errors: string[] } {
  const errors: string[] = []
  const raw = credentials || {}
  const botToken = nonEmpty(raw.botToken)
  const webhookSecretToken = nonEmpty(raw.webhookSecretToken)
  const apiRoot = nonEmpty(raw.apiRoot)

  if (!botToken) errors.push("botToken is required")
  if (errors.length > 0) return { errors }

  const out: TelegramCredentials = { botToken: botToken! }
  if (webhookSecretToken) out.webhookSecretToken = webhookSecretToken
  if (apiRoot) out.apiRoot = apiRoot.replace(/\/+$/, "")
  return { credentials: out, errors: [] }
}

/**
 * Validate credentials against the requested connection mode (SYNC).
 * Telegram supports `long_connection` (getUpdates) + `webhook`; webhook
 * mode REQUIRES a non-empty `webhookSecretToken`.
 */
export function validateTelegramCredentialsForMode(
  credentials: Record<string, unknown> | null | undefined,
  connectionMode: string
): { ok: boolean; errors: string[]; normalized?: TelegramCredentials } {
  if (connectionMode !== "webhook" && connectionMode !== "long_connection") {
    return {
      ok: false,
      errors: [
        `telegram supports webhook | long_connection (got ${connectionMode})`,
      ],
    }
  }
  const { credentials: c, errors } = extractTelegramCredentials(credentials)
  if (errors.length > 0 || !c) return { ok: false, errors }
  if (connectionMode === "webhook" && !c.webhookSecretToken) {
    return {
      ok: false,
      errors: ["webhookSecretToken is required for webhook mode"],
    }
  }
  return { ok: true, errors: [], normalized: c }
}

/**
 * Read access for downstream connector code. Throws on missing creds so
 * callers don't thread Result types through every helper.
 */
export function getTelegramCredentialsOrThrow(account: {
  credentials?: Record<string, unknown>
}): TelegramCredentials {
  const { credentials, errors } = extractTelegramCredentials(
    account.credentials
  )
  if (!credentials) {
    throw new Error(`Telegram credentials invalid: ${errors.join(", ")}`)
  }
  return credentials
}

/** Resolve the effective API root (self-hosted override or public cloud). */
export function resolveApiRoot(creds: TelegramCredentials): string {
  return creds.apiRoot || TELEGRAM_API_ROOT
}
