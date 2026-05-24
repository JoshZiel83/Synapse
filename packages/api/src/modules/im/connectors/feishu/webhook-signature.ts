/**
 * Feishu webhook signature verification.
 *
 * Feishu signs webhook bodies with sha256(timestamp + nonce + encryptKey +
 * JSON.stringify(body)) over the request headers x-lark-request-timestamp,
 * x-lark-request-nonce, x-lark-signature.
 *
 * If encryptKey is empty (some accounts disable signing), validation is
 * skipped (returns true).
 */

import crypto from "node:crypto"

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

function timingSafeEqualString(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8")
  const b = Buffer.from(right, "utf8")
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export interface FeishuSignatureInput {
  headers: Record<string, unknown>
  payload: unknown
  encryptKey?: string
}

export function verifyFeishuWebhookSignature(
  input: FeishuSignatureInput
): boolean {
  const encryptKey = input.encryptKey?.trim()
  if (!encryptKey) {
    // Signing not configured — skip
    return true
  }
  const timestamp = nonEmpty(input.headers["x-lark-request-timestamp"])
  const nonce = nonEmpty(input.headers["x-lark-request-nonce"])
  const signature = nonEmpty(input.headers["x-lark-signature"])
  if (!timestamp || !nonce || !signature) return false

  const expected = crypto
    .createHash("sha256")
    .update(timestamp + nonce + encryptKey + JSON.stringify(input.payload))
    .digest("hex")
  return timingSafeEqualString(expected, signature)
}
