/**
 * WeCom (Enterprise WeChat) connector placeholder.
 *
 * Self-registers so that lookups (`getConnector("wecom")`) succeed but every
 * operation throws NotImplementedError. The v2 implementation should target
 * `wss://openws.work.weixin.qq.com` (AI Bot mode) per the design plan.
 *
 * Account creation is prevented at a higher layer by the empty
 * supportedConnectionModes list in WECOM_CONNECTOR_CAPABILITY.
 */

import { registerConnector } from "../registry.js"
import { NotImplementedError, type TransportConnector } from "../types.js"
import {
  WECOM_CONNECTOR_CAPABILITY,
  WECOM_MESSAGE_CAPABILITIES,
} from "./capabilities.js"

export const wecomConnector: TransportConnector = {
  transportKind: "wecom",
  capability: WECOM_CONNECTOR_CAPABILITY,
  messageCapabilities: WECOM_MESSAGE_CAPABILITIES,

  validateCredentials() {
    return {
      ok: false,
      errors: ["WeCom connector is not yet implemented (v2)"],
    }
  },

  async startAccount() {
    throw new NotImplementedError("wecom.startAccount")
  },

  async sendMessage() {
    throw new NotImplementedError("wecom.sendMessage")
  },

  createStatusReactionAdapter() {
    return null
  },

  createTypingAdapter() {
    return null
  },

  parseInboundMentions() {
    return { text: "", mentions: [] }
  },

  renderOutboundMention(input) {
    return `@${input.displayName}`
  },
}

registerConnector(wecomConnector)
