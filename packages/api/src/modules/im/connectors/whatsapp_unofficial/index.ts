/**
 * WhatsApp (unofficial / Baileys) TransportConnector assembly + registration.
 *
 * SKELETON: replaced by the full assembly once the connector body lands
 * (QR/pairing login, DB-backed auth-state, connection-controller +
 * DisconnectReason state machine, session-guard kill-switch, inbound
 * messages.upsert, outbound, encrypted media download/upload). Exists now so
 * `register-all.ts` resolves and the capability-contract test sees a
 * registered `whatsapp_unofficial` connector.
 *
 * Importing this module side-effects the global connector registry; it MUST
 * NOT perform any top-level IO (no Baileys socket, no Redis, no timers).
 */

import { registerConnector } from "../registry.js"
import { NotImplementedError, type TransportConnector } from "../types.js"
import {
  WHATSAPP_UNOFFICIAL_CONNECTOR_CAPABILITY,
  WHATSAPP_UNOFFICIAL_MESSAGE_CAPABILITIES,
} from "./capabilities.js"

export const whatsappUnofficialConnector: TransportConnector = {
  transportKind: "whatsapp_unofficial",
  capability: WHATSAPP_UNOFFICIAL_CONNECTOR_CAPABILITY,
  messageCapabilities: WHATSAPP_UNOFFICIAL_MESSAGE_CAPABILITIES,

  validateCredentials() {
    return {
      ok: false,
      errors: ["whatsapp_unofficial connector not yet implemented"],
    }
  },

  async startAccount() {
    throw new NotImplementedError("whatsapp_unofficial.startAccount")
  },

  async sendMessage() {
    throw new NotImplementedError("whatsapp_unofficial.sendMessage")
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

registerConnector(whatsappUnofficialConnector)
