/**
 * Feishu TransportConnector assembly + registry registration.
 *
 * Importing this module side-effects the global connector registry
 * (the connector becomes the new authoritative path; the legacy
 * `connectors/feishu.ts` capability constant export remains during
 * the transition).
 */

import { registerConnector } from "../registry.js"
import type {
  AccountStartContext,
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

// One AccountStartContext per active account so that the webhook handler can
// route the inbound event into the right ingest pipeline. Previously a single
// lastWebhookStartContext got overwritten on every startAccount, which broke
// multi-account and multi-restart workflows.
const webhookContexts = new Map<string, AccountStartContext>()

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
    // Remember the context per-account so the webhook handler can route
    // inbound events back through the right ingest pipeline.
    webhookContexts.set(ctx.account.id, ctx)
    const running = await startFeishuAccount(ctx)
    return {
      stop: async () => {
        webhookContexts.delete(ctx.account.id)
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
    const ctx = webhookContexts.get(input.account.id)
    if (!ctx) {
      return {
        statusCode: 503,
        body: { error: `no active runtime for account ${input.account.id}` },
      }
    }
    return handleFeishuWebhook(ctx, input)
  },
}

registerConnector(feishuConnector)
