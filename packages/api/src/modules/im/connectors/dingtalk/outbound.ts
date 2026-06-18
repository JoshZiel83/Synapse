/**
 * DingTalk outbound dispatcher.
 *
 * A robot message carries exactly ONE msgKey, so a CanonicalMessage with mixed
 * text + media is split by `planDingtalkSends` into an ordered sequence of
 * sub-sends and dispatched in order (the first send's id is the primary
 * returned id, matching the Feishu reference). Sub-sends:
 *
 *   TEXT/markdown — sessionWebhook-first, OpenAPI fallback:
 *     1. If the endpoint has a sessionWebhook URL not *known* expired, POST it
 *        (token attached when available, but never blocking — see below).
 *     2. On any sessionWebhook failure, fall back to the OpenAPI sender for the
 *        endpoint type (groupMessages/send | oToMessages/batchSend). Direct
 *        OpenAPI requires a staffId (only after the app is published); when
 *        missing we throw so the delivery worker retries.
 *
 *   MEDIA (image/voice/file) — always OpenAPI (sessionWebhook cannot carry
 *     media): read bytes from our CAS by sha256 → upload to /media/upload for a
 *     mediaId → send the matching robot sample*Msg msgKey via the same OpenAPI
 *     senders. Errors propagate so BullMQ retries the whole delivery.
 *
 *   Known v1 limitation: a mixed text+media message that partially fails (e.g.
 *   text delivered, media upload fails) re-sends the text on retry — DingTalk's
 *   robot OpenAPI exposes no idempotency key. Text-only and media-only sends
 *   (the common cases) are unaffected.
 */

import { createHash } from "crypto"
import {
  requireEpochMillis,
  fromExternalRfc3339,
  parseIsoInstant,
} from "@synapse/shared/datetime"
import { createLogger } from "../../../../infrastructure/logger/index.js"
import { readContentBuffer } from "../../../../infrastructure/storage/content-store.js"
import type {
  MessageRef,
  OutboundEndpointRef,
  OutboundSendResult,
} from "../types.js"
import type { TransportAccountSummary } from "@synapse/shared/types"
import type { CanonicalMessage } from "../../messaging/canonical-message.js"
import { degradeForCapabilities } from "../../messaging/degradation.js"
import { DINGTALK_MESSAGE_CAPABILITIES } from "./capabilities.js"
import { getDingtalkCredentialsOrThrow } from "./credentials.js"
import {
  getAccessToken,
  getOapiAccessToken,
  isDingtalkBusinessSuccess,
  sendDirectOpenApi,
  sendGroupOpenApi,
  sendViaSessionWebhook,
} from "./client.js"
import {
  extensionOf,
  uploadDingtalkMedia,
  type DingtalkMediaUploadType,
  type MediaBytesReader,
} from "./media.js"
import {
  planDingtalkSends,
  renderOpenApiPayload,
  renderSessionWebhookPayload,
  type DingtalkSendPlanItem,
} from "./render.js"

export interface DingtalkSendInput {
  account: TransportAccountSummary
  endpoint: OutboundEndpointRef
  message: CanonicalMessage
  replyTo?: MessageRef
  /** Test seam — outbound media bytes reader; defaults to our CAS by sha256. */
  readBytes?: MediaBytesReader
}

// Bounded synthetic message id helper — `transport_message_links.external_message_id`
// is VARCHAR(255). We hash the endpoint id (which is a DingTalk conversationId
// of unbounded length per the protocol) into a fixed 16-char prefix so the
// final id stays around 50 chars no matter what.
export function makeSyntheticMessageId(
  kind: "session" | "openapi",
  endpointId: string
): string {
  const hash = createHash("sha256")
    .update(endpointId)
    .digest("hex")
    .slice(0, 16)
  return `dingtalk-${kind}:${hash}:${Date.now()}`
}

const log = createLogger("im.dingtalk.outbound")

