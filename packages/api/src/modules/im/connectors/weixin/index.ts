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
  // ilink contextToken lives on the transport_address row, refreshed by
  // every inbound. The worker pre-loads it so this connector never has to
  // call back into the IM service layer.
  requiresRecipientAddressMetadata: true,

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
      recipientAddressMetadata: input.recipientAddressMetadata,
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
