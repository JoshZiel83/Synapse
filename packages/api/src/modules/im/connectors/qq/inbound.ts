/**
 * QQ inbound — webhook entry + (in Stage 3) WebSocket-gateway entry.
 *
 * Webhook flow:
 *   - op=13 → URL verification challenge; sign event_ts + plain_token
 *     and respond with {plain_token, signature(hex)}.
 *   - op=0  → business event; verify Ed25519 signature over the raw
 *     body bytes, then route by `t` (C2C_MESSAGE_CREATE,
 *     GROUP_AT_MESSAGE_CREATE). ACK with {op:12, d:0} on success and
 *     {op:12, d:1} on failure — d:1 makes the platform redeliver the
 *     event (botgo GenDispatchACK).
 *   - op=1 (heartbeat) ALSO flows over the webhook in HTTP-callback mode
 *     and must be answered with a heartbeat-ACK {op:11, d:<seq>}.
 *   - Anything else (op=2/6/7/9/10) → 200 + ignore (shouldn't reach
 *     webhook paths; QQ delivers those over WS).
 *
 * OQ2 (resolved): webhook delivery of C2C / GROUP_AT events is standard
 * and verified, so signature-verified op=0 events dispatch by default.
 * The `webhookInboundConfirmed` flag (default true) is now an operator
 * KILL-SWITCH: set it false to ack-only without dispatching for a given
 * account (op=13 URL verification still works either way).
 */

import { redis } from "../../../../infrastructure/redis/index.js"
import { createLogger } from "../../../../infrastructure/logger/index.js"
import type {
  AccountStartContext,
  RunningAccount,
  WebhookHandlerInput,
  WebhookHandlerResult,
} from "../types.js"
import { getQqCredentialsOrThrow, getEd25519Seed } from "./credentials.js"
import { runQqGateway } from "./inbound-ws.js"
import { writeLatestInboundAnchor } from "./latest-inbound-store.js"
import {
  normalizeQqC2cMessage,
  normalizeQqGroupAtMessage,
  type QqC2cMessageEventData,
  type QqGroupAtMessageEventData,
} from "./normalize.js"
import { readQqAccountConfig } from "./qq-account-config.js"
import { QQ_EVENT, QQ_OP } from "./types.js"
import {
  extractSignatureHeaders,
  signEd25519UrlVerification,
  verifyEd25519BusinessEvent,
} from "./webhook-signature.js"

const log = createLogger("im.qq")

export async function startQqAccount(
  ctx: AccountStartContext
): Promise<RunningAccount> {
  const mode = ctx.account.connectionMode
  if (mode === "webhook") {
    ctx.logger.info("qq: webhook mode — no long connection started")
    return { stop: async () => {} }
  }
  // long_connection — drive the WS gateway until the IM runtime
  // manager aborts our signal.
  ctx.logger.info("qq: starting long_connection gateway", {
    accountId: ctx.account.id,
  })
  // Validate creds up-front so we fail fast instead of looping reconnect
  // on bad config.
  getQqCredentialsOrThrow(ctx.account)
  // Fire-and-forget; runQqGateway returns when the abort signal fires
  // or when the bot is permanently offline/banned.
  void runQqGateway({
    account: ctx.account,
    signal: ctx.signal,
    logger: ctx.logger,
    redis,
    emitInbound: ctx.emitInbound,
  }).catch((err) => {
    if (!ctx.signal.aborted) {
      ctx.logger.error("qq: gateway loop crashed", err)
    }
  })
  return {
    stop: async () => {
      // runQqGateway listens to ctx.signal directly; the IM runtime
      // manager aborts it when this account is being stopped.
    },
  }
}

interface QqWebhookEnvelope {
  op?: number
  t?: string
  s?: number
  d?: unknown
  id?: string
}