/**
 * Parse a DingTalk sessionWebhookExpiredTime value. The field is documented
 * as a Unix MILLISECONDS timestamp; ISO strings are tolerated. A PRESENT but
 * unparseable value is logged (not silently swallowed) and returns `undefined`;
 * the caller treats a present-but-unparsed expiry as corrupt.
 */
export function parseSessionWebhookExpiry(raw: unknown): number | undefined {
  if (raw == null) return undefined
  // DingTalk documents sessionWebhookExpiredTime as Unix MILLISECONDS — route
  // every shape through the canonical adapters (C1: one parser). The [2000,2200)
  // plausibility window rejects a seconds value passed as ms, and a present-but-
  // corrupt value LOGS + returns undefined (C2: never silently fail-open, but do
  // not crash outbound either).
  if (typeof raw === "number") {
    try {
      return requireEpochMillis(raw, "ms")
    } catch {
      log.warn({ raw }, "dingtalk.session_webhook_expiry_unparseable")
      return undefined
    }
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (trimmed === "") return undefined
    if (/^[+-]?\d+$/.test(trimmed)) {
      // numeric string — epoch ms
      try {
        return requireEpochMillis(trimmed, "ms")
      } catch {
        log.warn({ raw }, "dingtalk.session_webhook_expiry_unparseable")
        return undefined
      }
    }
    // ISO string (non-numeric)
    try {
      return parseIsoInstant(fromExternalRfc3339(trimmed)).getTime()
    } catch {
      log.warn({ raw }, "dingtalk.session_webhook_expiry_unparseable")
      return undefined
    }
  }
  return undefined
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined
}

/**
 * Per-send context shared across sub-sends. The v1.0 token (header auth for
 * the robot OpenAPI + sessionWebhook) and the legacy OAPI token (query-param
 * auth for /media/upload) are each memoized once so a multi-part plan doesn't
 * re-issue them.
 */
interface SendContext {
  account: TransportAccountSummary
  endpoint: OutboundEndpointRef
  metadata: Record<string, unknown>
  endpointId: string
  /** v1.0 accessToken (x-acs-dingtalk-access-token). */
  getToken: () => Promise<string>
  /** Legacy OAPI token for /media/upload (?access_token= query param). */
  getOapiToken: () => Promise<string>
  readBytes: MediaBytesReader
}

/** robotCode is required on every robot OpenAPI send; default to the app key. */
function robotCodeOf(ctx: SendContext): string {
  return (
    stringOrUndefined(ctx.metadata.robotCode) ??
    getDingtalkCredentialsOrThrow(ctx.account).clientId
  )
}

// ───────────────────────── text / markdown sub-send ─────────────────────────

async function sendTextSubsend(
  message: CanonicalMessage,
  ctx: SendContext
): Promise<OutboundSendResult> {
  const webhookBody = renderSessionWebhookPayload(message)

  // sessionWebhook attempt, gated by presence + *known* expiry only.
  const webhook = stringOrUndefined(ctx.metadata.sessionWebhook)
  const rawExpiry = ctx.metadata.sessionWebhookExpiredTime
  const expiredAt = parseSessionWebhookExpiry(rawExpiry)
  const knownExpired = expiredAt != null && expiredAt <= Date.now()
  // A PRESENT but unparseable expiry is corrupt — treat it as unsafe and skip
  // the webhook (do not fail-open on garbage). An ABSENT expiry keeps the
  // deliberate delivery fail-open (the OpenAPI fallback is often impossible).
  const expiryCorrupt = rawExpiry != null && expiredAt == null

  if (webhook && !knownExpired && !expiryCorrupt) {
    try {
      // The sessionWebhook self-authenticates; attach a token only if it can
      // be acquired without error. A token-endpoint failure must NOT defeat an
      // otherwise-valid reply by forcing the (often-impossible) OpenAPI path.
      let token: string | undefined
      try {
        token = await ctx.getToken()
      } catch {
        token = undefined
      }
      const resp = await sendViaSessionWebhook(webhook, webhookBody, token)
      if (resp.httpOk && isDingtalkBusinessSuccess(resp.body)) {
        return {
          externalMessageId: makeSyntheticMessageId("session", ctx.endpointId),
          raw: { sessionWebhook: resp.body },
        }
      }
      // fall through to OpenAPI
    } catch {
      // network errors fall through to OpenAPI
    }
  }

  const openApiPayload = renderOpenApiPayload(message)
  return sendOpenApi(
    ctx,
    openApiPayload.msgKey,
    openApiPayload.msgParam,
    "text"
  )
}

