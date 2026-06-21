/**
 * WhatsApp Cloud webhook-verification (GET hub.challenge) handshake.
 *
 * When you subscribe a callback URL in the Meta App dashboard, Meta issues a
 * one-time
 *   GET …/webhooks/whatsapp/:accountId?hub.mode=subscribe
 *        &hub.verify_token=<your token>&hub.challenge=<nonce>
 * The server must echo `hub.challenge` VERBATIM (status 200) when
 * `hub.verify_token` matches the account's stored `webhookVerifyToken`, else
 * reply 403. The shared GET wire route (`public-controller.ts`) dispatches
 * here and sends `result.body` raw (never wrapped in `{ data }`).
 *
 * This is the `handleWebhookVerification` hook on the connector. Telegram /
 * QQ don't need it (no GET ping); WhatsApp Cloud is the canonical case.
 */

import crypto from "node:crypto"
import type {
  WebhookVerificationInput,
  WebhookVerificationResult,
} from "../types.js"
import { getWhatsappCredentialsOrThrow } from "./credentials.js"

function queryString(value: unknown): string | undefined {
  // Fastify may surface a repeated query param as an array; take the first.
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : undefined
  }
  return typeof value === "string" ? value : undefined
}

/**
 * Length-checked constant-time string compare for the verify-token handshake.
 * Plain `===` short-circuits on the first differing byte; this matches the
 * constant-time standard the rest of this connector uses (the HMAC compare in
 * webhook-signature.ts). Inlined here (not imported from telegram) to keep the
 * WhatsApp connector self-contained. Returns false on length mismatch or when
 * either side is missing/empty.
 */
function constantTimeEqual(
  a: string | undefined,
  b: string | undefined
): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  // crypto.timingSafeEqual throws on unequal lengths, so guard first. The
  // length itself is not secret (a verify-token's length is not an oracle).
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export async function handleWhatsappWebhookVerification(
  input: WebhookVerificationInput
): Promise<WebhookVerificationResult> {
  const creds = (() => {
    try {
      return getWhatsappCredentialsOrThrow(input.account)
    } catch (err) {
      input.logger?.error?.("whatsapp: verification missing credentials", err)
      return null
    }
  })()
  if (!creds) return { statusCode: 403, body: "" }

  const mode = queryString(input.query["hub.mode"])
  const token = queryString(input.query["hub.verify_token"])
  const challenge = queryString(input.query["hub.challenge"])

  const tokenMatched = constantTimeEqual(token, creds.webhookVerifyToken)
  if (mode === "subscribe" && tokenMatched) {
    // Echo the challenge VERBATIM. Meta sends it as a string; return it raw.
    return { statusCode: 200, body: challenge ?? "" }
  }

  input.logger?.warn?.("whatsapp: webhook verification rejected", {
    accountId: input.account.id,
    mode,
    tokenMatched,
  })
  return { statusCode: 403, body: "" }
}