export async function handleQqWebhook(
  input: WebhookHandlerInput
): Promise<WebhookHandlerResult> {
  const logger = input.logger
  const creds = (() => {
    try {
      return getQqCredentialsOrThrow(input.account)
    } catch (err) {
      logger?.error?.("qq: webhook missing credentials", err)
      return null
    }
  })()
  if (!creds) {
    return { statusCode: 500, body: { error: "qq credentials invalid" } }
  }

  const envelope = parseEnvelope(input.body)
  if (!envelope) {
    return { statusCode: 400, body: { error: "invalid envelope" } }
  }

  // URL verification: signature is computed locally and returned in the
  // body — we do NOT verify an incoming signature header here.
  if (envelope.op === QQ_OP.WEBHOOK_VERIFY) {
    return handleUrlVerification({
      secret: getEd25519Seed(creds),
      data: envelope.d,
    })
  }

  // In HTTP-callback mode the platform also sends heartbeat (op=1) over
  // the webhook; answer with a heartbeat-ACK (op=11) echoing d, NOT the
  // callback-ACK (op=12).
  if (envelope.op === QQ_OP.HEARTBEAT) {
    return {
      statusCode: 200,
      body: { op: QQ_OP.HEARTBEAT_ACK, d: envelope.d },
    }
  }

  if (envelope.op !== QQ_OP.DISPATCH) {
    // Other WS-only opcodes (op=2/6/7/9/10) shouldn't reach the webhook;
    // if they do it's a misconfiguration. Ack 200 (d:0 = handled, no
    // retry) so the platform doesn't redeliver a payload we can't action.
    logger?.warn?.(`qq: unexpected op on webhook`, { op: envelope.op })
    return { statusCode: 200, body: { op: QQ_OP.HTTP_CALLBACK_ACK, d: 0 } }
  }

  // op=0 dispatch — must verify signature against the raw body.
  if (!input.rawBody) {
    logger?.error?.("qq: webhook rawBody missing — cannot verify signature")
    return { statusCode: 400, body: { error: "raw body required" } }
  }
  const { signatureHex, signatureTimestamp } = extractSignatureHeaders(
    input.headers
  )
  if (!signatureHex || !signatureTimestamp) {
    return { statusCode: 401, body: { error: "missing signature headers" } }
  }
  const verified = verifyEd25519BusinessEvent({
    secret: getEd25519Seed(creds),
    signatureHex,
    signatureTimestamp,
    rawBody: input.rawBody,
  })
  if (!verified) {
    return { statusCode: 401, body: { error: "signature verification failed" } }
  }

  // OQ2 resolved: webhook delivery of C2C/GROUP_AT is standard, so this
  // dispatches by default (webhookInboundConfirmed defaults true). The
  // flag is an operator KILL-SWITCH — only an explicit false makes us
  // ack-only without dispatching.
  const config = readQqAccountConfig(input.account)
  if (!config.webhookInboundConfirmed) {
    logger?.info?.(
      "qq: webhook inbound disabled (webhookInboundConfirmed=false); ack-only",
      { t: envelope.t, accountId: input.account.id }
    )
    return { statusCode: 200, body: { op: QQ_OP.HTTP_CALLBACK_ACK, d: 0 } }
  }

  // The HTTP-callback ACK's `d` field controls retry: d:0 = handled OK,
  // d:1 = handling failed → platform redelivers. Acking success
  // unconditionally would silently drop events whose normalization
  // returned null or whose emit threw.
  let dispatched = false
  try {
    dispatched = await dispatchBusinessEvent(envelope, input, logger)
  } catch (err) {
    logger?.error?.("qq: inbound dispatch failed", err)
    dispatched = false
  }

  return {
    statusCode: 200,
    body: { op: QQ_OP.HTTP_CALLBACK_ACK, d: dispatched ? 0 : 1 },
  }
}

function parseEnvelope(body: unknown): QqWebhookEnvelope | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  return body as QqWebhookEnvelope
}

interface VerificationData {
  plain_token?: string
  event_ts?: string
}

function handleUrlVerification(input: {
  secret: string
  data: unknown
}): WebhookHandlerResult {
  if (
    !input.data ||
    typeof input.data !== "object" ||
    Array.isArray(input.data)
  ) {
    return { statusCode: 400, body: { error: "invalid verification payload" } }
  }
  const d = input.data as VerificationData
  const plainToken = typeof d.plain_token === "string" ? d.plain_token : ""
  const eventTs = typeof d.event_ts === "string" ? d.event_ts : ""
  if (!plainToken || !eventTs) {
    return {
      statusCode: 400,
      body: { error: "verification payload missing plain_token/event_ts" },
    }
  }
  const signature = signEd25519UrlVerification({
    secret: input.secret,
    plainToken,
    eventTs,
  })
  return {
    statusCode: 200,
    body: { plain_token: plainToken, signature },
  }
}

