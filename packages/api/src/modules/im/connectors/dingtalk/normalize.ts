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

function extractRawText(payload: DingtalkInboundPayload): string {
  if (payload.msgtype === "text") {
    return nonEmpty(payload.text?.content) ?? ""
  }
  if (payload.msgtype === "markdown") {
    const fromText = nonEmpty(payload.text?.content)
    if (fromText) return fromText
    const fromContent = nonEmpty(
      (payload.content as { text?: string } | undefined)?.text
    )
    if (fromContent) return fromContent
    return "[markdown]"
  }
  if (!payload.msgtype) return ""
  switch (payload.msgtype) {
    case "picture":
      return "[图片]"
    case "audio":
      return "[语音]"
    case "video":
      return "[视频]"
    case "file":
      return "[文件]"
    case "richText":
      return "[富文本]"
    default:
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
      return {
        type: "system_marker",
        marker: "unknown_placeholder",
        label: "[富文本]",
        original: payload.content,
      }
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
  // Bot self-message filter (both fields; soimy reference checks both
  // because senderStaffId may be undefined for unpublished dev apps).
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
    endpointMetadata.sessionWebhookObservedAt = new Date().toISOString()
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
    ? new Date(createAtNum).toISOString()
    : new Date().toISOString()

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
