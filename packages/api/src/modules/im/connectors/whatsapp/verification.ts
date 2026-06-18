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

  if (mode === "subscribe" && token === creds.webhookVerifyToken) {
    // Echo the challenge VERBATIM. Meta sends it as a string; return it raw.
    return { statusCode: 200, body: challenge ?? "" }
  }

  input.logger?.warn?.("whatsapp: webhook verification rejected", {
    accountId: input.account.id,
    mode,
    tokenMatched: token === creds.webhookVerifyToken,
  })
  return { statusCode: 403, body: "" }
}
