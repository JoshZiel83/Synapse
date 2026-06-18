/**
 * Telegram Bot API TransportConnector assembly + registry registration.
 *
 * Registers into the global connector registry on import. Per the
 * `connectors/types.ts` contract this file does ONLY construct the connector
 * object (pure data + closures over imported helpers) and call
 * `registerConnector` — NO top-level IO (no Redis, timers, network, fetch).
 * All side effects live inside `startAccount` / `handleWebhook` / the lazy
 * helpers those call.
 */

import { registerConnector } from "../registry.js"
import type { TransportConnector } from "../types.js"
import {
  TELEGRAM_CONNECTOR_CAPABILITY,
  TELEGRAM_MESSAGE_CAPABILITIES,
} from "./capabilities.js"
import { validateTelegramCredentialsForMode } from "./credentials.js"
import { handleTelegramWebhook, startTelegramAccount } from "./inbound.js"
import { parseTelegramMentions, renderTelegramMention } from "./mentions.js"
import { sendTelegramMessage } from "./outbound.js"
import { createTelegramReactionAdapter } from "./reactions.js"
import { createTelegramTypingAdapter } from "./typing.js"

export const telegramConnector: TransportConnector = {
  transportKind: "telegram",
  capability: TELEGRAM_CONNECTOR_CAPABILITY,
  messageCapabilities: TELEGRAM_MESSAGE_CAPABILITIES,

  validateCredentials(input) {
    const r = validateTelegramCredentialsForMode(
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
    return startTelegramAccount(ctx)
  },

  async sendMessage(input) {
    return sendTelegramMessage(input)
  },

  createStatusReactionAdapter(input) {
    return createTelegramReactionAdapter({
      account: input.account,
      messageRef: input.messageRef,
    })
  },

  createTypingAdapter(input) {
    return createTelegramTypingAdapter({
      account: input.account,
      endpointRef: input.endpointRef,
      lastInboundMessageRef: input.lastInboundMessageRef,
    })
  },

  parseInboundMentions(input) {
    return parseTelegramMentions(input)
  },

  renderOutboundMention(input) {
    return renderTelegramMention(input)
  },

  async handleWebhook(input) {
    return handleTelegramWebhook(input)
  },
}

registerConnector(telegramConnector)
