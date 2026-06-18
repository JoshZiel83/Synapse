/**
 * Telegram webhook secret-token verification.
 *
 * Telegram does NOT sign the webhook body. Instead, when you register a
 * webhook with `setWebhook(secret_token=…)`, Telegram echoes that token in
 * the `X-Telegram-Bot-Api-Secret-Token` header on EVERY inbound POST. We
 * compare it constant-time against the stored `webhookSecretToken`
 * (mirrors grammY's `compareSecretToken` — a header compare, NOT a body HMAC).
 */

import crypto from "node:crypto"

const HEADER_NAME = "x-telegram-bot-api-secret-token"

/** Case-insensitive header lookup that unwraps array-valued headers. */
export function extractSecretTokenHeader(
  headers: Record<string, unknown>
): string | undefined {
  const v = headers[HEADER_NAME] ?? headers["X-Telegram-Bot-Api-Secret-Token"]
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined
  return typeof v === "string" ? v : undefined
}

/** Constant-time compare of two strings; false on length mismatch / non-string. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/**
 * Verify the inbound secret-token header against the stored value. Returns
 * false when either side is missing/empty or they don't match.
 */
export function verifyTelegramWebhookSecret(input: {
  headers: Record<string, unknown>
  expected: string | undefined
}): boolean {
  if (!input.expected) return false
  const got = extractSecretTokenHeader(input.headers)
  if (!got) return false
  return timingSafeEqualStr(got, input.expected)
}
