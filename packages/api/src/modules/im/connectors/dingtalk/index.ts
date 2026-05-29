/**
 * DingTalk TransportConnector assembly + registry registration.
 *
 * Importing this module side-effects the global connector registry.
 */

import { registerConnector } from "../registry.js"
import type { TransportConnector } from "../types.js"
import {
  DINGTALK_CONNECTOR_CAPABILITY,
  DINGTALK_MESSAGE_CAPABILITIES,
} from "./capabilities.js"
import { validateDingtalkCredentialsForMode } from "./credentials.js"
import { parseDingtalkMentions, renderDingtalkMention } from "./mentions.js"
import { sendDingtalkMessage } from "./outbound.js"
import { startDingtalkAccount } from "./stream.js"

export const dingtalkConnector: TransportConnector = {
  transportKind: "dingtalk",
  capability: DINGTALK_CONNECTOR_CAPABILITY,
  messageCapabilities: DINGTALK_MESSAGE_CAPABILITIES,

  validateCredentials(input) {
    const r = validateDingtalkCredentialsForMode(
      input.credentials,
      input.connectionMode as "webhook" | "long_connection"
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
    return startDingtalkAccount(ctx)
  },

  async sendMessage(input) {
    return sendDingtalkMessage({
      account: input.account,
      endpoint: input.endpoint,
      message: input.message,
      replyTo: input.replyTo,
    })
  },

  // DingTalk has no public reaction API for v1.
  createStatusReactionAdapter() {
    return null
  },

  // No native typing indicator.
  createTypingAdapter() {
    return null
  },

  parseInboundMentions(input) {
    // The connector contract's `parseInboundMentions` only sees rawText +
    // rawMentions; chatbotUserId (which we use to filter the bot's own
    // entry) isn't available here. normalize.ts calls parseDingtalkMentions
    // directly with the full payload, so this branch is mainly a safety
    // net for direct callers — pass through as best-effort.
    const rawMentions = input.rawMentions as
      | Array<{ dingtalkId?: string; staffId?: string }>
      | undefined
    return parseDingtalkMentions({
      rawText: input.rawText,
      atUsers: rawMentions,
      chatbotUserId: undefined,
    })
  },

  renderOutboundMention(input) {
    return renderDingtalkMention(input)
  },
}

registerConnector(dingtalkConnector)
