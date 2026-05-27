/**
 * WeCom (Enterprise WeChat) TransportConnector assembly + registry registration.
 *
 * v1 ships only the smart-bot long-connection API mode
 * (`wss://openws.work.weixin.qq.com`). Webhook callback, group-robot single
 * direction webhook, self-built app `message/send`, and WeChat customer
 * service are deliberately out of scope. See docs/wecom-connector.md.
 *
 * Importing this module side-effects the global connector registry.
 */

import { registerConnector } from "../registry.js"
import type { TransportConnector } from "../types.js"
import {
  WECOM_CONNECTOR_CAPABILITY,
  WECOM_MESSAGE_CAPABILITIES,
} from "./capabilities.js"
import {
  validateWecomConfig,
  validateWecomCredentialsForMode,
} from "./credentials.js"
import { startWecomAccount } from "./inbound.js"
import { parseWecomMentions, renderWecomMention } from "./normalize.js"
import { sendWecomMessage } from "./outbound.js"

export const wecomConnector: TransportConnector = {
  transportKind: "wecom",
  capability: WECOM_CONNECTOR_CAPABILITY,
  messageCapabilities: WECOM_MESSAGE_CAPABILITIES,

  validateCredentials(input) {
    const r = validateWecomCredentialsForMode(
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

  validateConfig(input) {
    const r = validateWecomConfig(input.config)
    return {
      ok: r.ok,
      errors: r.errors,
      normalized: r.normalized
        ? (r.normalized as unknown as Record<string, unknown>)
        : undefined,
    }
  },

  async startAccount(ctx) {
    return startWecomAccount(ctx)
  },

  async sendMessage(input) {
    return sendWecomMessage(input)
  },

  createStatusReactionAdapter() {
    // WeCom AI-Bot has no reaction concept; status feedback is out of v1.
    return null
  },

  createTypingAdapter() {
    // No typing indicator surface in the smart-bot long-connection API.
    return null
  },

  parseInboundMentions(input) {
    return parseWecomMentions(input)
  },

  renderOutboundMention(input) {
    return renderWecomMention(input)
  },

  // No handleWebhook — v1 does not run any HTTP callback mode for WeCom.
}

registerConnector(wecomConnector)
