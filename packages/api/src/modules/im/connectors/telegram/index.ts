/**
 * Telegram Bot API TransportConnector assembly + registry registration.
 *
 * SKELETON: this file is replaced by the full assembly once the connector
 * body lands (long-poll loop, webhook handler, normalize, outbound, media,
 * mentions, typing, reactions). It exists now so `register-all.ts` resolves
 * and the capability-contract test sees a registered `telegram` connector.
 *
 * Importing this module side-effects the global connector registry. Per the
 * `connectors/types.ts` contract it MUST NOT perform any top-level IO.
 */

import { registerConnector } from "../registry.js"
import { NotImplementedError, type TransportConnector } from "../types.js"
import {
  TELEGRAM_CONNECTOR_CAPABILITY,
  TELEGRAM_MESSAGE_CAPABILITIES,
} from "./capabilities.js"

export const telegramConnector: TransportConnector = {
  transportKind: "telegram",
  capability: TELEGRAM_CONNECTOR_CAPABILITY,
  messageCapabilities: TELEGRAM_MESSAGE_CAPABILITIES,

  validateCredentials() {
    return { ok: false, errors: ["telegram connector not yet implemented"] }
  },

  async startAccount() {
    throw new NotImplementedError("telegram.startAccount")
  },

  async sendMessage() {
    throw new NotImplementedError("telegram.sendMessage")
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

registerConnector(telegramConnector)
