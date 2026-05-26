/**
 * QQ official-bot TransportConnector — registers into the IM connector
 * registry on import.
 *
 * Stage 1 wires the contract surface end-to-end:
 *   - capabilities (read by the dashboard + degradation pass)
 *   - credentials validation
 *   - inbound (Stage 2/3 implement webhook + WS)
 *   - outbound (Stage 4/5/8 implement text/media/keyboard)
 *
 * Status / reaction adapters are null (QQ has no message edit, no
 * reaction concept on either C2C or group messages).
 *
 * Typing adapter is null today; Stage 6 returns a per-call
 * `{adapter, config}` after G2 plumbs `lastInboundMessageRef` from
 * actor-status-hooks.
 */

import { registerConnector } from "../registry.js"
import type {
  TransportConnector,
  WebhookHandlerInput,
  WebhookHandlerResult,
} from "../types.js"
import {
  QQ_CONNECTOR_CAPABILITY,
  QQ_MESSAGE_CAPABILITIES,
} from "./capabilities.js"
import { validateQqCredentialsForMode } from "./credentials.js"
import { handleQqWebhook, startQqAccount } from "./inbound.js"
import { parseQqMentions, renderQqMention } from "./mentions.js"
import { sendQqMessage } from "./outbound.js"

export const qqConnector: TransportConnector = {
  transportKind: "qq",
  capability: QQ_CONNECTOR_CAPABILITY,
  messageCapabilities: QQ_MESSAGE_CAPABILITIES,

  validateCredentials(input) {
    const r = validateQqCredentialsForMode(
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
    return startQqAccount(ctx)
  },

  async sendMessage(input) {
    return sendQqMessage(input)
  },

  // QQ has no per-message reaction API on either C2C or groups.
  createStatusReactionAdapter() {
    return null
  },

  // Stage 6 returns `{adapter, config:{heartbeatMs:50_000}}` here when
  // endpointRef.endpointType==='direct' AND lastInboundMessageRef is set.
  createTypingAdapter() {
    return null
  },

  parseInboundMentions(input) {
    return parseQqMentions(input)
  },

  renderOutboundMention(input) {
    return renderQqMention(input)
  },

  async handleWebhook(
    input: WebhookHandlerInput
  ): Promise<WebhookHandlerResult> {
    return handleQqWebhook(input)
  },
}

registerConnector(qqConnector)