// ───────────────────────── media sub-send ─────────────────────────

function mediaPlan(item: Exclude<DingtalkSendPlanItem, { kind: "text" }>): {
  uploadType: DingtalkMediaUploadType
  filename: string
  defaultMime: string
  msgKey: string
  buildMsgParam: (mediaId: string) => string
} {
  switch (item.kind) {
    case "image":
      return {
        uploadType: "image",
        filename: item.fileRef.name || "image",
        defaultMime: "image/jpeg",
        msgKey: "sampleImageMsg",
        // photoURL takes the raw mediaId (with its "@" prefix), NOT a URL.
        buildMsgParam: (mediaId) => JSON.stringify({ photoURL: mediaId }),
      }
    case "voice":
      return {
        uploadType: "voice",
        filename: item.fileRef.name || "voice.amr",
        defaultMime: "audio/amr",
        msgKey: "sampleAudio",
        // duration unit is MILLISECONDS for sampleAudio.
        buildMsgParam: (mediaId) =>
          JSON.stringify({
            mediaId,
            duration: String(item.durationMs ?? 0),
          }),
      }
    case "file":
      return {
        uploadType: "file",
        filename: item.fileRef.name,
        defaultMime: "application/octet-stream",
        msgKey: "sampleFile",
        buildMsgParam: (mediaId) =>
          JSON.stringify({
            mediaId,
            fileName: item.fileRef.name,
            fileType: extensionOf(item.fileRef.name),
          }),
      }
  }
}

async function sendMediaSubsend(
  item: Exclude<DingtalkSendPlanItem, { kind: "text" }>,
  ctx: SendContext
): Promise<OutboundSendResult> {
  const plan = mediaPlan(item)
  const sha256 = item.fileRef.sha256?.trim()
  if (!sha256) {
    throw new Error(
      `dingtalk ${item.kind} part requires a CanonicalFileRef.sha256; got ${JSON.stringify(item.fileRef)}`
    )
  }
  const buffer = await ctx.readBytes(sha256)
  const oapiToken = await ctx.getOapiToken()
  const mediaId = await uploadDingtalkMedia({
    oapiToken,
    type: plan.uploadType,
    buffer,
    filename: plan.filename,
    mime: item.fileRef.mimeType || plan.defaultMime,
  })
  return sendOpenApi(ctx, plan.msgKey, plan.buildMsgParam(mediaId), item.kind)
}

// ───────────────────────── shared OpenAPI send ─────────────────────────

/**
 * Send a built {msgKey, msgParam} via the robot OpenAPI matching the endpoint
 * type. `label` is only used for error messages. Direct sends require a
 * staffId (post-publish only); when missing we throw so the worker retries.
 */
