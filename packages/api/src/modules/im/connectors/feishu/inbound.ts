/**
 * Feishu inbound: WSClient and webhook delivery paths.
 *
 * `startAccount` decides between WSClient (long_connection) or no-op (webhook,
 * delivered by the public webhook controller via handleWebhook).
 */

import * as Lark from "@larksuiteoapi/node-sdk"
import { nowIsoInstant } from "@synapse/shared/datetime"
import type { TransportAccountSummary } from "@synapse/shared/types"
import type {
  AccountStartContext,
  InboundEnvelope,
  RunningAccount,
  WebhookHandlerInput,
  WebhookHandlerResult,
} from "../types.js"
import {
  createFeishuEventDispatcher,
  createFeishuWsClient,
  getFeishuCredentialsOrThrow,
} from "./client.js"
import {
  normalizeFeishuMessageEvent,
  type FeishuMessageEvent,
} from "./normalize.js"
import { verifyFeishuWebhookSignature } from "./webhook-signature.js"

function envelopeFromEvent(
  account: TransportAccountSummary,
  data: FeishuMessageEvent
): InboundEnvelope | null {
  const normalized = normalizeFeishuMessageEvent(data)
  if (!normalized) return null
  return {
    endpointType: normalized.endpointType,
    endpointExternalId: normalized.endpointExternalId,
    externalMessageId: normalized.externalMessageId,
    externalReplyToId: normalized.externalReplyToId,
    externalThreadId: normalized.externalThreadId,
    sender: { externalId: normalized.senderExternalId },
    receivedAt: nowIsoInstant(),
    message: normalized.message,
    raw: normalized.raw,
  }
}

export async function startFeishuAccount(
  ctx: AccountStartContext
): Promise<RunningAccount> {
  const account = ctx.account
  const mode = account.connectionMode
  // Ensure credentials are parseable
  getFeishuCredentialsOrThrow(account)

  if (mode === "webhook") {
    // Webhook mode: nothing to subscribe; handleWebhook handles incoming.
    ctx.logger.info("feishu: webhook mode — no long connection started")
    return {
      stop: async () => {},
    }
  }

  // long_connection: subscribe via WSClient
  const dispatcher = createFeishuEventDispatcher(account)
  dispatcher.register({
    "im.message.receive_v1": async (data) => {
      try {
        const envelope = envelopeFromEvent(account, data as FeishuMessageEvent)
        if (envelope) {
          await ctx.emitInbound(envelope)
        }
      } catch (err) {
        ctx.logger.error("feishu: inbound dispatch failed", err)
      }
    },
  })

  const ws = createFeishuWsClient(account)
  // start() blocks until the connection closes; do not await
  void ws.start({ eventDispatcher: dispatcher }).catch((err) => {
    ctx.logger.error("feishu: WSClient.start error", err)
  })
  ctx.logger.info("feishu: WSClient started", { accountId: account.id })

  return {
    stop: async () => {
      try {
        await ws.close({ force: true })
      } catch (err) {
        ctx.logger.warn("feishu: WSClient.close error", { err: String(err) })
      }
    },
  }
}

export async function handleFeishuWebhook(
  input: WebhookHandlerInput
): Promise<WebhookHandlerResult> {
  const account = input.account
  const { encryptKey } = getFeishuCredentialsOrThrow(account)
  if (
    !input.body ||
    typeof input.body !== "object" ||
    Array.isArray(input.body)
  ) {
    return { statusCode: 400, body: { error: "invalid body" } }
  }
  const payload = input.body as Record<string, unknown>

  // URL challenge first
  if (typeof payload.challenge === "string") {
    const challenge = await Lark.generateChallenge(payload, {
      encryptKey,
    } as any)
    if ((challenge as any)?.isChallenge) {
      return {
        statusCode: 200,
        body: { challenge: (challenge as any).challenge },
      }
    }
  }

  // Signature
  if (
    !verifyFeishuWebhookSignature({
      headers: input.headers,
      payload,
      encryptKey,
    })
  ) {
    return { statusCode: 401, body: { error: "invalid signature" } }
  }

  const dispatcher = createFeishuEventDispatcher(account)
  dispatcher.register({
    "im.message.receive_v1": async (data) => {
      const envelope = envelopeFromEvent(account, data as FeishuMessageEvent)
      if (envelope) {
        await input.emitInbound(envelope)
      }
    },
  })
  await dispatcher.invoke(payload, { needCheck: false })
  return { statusCode: 200, body: { ok: true } }
}
