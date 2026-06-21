/**
 * WhatsApp Cloud webhook signature verification.
 *
 * Meta signs each event POST with
 *   X-Hub-Signature-256: sha256=<hex HMAC-SHA256(rawBody, appSecret)>
 *
 * Verification MUST run over the EXACT raw request bytes
 * (`WebhookHandlerInput.rawBody`), NOT a re-serialized parse — Meta escapes
 * non-ASCII as `\uXXXX` and any whitespace/key-order/encoding difference
 * flips the HMAC. We compare with `crypto.timingSafeEqual` (constant time).
 *
 * Mirrors `qq/webhook-signature.ts` (raw-body verification + header
 * extraction tolerant of casing/arrays), swapping QQ's Ed25519 for the
 * simpler HMAC scheme.
 */

import crypto from "node:crypto"

const SIGNATURE_PREFIX = "sha256="

/**
 * Compute the expected signature header value for a raw body + app secret.
 * Exposed for tests (and symmetry with the QQ signer).
 */
export function computeWhatsappSignature(input: {
  appSecret: string
  rawBody: string
}): string {
  const hex = crypto
    .createHmac("sha256", input.appSecret)
    .update(input.rawBody, "utf8")
    .digest("hex")
  return `${SIGNATURE_PREFIX}${hex}`
}

/**
 * Verify the `X-Hub-Signature-256` header against HMAC-SHA256(rawBody,
 * appSecret). Returns false on any shape mismatch (missing header, wrong
 * prefix, wrong length, non-hex) WITHOUT throwing, and uses a constant-time
 * compare on the hex digests.
 */
export function verifyWhatsappSignature(input: {
  appSecret: string
  rawBody: string
  signatureHeader: string | undefined
}): boolean {
  const header = input.signatureHeader
  if (!header || !header.startsWith(SIGNATURE_PREFIX)) return false

  const expected = computeWhatsappSignature({
    appSecret: input.appSecret,
    rawBody: input.rawBody,
  })

  // Both are "sha256="+64 hex chars; bail if lengths differ so
  // timingSafeEqual doesn't throw on unequal buffers.
  if (header.length !== expected.length) return false

  const a = Buffer.from(header, "utf8")
  const b = Buffer.from(expected, "utf8")
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * Pull `X-Hub-Signature-256` out of a Fastify-style headers record
 * (lowercase or canonical case; arrays for repeated headers).
 */
export function extractWhatsappSignatureHeader(
  headers: Record<string, unknown>
): string | undefined {
  const v = headers["x-hub-signature-256"] ?? headers["X-Hub-Signature-256"]
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined
  return typeof v === "string" ? v : undefined
}
