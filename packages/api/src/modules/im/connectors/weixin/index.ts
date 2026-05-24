/**
 * Personal-WeChat (ilinkai) TransportConnector.
 *
 * Side-effect: registers itself in the connector registry on import.
 */

import { registerConnector } from "../registry.js"
import type { TransportConnector } from "../types.js"
import {
  WEIXIN_CONNECTOR_CAPABILITY,
  WEIXIN_MESSAGE_CAPABILITIES,
} from "./capabilities.js"
import { validateWeixinCredentialsForMode } from "./credentials.js"
import { startWeixinAccount } from "./inbound.js"
import { sendWeixinMessage } from "./outbound.js"
import { createWeixinTypingAdapter } from "./typing.js"

export const weixinConnector: TransportConnector = {
  transportKind: "weixin",
  capability: WEIXIN_CONNECTOR_CAPABILITY,
  messageCapabilities: WEIXIN_MESSAGE_CAPABILITIES,

  validateCredentials(input) {
    const r = validateWeixinCredentialsForMode(
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
    return startWeixinAccount(ctx)
  },

  async sendMessage(input) {
    return sendWeixinMessage({
      account: input.account,
      endpoint: input.endpoint,
      message: input.message,
    })
  },

  // Personal WeChat has no reaction API
  createStatusReactionAdapter() {
    return null
  },

  createTypingAdapter(input) {
    try {
      return createWeixinTypingAdapter({
        account: input.account,
        endpointRef: input.endpointRef,
      })
    } catch {
      return null
    }
  },

  parseInboundMentions() {
    // Personal WeChat has no mention semantics
    return { text: "", mentions: [] }
  },

  renderOutboundMention(input) {
    return `@${input.displayName}`
  },
}

registerConnector(weixinConnector)