/**
 * Returns whether the event was handled successfully. `false` (or a
 * thrown error) makes the caller ACK with d:1 so the platform redelivers.
 * Deliberately-ignored events (non-@ group, webhook-side interactions,
 * unknown `t`) return `true` — they are "handled, nothing to do", not
 * failures, so we must not ask the platform to retry them.
 */
async function dispatchBusinessEvent(
  envelope: QqWebhookEnvelope,
  input: WebhookHandlerInput,
  logger: WebhookHandlerInput["logger"]
): Promise<boolean> {
  switch (envelope.t) {
    case QQ_EVENT.C2C_MESSAGE_CREATE: {
      const e = await normalizeQqC2cMessage(
        envelope.d as QqC2cMessageEventData,
        { accountId: input.account.id }
      )
      if (!e) {
        logger?.warn?.("qq: C2C event missing required fields", {
          eventId: envelope.id,
        })
        return false
      }
      await recordInboundAnchor({
        accountId: input.account.id,
        endpointType: e.endpointType,
        endpointExternalId: e.endpointExternalId,
        anchorKind: "msg_id",
        anchorId: e.externalMessageId,
        eventType: QQ_EVENT.C2C_MESSAGE_CREATE,
        receivedAt: e.receivedAt,
      })
      await input.emitInbound(e)
      return true
    }
    case QQ_EVENT.GROUP_AT_MESSAGE_CREATE: {
      const e = await normalizeQqGroupAtMessage(
        envelope.d as QqGroupAtMessageEventData,
        { accountId: input.account.id }
      )
      if (!e) {
        logger?.warn?.("qq: GROUP_AT event missing required fields", {
          eventId: envelope.id,
        })
        return false
      }
      await recordInboundAnchor({
        accountId: input.account.id,
        endpointType: e.endpointType,
        endpointExternalId: e.endpointExternalId,
        anchorKind: "msg_id",
        anchorId: e.externalMessageId,
        eventType: QQ_EVENT.GROUP_AT_MESSAGE_CREATE,
        receivedAt: e.receivedAt,
      })
      await input.emitInbound(e)
      return true
    }
    case QQ_EVENT.GROUP_MESSAGE_CREATE:
      // v1 ignores non-@ group messages; the bot only responds when
      // explicitly invoked. Intentionally handled → no retry.
      return true
    case QQ_EVENT.INTERACTION_CREATE:
      // QQ button clicks are documented as WebSocket-only delivery; if
      // one shows up on the webhook path we log and drop it (Stage 8
      // handles INTERACTION_CREATE in the WS path). No retry.
      logger?.warn?.(
        "qq: INTERACTION_CREATE on webhook path (expected WS-only)",
        { eventId: envelope.id }
      )
      return true
    default:
      logger?.debug?.("qq: ignored event", { t: envelope.t })
      return true
  }
}

/**
 * Best-effort: stash the inbound anchor in Redis so the outbound flow
 * (reply-quota.ts reserveFirstSend) can find it later. Failures are
 * swallowed and logged — losing an anchor is recoverable (outbound
 * fails fast with `no_passive_anchor`) but losing the inbound itself
 * is not, so the emit path always wins.
 */
async function recordInboundAnchor(params: {
  accountId: string
  endpointType: "direct" | "group"
  endpointExternalId: string
  anchorKind: "msg_id" | "event_id"
  anchorId: string
  eventType: string
  receivedAt: import("@synapse/shared/types").Timestamp
}): Promise<void> {
  await writeLatestInboundAnchor(redis, {
    accountId: params.accountId,
    endpointType: params.endpointType,
    endpointExternalId: params.endpointExternalId,
    anchor: {
      anchorKind: params.anchorKind,
      anchorId: params.anchorId,
      eventType: params.eventType,
      receivedAt: params.receivedAt,
    },
  }).catch((err) => {
    log.warn(
      { err },
      `[im:qq] failed to record inbound anchor for account ${params.accountId}`
    )
  })
}
