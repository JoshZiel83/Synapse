/**
 * WhatsApp Business Cloud API TransportConnector assembly + registry
 * registration.
 *
 * Cloud API is WEBHOOK-only, DIRECT-only (v1; group is template-centric and
 * out of scope — OD-5). Inbound arrives as signed POSTs (handleWebhook);
 * the subscription handshake is the GET hub.challenge echo
 * (handleWebhookVerification). Outbound goes through the 24h-window gate
 * (free-form only inside the window; no template registry in v1 — OD-1a) and
 * returns an "accepted" wamid; the REAL terminal failure arrives async on the
 * status webhook (status-reconcile.ts).
 *
 * Importing this module side-effects the global connector registry; it MUST
 * NOT perform any top-level IO (all Redis/HTTP/file work is lazy, reached
 * only via the closures below at runtime).
 */

import { registerConnector } from "../registry.js"
import type {
  TransportConnector,
  WebhookHandlerInput,
  WebhookHandlerResult,
  WebhookVerificationInput,
  WebhookVerificationResult,
} from "../types.js"
import {
  WHATSAPP_CONNECTOR_CAPABILITY,
  WHATSAPP_MESSAGE_CAPABILITIES,
} from "./capabilities.js"
import { validateWhatsappCredentialsForMode } from "./credentials.js"
import { handleWhatsappWebhook, startWhatsappAccount } from "./inbound.js"
import { sendWhatsappMessage } from "./outbound.js"
import { createWhatsappTypingAdapter } from "./typing.js"
import { handleWhatsappWebhookVerification } from "./verification.js"

export const whatsappConnector: TransportConnector = {
  transportKind: "whatsapp",
  capability: WHATSAPP_CONNECTOR_CAPABILITY,
  messageCapabilities: WHATSAPP_MESSAGE_CAPABILITIES,

  validateCredentials(input) {
    const r = validateWhatsappCredentialsForMode(
      input.credentials,
      input.connectionMode
    )
    return {
      ok: r.ok,
      errors: r.errors,
      normalized: r.normalized
        ? (r.normalized as unknown as Record<string, unknown>)
        : undefined,
    }
  },

  async startAccount(ctx) {
    return startWhatsappAccount(ctx)
  },

  async sendMessage(input) {
    return sendWhatsappMessage(input)
  },

  // Reactions on WhatsApp Cloud are NOT durable-id trackable (there is no
  // reaction_id to clean up on restart) — they flow through sendMessage as
  // type:"reaction" parts (empty emoji removes). So no per-message status /
  // reaction adapter (the controller becomes a no-op).
  createStatusReactionAdapter() {
    return null
  },

  // Cloud typing/read indicator needs the inbound message id; the adapter
  // returns null when lastInboundMessageRef is absent.
  createTypingAdapter(input) {
    return createWhatsappTypingAdapter(input)
  },

  // Cloud API direct chats carry no rich inbound mention structure (1:1);
  // supportsMention is false, so this is a pass-through.
  parseInboundMentions(input) {
    return { text: input.rawText, mentions: [] }
  },

  // self_only direct policy + supportsMention:false → plain "@name".
  renderOutboundMention(input) {
    return `@${input.displayName}`
  },

  async handleWebhook(
    input: WebhookHandlerInput
  ): Promise<WebhookHandlerResult> {
    return handleWhatsappWebhook(input)
  },

  async handleWebhookVerification(
    input: WebhookVerificationInput
  ): Promise<WebhookVerificationResult> {
    return handleWhatsappWebhookVerification(input)
  },
}

registerConnector(whatsappConnector)
