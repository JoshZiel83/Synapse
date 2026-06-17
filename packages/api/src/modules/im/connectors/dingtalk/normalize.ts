/**
 * DingTalk inbound payload → CanonicalMessage InboundEnvelope.
 *
 * Pure. Two key v1 contracts implemented here:
 *
 *   1. Bot self-message filter: returns null when the payload's
 *      `senderId === chatbotUserId` OR `senderStaffId === chatbotUserId`,
 *      so the stream layer's emitInbound is never invoked for messages
 *      the bot itself just sent (would otherwise re-trigger the actor
 *      pipeline in a loop).
 *
 *   2. Address externalId namespace isolation: when `senderStaffId` is
 *      missing (which DingTalk only provides for *published* apps),
 *      the sender's externalId is prefixed with `"senderId:"` so the
 *      address row is uniquely identifiable but the outbound renderer
 *      will defensively filter it out of `at.atUserIds` (would otherwise
 *      be misinterpreted as a staffId).
 */

import {
  buildCanonicalMessage,
  type CanonicalMessage,
  type CanonicalPart,
} from "../../messaging/canonical-message.js"
import { dateToIsoInstant, nowIsoInstant } from "@synapse/shared/datetime"
import type { InboundEnvelope } from "../types.js"
import { parseDingtalkMentions, type DingtalkAtUser } from "./mentions.js"

/**
 * Raw payload shape (matching the dingtalk-stream SDK's RobotMessage plus
 * the optional groupchat-only fields the SDK doesn't model). Kept loose
 * (most fields optional) so a slightly off payload still attempts to
 * normalize rather than crashing the stream loop.
 */
