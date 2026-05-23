/**
 * Feishu TransportConnector assembly + registry registration.
 *
 * Importing this module side-effects the global connector registry.
 */

import { registerConnector } from "../registry.js"
import type {
  TransportConnector,
  WebhookHandlerInput,
  WebhookHandlerResult,
} from "../types.js"
import {
  FEISHU_CONNECTOR_CAPABILITY,
  FEISHU_MESSAGE_CAPABILITIES,
} from "./capabilities.js"
import { createFeishuClient } from "./client.js"
import { validateFeishuCredentialsForMode } from "./credentials.js"
import { handleFeishuWebhook, startFeishuAccount } from "./inbound.js"
import { parseFeishuMentions, renderFeishuMention } from "./mentions.js"
import { sendFeishuMessage } from "./outbound.js"
import { createFeishuReactionAdapter } from "./reactions.js"

export const feishuConnector: TransportConnector = {
  transportKind: "feishu",
  capability: FEISHU_CONNECTOR_CAPABILITY,
  messageCapabilities: FEISHU_MESSAGE_CAPABILITIES,

  validateCredentials(input) {
    const r = validateFeishuCredentialsForMode(
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
    const running = await startFeishuAccount(ctx)
    return {
      stop: async () => {
        await running.stop()
      },
    }
  },

  async sendMessage(input) {
    return sendFeishuMessage({
      account: input.account,
      endpoint: input.endpoint,
      message: input.message,
      replyTo: input.replyTo,
    })
  },

  createStatusReactionAdapter(input) {
    try {
      const client = createFeishuClient(input.account)
      return createFeishuReactionAdapter({
        client,
        messageRef: input.messageRef,
        initialReactionIdsByEmoji: input.initialReactionIdsByEmoji,
        onReactionTracked: input.onPersist
          ? ({ reactionIdsByEmoji }) => input.onPersist!({ reactionIdsByEmoji })
          : undefined,
      })
    } catch {
      return null
    }
  },

  createTypingAdapter() {
    return null // Feishu IM has no native typing
  },

  parseInboundMentions(input) {
    return parseFeishuMentions(input)
  },

  renderOutboundMention(input) {
    return renderFeishuMention(input)
  },

  async handleWebhook(
    input: WebhookHandlerInput
  ): Promise<WebhookHandlerResult> {
    return handleFeishuWebhook(input)
  },
}

registerConnector(feishuConnector)