async function sendOpenApi(
  ctx: SendContext,
  msgKey: string,
  msgParam: string,
  label: string
): Promise<OutboundSendResult> {
  const robotCode = robotCodeOf(ctx)

  if (ctx.endpoint.endpointType === "direct") {
    // Guard the staffId requirement BEFORE acquiring a token — a direct send
    // without a staffId is impossible, and we don't want to issue a token for
    // a request we know would fail.
    const lastSenderStaffId = stringOrUndefined(ctx.metadata.lastSenderStaffId)
    if (!lastSenderStaffId) {
      throw new Error(
        "missing lastSenderStaffId for direct OpenAPI send; staffId only available after app published"
      )
    }
    const token = await ctx.getToken()
    const resp = await sendDirectOpenApi({
      userId: lastSenderStaffId,
      msgKey,
      msgParam,
      accessToken: token,
      robotCode,
    })
    if (!resp.httpOk || !isDingtalkBusinessSuccess(resp.body)) {
      throw new Error(
        `dingtalk oToMessages/batchSend failed (${label}): http=${resp.status} body=${JSON.stringify(resp.body).slice(0, 300)}`
      )
    }
    const processQueryKey = stringOrUndefined(resp.body.processQueryKey)
    return {
      externalMessageId:
        processQueryKey ?? makeSyntheticMessageId("openapi", ctx.endpointId),
      raw: { oToMessages: resp.body },
    }
  }

  const openConversationId =
    stringOrUndefined(ctx.metadata.openConversationId) ?? ctx.endpointId
  const token = await ctx.getToken()
  const resp = await sendGroupOpenApi({
    openConversationId,
    msgKey,
    msgParam,
    accessToken: token,
    robotCode,
  })
  if (!resp.httpOk || !isDingtalkBusinessSuccess(resp.body)) {
    throw new Error(
      `dingtalk groupMessages/send failed (${label}): http=${resp.status} body=${JSON.stringify(resp.body).slice(0, 300)}`
    )
  }
  const processQueryKey = stringOrUndefined(resp.body.processQueryKey)
  return {
    externalMessageId:
      processQueryKey ?? makeSyntheticMessageId("openapi", ctx.endpointId),
    raw: { groupMessages: resp.body },
  }
}

// ───────────────────────── entry point ─────────────────────────

export async function sendDingtalkMessage(
  input: DingtalkSendInput
): Promise<OutboundSendResult> {
  // Capability-aware degrade: mention parts stay (supportsMention=true);
  // image/voice/file parts stay (now supported) and reach the media path;
  // video/card/reaction/quote degrade to safe alternatives.
  const degraded = degradeForCapabilities(
    input.message,
    DINGTALK_MESSAGE_CAPABILITIES
  )

  let cachedToken: string | undefined
  let cachedOapiToken: string | undefined
  const ctx: SendContext = {
    account: input.account,
    endpoint: input.endpoint,
    metadata: input.endpoint.metadata || {},
    endpointId: input.endpoint.externalId,
    getToken: async () => {
      if (cachedToken) return cachedToken
      cachedToken = await getAccessToken(input.account)
      return cachedToken
    },
    getOapiToken: async () => {
      if (cachedOapiToken) return cachedOapiToken
      cachedOapiToken = await getOapiAccessToken(input.account)
      return cachedOapiToken
    },
    readBytes: input.readBytes ?? readContentBuffer,
  }

  const plan = planDingtalkSends(degraded)
  if (plan.length === 0) {
    // No text and no media (e.g. a reaction-only message that shouldn't have
    // routed here). Send a visible placeholder rather than a silent no-op.
    plan.push({
      kind: "text",
      message: {
        ...degraded,
        parts: [{ type: "text", text: "[消息]" }],
        plainText: "[消息]",
      },
    })
  }

  // Sequential so ordering is preserved and a single failure aborts the rest
  // (the worker retries the whole delivery).
  const results: OutboundSendResult[] = []
  for (const item of plan) {
    if (item.kind === "text") {
      results.push(await sendTextSubsend(item.message, ctx))
    } else {
      results.push(await sendMediaSubsend(item, ctx))
    }
  }

  const primary = results[0]
  return {
    externalMessageId:
      primary?.externalMessageId ??
      makeSyntheticMessageId("openapi", ctx.endpointId),
    raw: {
      primary: primary?.raw,
      extras: results.slice(1).map((r) => r.raw),
    },
  }
}