export interface DingtalkInboundPayload {
  msgtype?: string
  msgId?: string
  conversationId?: string
  conversationType?: string
  conversationTitle?: string
  openConversationId?: string
  createAt?: number | string
  senderId?: string
  senderStaffId?: string
  senderNick?: string
  senderCorpId?: string
  chatbotUserId?: string
  chatbotCorpId?: string
  robotCode?: string
  sessionWebhook?: string
  sessionWebhookExpiredTime?: number | string
  isAdmin?: boolean
  isInAtList?: boolean
  atUsers?: DingtalkAtUser[]
  text?: { content?: string }
  content?: Record<string, unknown>
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/**
 * The `content` object on non-text inbound messages (picture/audio/video/
 * file/richText), narrowed to an object so callers can dig out type-specific
 * fields (recognition, richText[], downloadCode, …).
 */
function asContentObject(
  payload: DingtalkInboundPayload
): Record<string, unknown> | undefined {
  const c = payload.content
  return typeof c === "object" && c !== null
    ? (c as Record<string, unknown>)
    : undefined
}

/**
 * richText inbound `content.richText` is an ordered array mixing text
 * segments (`{text}`) and image segments (`{downloadCode, type:"picture"}`).
 * Concatenate the user-typed text verbatim (internal spacing preserved);
 * image segments are surfaced separately as a placeholder marker by
 * placeholderFor(). Returns "" when no text segment exists (image-only msg).
 */
function extractRichTextSegments(payload: DingtalkInboundPayload): string {
  const arr = asContentObject(payload)?.richText
  if (!Array.isArray(arr)) return ""
  let out = ""
  for (const seg of arr) {
    if (typeof seg !== "object" || seg === null) continue
    const t = (seg as { text?: unknown }).text
    if (typeof t === "string") out += t
  }
  return out.trim()
}

function richTextHasImageSegment(payload: DingtalkInboundPayload): boolean {
  const arr = asContentObject(payload)?.richText
  if (!Array.isArray(arr)) return false
  return arr.some(
    (seg) =>
      typeof seg === "object" &&
      seg !== null &&
      (nonEmpty((seg as { downloadCode?: unknown }).downloadCode) !==
        undefined ||
        (seg as { type?: unknown }).type === "picture")
  )
}

function extractRawText(payload: DingtalkInboundPayload): string {
  if (payload.msgtype === "text") {
    return nonEmpty(payload.text?.content) ?? ""
  }
  // NOTE: there is NO inbound "markdown" msgtype — markdown/actionCard/
  // feedCard/link are OUTBOUND send types only. The inbound receive catalog
  // is exactly: text, richText, picture, audio, video, file (+ unknown).
  if (!payload.msgtype) return ""
  // For media types the system_marker placeholder (and, after the inbound-media
  // enrich, the real media part) already renders the "[图片]/[语音]/…" label, so
  // returning that label as text too would double it. Return "" and let the
  // marker carry the label — EXCEPT audio, where content.recognition is real
  // speech-to-text transcript that belongs in the body.
  switch (payload.msgtype) {
    case "picture":
      return ""
    case "audio":
      return nonEmpty(asContentObject(payload)?.recognition) ?? ""
    case "video":
      return ""
    case "file":
      return ""
    case "richText":
      // Recover the user-typed text; fall back to a placeholder only for an
      // image-only rich message.
      return extractRichTextSegments(payload) || "[富文本]"
    default:
      // Unknown types have no placeholder marker, so the label must live in the
      // text here.
      return `[${payload.msgtype}]`
  }
}

function placeholderFor(payload: DingtalkInboundPayload): CanonicalPart | null {
  switch (payload.msgtype) {
    case "picture":
      return {
        type: "system_marker",
        marker: "image_placeholder",
        original: payload.content,
      }
    case "audio":
      return {
        type: "system_marker",
        marker: "voice_placeholder",
        original: payload.content,
      }
    case "video":
      return {
        type: "system_marker",
        marker: "video_placeholder",
        original: payload.content,
      }
    case "file":
      return {
        type: "system_marker",
        marker: "file_placeholder",
        original: payload.content,
      }
    case "richText":
      // The typed text is recovered into the message body by extractRawText;
      // only emit a marker when the rich message carries an inline image.
      return richTextHasImageSegment(payload)
        ? {
            type: "system_marker",
            marker: "image_placeholder",
            original: payload.content,
          }
        : null
    default:
      return null
  }
}

export interface NormalizeOptions {
  logger?: { warn: (msg: string) => void }
}

/**
 * Returns null when the payload should be dropped without emitInbound
 * (bot self-message, completely empty payload, missing routing identity).
 */
export function normalizeDingtalkPayload(
  payload: DingtalkInboundPayload,
  options: NormalizeOptions = {}
): InboundEnvelope | null {
  // Bot self-message filter: check both fields because senderStaffId
  // may be undefined for unpublished dev apps.
  const chatbotUserId = nonEmpty(payload.chatbotUserId)
  const senderId = nonEmpty(payload.senderId)
  const senderStaffId = nonEmpty(payload.senderStaffId)
  if (chatbotUserId) {
    if (senderId === chatbotUserId) return null
    if (senderStaffId === chatbotUserId) return null
  }

  const externalMessageId = nonEmpty(payload.msgId)
  const conversationId = nonEmpty(payload.conversationId)
  if (!externalMessageId || !conversationId) {
    // Without these we can't route the message into a binding or dedupe it.
    options.logger?.warn(
      "dingtalk: dropping inbound payload missing msgId or conversationId"
    )
    return null
  }

  const conversationType = nonEmpty(payload.conversationType)
  const endpointType: "direct" | "group" =
    conversationType === "2" ? "group" : "direct"

  // Address externalId: prefer the published staffId (stable + usable for
  // direct OpenAPI fallback); fall back to senderId with a "senderId:"
  // prefix so we never accidentally hand it to the renderer's
  // `at.atUserIds` (which assumes its inputs are real staffIds).
  let senderExternalId: string
  let externalIdSource: "staffId" | "senderId"
  if (senderStaffId) {
    senderExternalId = senderStaffId
    externalIdSource = "staffId"
  } else if (senderId) {
    senderExternalId = `senderId:${senderId}`
    externalIdSource = "senderId"
  } else {
    options.logger?.warn(
      "dingtalk: dropping inbound payload missing both senderStaffId and senderId"
    )
    return null
  }

  const rawText = extractRawText(payload)
  const { mentions } = parseDingtalkMentions({
    rawText,
    atUsers: payload.atUsers,
    chatbotUserId,
    logger: options.logger,
  })

  const parts: CanonicalPart[] = []
  if (rawText) {
    parts.push({ type: "text", text: rawText })
  }
  const marker = placeholderFor(payload)
  if (marker) parts.push(marker)
  for (const m of mentions) {
    if (!m.externalId) continue
    parts.push({
      type: "mention",
      externalId: m.externalId,
      displayName: m.displayName || "User",
    })
  }
  const message: CanonicalMessage = buildCanonicalMessage(parts)

  const endpointMetadata: Record<string, unknown> = {
    robotCode: nonEmpty(payload.robotCode),
    chatbotUserId,
    conversationType,
  }
  const sessionWebhook = nonEmpty(payload.sessionWebhook)
  if (sessionWebhook) {
    endpointMetadata.sessionWebhook = sessionWebhook
    endpointMetadata.sessionWebhookObservedAt = nowIsoInstant()
    // Always write `sessionWebhookExpiredTime` (even as `null`) so a
    // stale value from a previous inbound doesn't leak across into the
    // outbound expiry check. The `transport_endpoints.metadata` upsert
    // uses a JSONB shallow merge (addresses.ts:470 `metadata || excluded`)
    // that wins keys from the new value — `null` here explicitly clears
    // a prior absolute timestamp that no longer applies.
    // `parseSessionWebhookExpiry(null)` returns undefined in outbound.ts,
    // which the gating logic treats as "unknown, try the webhook".
    const expiredTime = payload.sessionWebhookExpiredTime
    endpointMetadata.sessionWebhookExpiredTime = expiredTime ?? null
  }
  const openConversationId = nonEmpty(payload.openConversationId)
  if (openConversationId) {
    endpointMetadata.openConversationId = openConversationId
  }
  // Only write lastSenderStaffId when actually available — outbound.ts
  // treats absence as "single-chat OpenAPI fallback is impossible" and
  // throws a permanent-failure Error rather than guessing.
  if (senderStaffId) {
    endpointMetadata.lastSenderStaffId = senderStaffId
  }

  const senderMetadata: Record<string, unknown> = {
    senderId,
    nick: nonEmpty(payload.senderNick),
    corpId: nonEmpty(payload.senderCorpId),
    externalIdSource,
  }
  if (senderStaffId) {
    senderMetadata.staffId = senderStaffId
  }

  const createAtNum = asNumber(payload.createAt)
  const receivedAt = createAtNum
    ? dateToIsoInstant(new Date(createAtNum))
    : nowIsoInstant()

  return {
    endpointType,
    endpointExternalId: conversationId,
    endpointDisplayName: nonEmpty(payload.conversationTitle),
    externalMessageId,
    sender: {
      externalId: senderExternalId,
      displayName: nonEmpty(payload.senderNick),
      metadata: senderMetadata,
    },
    receivedAt,
    message,
    endpointMetadata,
    raw: {
      msgtype: payload.msgtype,
      isInAtList: payload.isInAtList,
      isAdmin: payload.isAdmin,
    },
  }
}
