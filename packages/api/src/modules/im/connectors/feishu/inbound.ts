/**
 * Feishu inbound: WSClient and webhook delivery paths.
 *
 * `startAccount` decides between WSClient (long_connection) or no-op (webhook,
 * delivered by the public webhook controller via handleWebhook).
 */

import * as Lark from "@larksuiteoapi/node-sdk"
import {
  fromUnixMillis,
  requireEpochMillis,
  serverReceiveInstant,
} from "@synapse/shared/datetime"
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
import { enrichInboundFeishuMedia } from "./inbound-media.js"
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
  // Feishu `im.message.receive_v1` delivers `message.create_time` as a Unix
  // MILLISECONDS string (13 digits, e.g. "1693834424955") — NOT seconds. Thread
  // the genuine event time through via the explicit-ms adapter rather than
  // discarding it for now(); the [2000,2200) plausibility window fails loud (C2)
  // if the contract ever changes, and we only fall back when it is absent.
  const createTime = normalized.raw.createTime
  return {
    endpointType: normalized.endpointType,
    endpointExternalId: normalized.endpointExternalId,
    externalMessageId: normalized.externalMessageId,
    externalReplyToId: normalized.externalReplyToId,
    externalThreadId: normalized.externalThreadId,
    sender: { externalId: normalized.senderExternalId },
    // A PRESENT-but-corrupt create_time fails loud via requireEpochMillis (C2),
    // NOT silently degrading to "now"; only a genuinely absent value defaults.
    receivedAt:
      createTime == null
        ? // datetime-ok: genuine no-event-time default (create_time absent).
          serverReceiveInstant()
        : fromUnixMillis(requireEpochMillis(createTime, "ms")),
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
          const enriched = await enrichInboundFeishuMedia(envelope, {
            account,
            logger: ctx.logger,
          })
          await ctx.emitInbound(enriched)
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

  // URL verification handshake — must run BEFORE signature verification
  // because Feishu's verification ping may carry no signature header, so an
  // unconditional reject-on-missing-signature would 401 the ping.
  //
  // Detect the challenge STRUCTURALLY so both transport modes work:
  //   - plaintext:    { type: "url_verification", challenge, token }
  //   - Encrypt-Key:  { encrypt: "<base64>" }  (decrypts to a url_verification)
  // The old code gated on a top-level string `challenge`, which is absent in
  // Encrypt-Key mode, so encrypted apps could never complete verification.
  const looksLikeChallenge =
    payload.type === "url_verification" ||
    (typeof payload.encrypt === "string" && !!encryptKey)
  if (looksLikeChallenge) {
    const result = (await Lark.generateChallenge(payload, {
      encryptKey,
    } as any)) as { isChallenge?: boolean; challenge?: { challenge: string } }
    if (result?.isChallenge) {
      // `result.challenge` is ALREADY the exact reply body Feishu expects:
      // { challenge: "<value>" }. Returning { challenge: result.challenge }
      // would double-nest it ({ challenge: { challenge: "..." } }) and the
      // verification would fail. Return it verbatim.
      return { statusCode: 200, body: result.challenge }
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
        const enriched = await enrichInboundFeishuMedia(envelope, {
          account,
          logger: input.logger,
        })
        await input.emitInbound(enriched)
      }
    },
  })
  await dispatcher.invoke(payload, { needCheck: false })
  return { statusCode: 200, body: { ok: true } }
}
