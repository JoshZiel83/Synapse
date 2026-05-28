/**
 * DingTalk outbound dispatcher.
 *
 * Flow:
 *   1. Degrade message for DingTalk capabilities (flatten mention → text
 *      when supportsMention=false; here it's true so mention parts stay).
 *   2. Render the webhook body. Use a lazy access-token helper so token
 *      acquisition only happens when at least one path needs it.
 *   3. If the endpoint has a sessionWebhook URL and it isn't *known* to
 *      have expired, POST it with the x-acs-dingtalk-access-token header.
 *      An HTTP-2xx + business-success response wins.
 *   4. On any sessionWebhook failure (HTTP non-2xx, business-failure body,
 *      or absent webhook), fall back to the OpenAPI sender that matches
 *      the endpoint type — groupMessages/send for groups, oToMessages/
 *      batchSend for direct chats.
 *   5. Direct-chat OpenAPI fallback REQUIRES a staffId, which is only
 *      populated when the bot's DingTalk app has been published. When
 *      missing (dev/test paths), throw a descriptive Error after the
 *      sessionWebhook attempt — the IM delivery worker writes link
 *      `failed`. The shared retry policy
 *      (`IM_TRANSPORT_DELIVERY_JOB_DEFAULTS`: 5 attempts + exponential
 *      backoff) will then re-run, which is the right behavior for the
 *      "app not published yet" case (operator finishes publish → next
 *      retry succeeds). For genuinely terminal failures use
 *      `PermanentTransportError` so the BullMQ wrapper short-circuits
 *      to `UnrecoverableError`.
 *   6. Either path that succeeds returns an externalMessageId. The
 *      sessionWebhook response only carries `{errcode, errmsg}`, so a
 *      synthetic id is generated. OpenAPI returns `processQueryKey`; if
 *      missing, the synthetic id keeps the link consistent.
 */

import { createHash } from "crypto"
import type {
  MessageRef,
  OutboundEndpointRef,
  OutboundSendResult,
} from "../types.js"
import type { TransportAccountSummary } from "@synapse/shared/types"
import type { CanonicalMessage } from "../../messaging/canonical-message.js"
import { degradeForCapabilities } from "../../messaging/degradation.js"
import { DINGTALK_MESSAGE_CAPABILITIES } from "./capabilities.js"
import {
  getAccessToken,
  isDingtalkBusinessSuccess,
  sendDirectOpenApi,
  sendGroupOpenApi,
  sendViaSessionWebhook,
} from "./client.js"
import { renderOpenApiPayload, renderSessionWebhookPayload } from "./render.js"

export interface DingtalkSendInput {
  account: TransportAccountSummary
  endpoint: OutboundEndpointRef
  message: CanonicalMessage
  replyTo?: MessageRef
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

/**
 * Parse a DingTalk sessionWebhookExpiredTime value. The field is documented
 * as a ms timestamp; older payloads / mock responses sometimes use seconds
 * or ISO strings. Returns `undefined` (treat as not-expired) for anything
 * unparseable so we don't accidentally bypass a still-valid webhook.
 */
export function parseSessionWebhookExpiry(raw: unknown): number | undefined {
  if (raw == null) return undefined
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Heuristic: < 1e12 means seconds (Unix epoch around 33658 AD before
    // that boundary in ms), >= 1e12 means ms.
    return raw < 1e12 ? raw * 1000 : raw
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (trimmed === "") return undefined
    // Numeric string?
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) {
      return numeric < 1e12 ? numeric * 1000 : numeric
    }
    // ISO-ish?
    const parsed = Date.parse(trimmed)
    if (Number.isFinite(parsed)) return parsed
    return undefined
  }
  return undefined
}

