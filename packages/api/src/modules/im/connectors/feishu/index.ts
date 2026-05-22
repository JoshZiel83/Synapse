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

let lastWebhookStartContext: AccountStartContext | null = null

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
    if (ctx.account.connectionMode === "webhook") {
      // Remember context so webhook handler can emit inbound back into it
      lastWebhookStartContext = ctx
    }
    return startFeishuAccount(ctx)
  },

  async sendMessage(input) {
    return sendFeishuMessage({
      account: input.account,
      endpoint: input.endpoint,
      message: input.message,
    })
  },

  createStatusReactionAdapter(input) {
    try {
      const client = createFeishuClient(input.account)
      return createFeishuReactionAdapter({
        client,
        messageRef: input.messageRef,
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
    if (!lastWebhookStartContext) {
      return { statusCode: 503, body: { error: "no active webhook context" } }
    }
    return handleFeishuWebhook(lastWebhookStartContext, input)
  },
}

registerConnector(feishuConnector)
