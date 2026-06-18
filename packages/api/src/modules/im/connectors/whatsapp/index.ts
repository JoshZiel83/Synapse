/**
 * WhatsApp Cloud API TransportConnector assembly + registry registration.
 *
 * SKELETON: replaced by the full assembly once the connector body lands
 * (handleWebhook + signature, handleWebhookVerification, normalize,
 * outbound + 24h-window/template gate, media two-step download/upload,
 * status reconciliation). Exists now so `register-all.ts` resolves and the
 * capability-contract test sees a registered `whatsapp` connector.
 *
 * Importing this module side-effects the global connector registry; it MUST
 * NOT perform any top-level IO.
 */

import { registerConnector } from "../registry.js"
import { NotImplementedError, type TransportConnector } from "../types.js"
import {
  WHATSAPP_CONNECTOR_CAPABILITY,
  WHATSAPP_MESSAGE_CAPABILITIES,
} from "./capabilities.js"

export const whatsappConnector: TransportConnector = {
  transportKind: "whatsapp",
  capability: WHATSAPP_CONNECTOR_CAPABILITY,
  messageCapabilities: WHATSAPP_MESSAGE_CAPABILITIES,

  validateCredentials() {
    return { ok: false, errors: ["whatsapp connector not yet implemented"] }
  },

  // Cloud API is webhook-only; the runtime reconcile loop never invokes
  // startAccount for webhook accounts, but the contract requires it.
  async startAccount() {
    throw new NotImplementedError("whatsapp.startAccount")
  },

  async sendMessage() {
    throw new NotImplementedError("whatsapp.sendMessage")
  },

  createStatusReactionAdapter() {
    return null
  },

  createTypingAdapter() {
    return null
  },

  parseInboundMentions(input) {
    return { text: input.rawText, mentions: [] }
  },

  renderOutboundMention(input) {
    return `@${input.displayName}`
  },
}

registerConnector(whatsappConnector)