export async function sendDingtalkMessage(
  input: DingtalkSendInput
): Promise<OutboundSendResult> {
  // Step 0: capability-aware degrade. With supportsMention=true mention
  // parts stay intact; image/file/card/reaction/quote parts (which the v1
  // capability set disables) get rewritten to safer alternatives so the
  // renderer never sees an unexpected shape.
  const degraded = degradeForCapabilities(
    input.message,
    DINGTALK_MESSAGE_CAPABILITIES
  )

  const account = input.account
  const endpointId = input.endpoint.externalId
  const metadata = input.endpoint.metadata || {}

  // Step 0b: lazy token helper. Both reply paths need the access token,
  // but constructing it for a message that turns out to need none (e.g.
  // a successful sessionWebhook with cached fetch result) would be
  // wasteful. Memoize per-send so the second fallback path doesn't
  // re-issue a token request.
  let cachedToken: string | undefined
  const getToken = async (): Promise<string> => {
    if (cachedToken) return cachedToken
    cachedToken = await getAccessToken(account)
    return cachedToken
  }

  // Step 1: render sessionWebhook body up-front. Cheap (just builds the
  // markdown body + at-array). Reused below if the webhook path attempts.
  const webhookBody = renderSessionWebhookPayload(degraded)

  // Step 2: sessionWebhook attempt, gated by:
  //   - presence of a sessionWebhook URL in endpoint metadata, and
  //   - the *known* expiry — only skip when we have a parseable
  //     sessionWebhookExpiredTime AND it's already in the past. An
  //     unparseable value falls through to "still maybe valid" so we
  //     don't blank-skip the cheaper path for a misshapen metadata field.
  const webhook = stringOrUndefined(metadata.sessionWebhook)
  const expiredAt = parseSessionWebhookExpiry(
    metadata.sessionWebhookExpiredTime
  )
  const knownExpired = expiredAt != null && expiredAt <= Date.now()

  if (webhook && !knownExpired) {
    try {
      const token = await getToken()
      const resp = await sendViaSessionWebhook(webhook, webhookBody, token)
      if (resp.httpOk && isDingtalkBusinessSuccess(resp.body)) {
        return {
          externalMessageId: makeSyntheticMessageId("session", endpointId),
          raw: { sessionWebhook: resp.body },
        }
      }
      // fall through to OpenAPI
    } catch {
      // network errors fall through to OpenAPI
    }
  }

  // Step 3: OpenAPI fallback. Now is where the direct-chat staffId
  // requirement gets enforced — we throw BEFORE acquiring a token for
  // a request we know would 400 server-side.
  const endpointType = input.endpoint.endpointType
  if (endpointType === "direct") {
    const lastSenderStaffId = stringOrUndefined(metadata.lastSenderStaffId)
    if (!lastSenderStaffId) {
      throw new Error(
        "missing lastSenderStaffId for direct OpenAPI fallback; staffId only available after app published"
      )
    }
    const openApiPayload = renderOpenApiPayload(degraded)
    const token = await getToken()
    const robotCode = stringOrUndefined(metadata.robotCode)
    const resp = await sendDirectOpenApi({
      userId: lastSenderStaffId,
      msgKey: openApiPayload.msgKey,
      msgParam: openApiPayload.msgParam,
      accessToken: token,
      robotCode,
    })
    if (!resp.httpOk || !isDingtalkBusinessSuccess(resp.body)) {
      throw new Error(
        `dingtalk oToMessages/batchSend failed: http=${resp.status} body=${JSON.stringify(resp.body).slice(0, 300)}`
      )
    }
    const processQueryKey = stringOrUndefined(resp.body.processQueryKey)
    return {
      externalMessageId:
        processQueryKey ?? makeSyntheticMessageId("openapi", endpointId),
      raw: { oToMessages: resp.body },
    }
  }

  // group fallback
  const openConversationId =
    stringOrUndefined(metadata.openConversationId) ?? endpointId
  const openApiPayload = renderOpenApiPayload(degraded)
  const token = await getToken()
  const robotCode = stringOrUndefined(metadata.robotCode)
  const resp = await sendGroupOpenApi({
    openConversationId,
    msgKey: openApiPayload.msgKey,
    msgParam: openApiPayload.msgParam,
    accessToken: token,
    robotCode,
  })
  if (!resp.httpOk || !isDingtalkBusinessSuccess(resp.body)) {
    throw new Error(
      `dingtalk groupMessages/send failed: http=${resp.status} body=${JSON.stringify(resp.body).slice(0, 300)}`
    )
  }
  const processQueryKey = stringOrUndefined(resp.body.processQueryKey)
  return {
    externalMessageId:
      processQueryKey ?? makeSyntheticMessageId("openapi", endpointId),
    raw: { groupMessages: resp.body },
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined
}
