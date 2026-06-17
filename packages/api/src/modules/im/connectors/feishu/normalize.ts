/**
 * Feishu inbound event → CanonicalMessage.
 *
 * Pure. Translates the message body returned by im.message.receive_v1 into
 * the platform-neutral CanonicalMessage. Handles text, post (rich text),
 * image, audio, video, file message types (richer types degrade to
 * system_marker placeholders for now).
 */

import {
  buildCanonicalMessage,
  type CanonicalMessage,
  type CanonicalPart,
} from "../../messaging/canonical-message.js"
import {
  extractFeishuRawText,
  parseFeishuContentObject,
} from "./content-codec.js"
import { parseFeishuMentions, type RawFeishuMention } from "./mentions.js"

export interface FeishuMessageEvent {
  sender?: {
    sender_id?: {
      open_id?: string
      union_id?: string
      user_id?: string
    }
    sender_type?: string
  }
  message: {
    message_id: string
    create_time?: string
    chat_id: string
    chat_type?: string
    parent_id?: string
    thread_id?: string
    message_type: string
    content: string
    mentions?: RawFeishuMention[]
  }
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

export interface FeishuNormalizedEnvelope {
  endpointType: "direct" | "group"
  endpointExternalId: string
  externalMessageId: string
  externalReplyToId?: string
  externalThreadId?: string
  senderExternalId: string
  message: CanonicalMessage
  rawText: string
  raw: Record<string, unknown>
}

export function normalizeFeishuMessageEvent(
  event: FeishuMessageEvent
): FeishuNormalizedEnvelope | null {
  const msg = event.message
  if (!msg || !msg.message_id || !msg.chat_id) return null
  const senderExternalId =
    nonEmpty(event.sender?.sender_id?.open_id) ||
    nonEmpty(event.sender?.sender_id?.user_id) ||
    nonEmpty(event.sender?.sender_id?.union_id) ||
    ""
  if (!senderExternalId) return null

  const endpointType: "direct" | "group" =
    msg.chat_type === "p2p" ? "direct" : "group"

  const rawText = extractFeishuRawText(msg.message_type, msg.content)
  const { text } = parseFeishuMentions({
    rawText,
    rawMentions: msg.mentions,
  })

  const parts: CanonicalPart[] = []
  if (text) {
    parts.push({ type: "text", text })
  }

  // Place a system_marker for non-text payloads so downstream knows
  if (msg.message_type !== "text" && msg.message_type !== "post") {
    parts.push(messageTypeToMarker(msg.message_type, msg.content))
  }

  // Build mention parts after text so the resolver can address recipients
  if (Array.isArray(msg.mentions)) {
    for (const m of msg.mentions) {
      const externalId = nonEmpty(m.id?.open_id) || nonEmpty(m.id?.user_id)
      if (!externalId) continue
      parts.push({
        type: "mention",
        externalId,
        displayName: nonEmpty(m.name) || "User",
      })
    }
  }

  return {
    endpointType,
    endpointExternalId: msg.chat_id,
    externalMessageId: msg.message_id,
    externalReplyToId: nonEmpty(msg.parent_id),
    externalThreadId: nonEmpty(msg.thread_id),
    senderExternalId,
    message: buildCanonicalMessage(parts),
    rawText,
    raw: {
      messageType: msg.message_type,
      chatType: msg.chat_type,
      createTime: msg.create_time,
      parentId: msg.parent_id,
      threadId: msg.thread_id,
    },
  }
}

function messageTypeToMarker(
  messageType: string,
  content: string
): CanonicalPart {
  const original = parseFeishuContentObject(content)
  switch (messageType) {
    case "image":
      return { type: "system_marker", marker: "image_placeholder", original }
    case "audio":
      return { type: "system_marker", marker: "voice_placeholder", original }
    // Feishu's inbound video message_type is "media"; "video" never arrives
    // on im.message.receive_v1 but is kept as a harmless alias.
    case "media":
    case "video":
      return { type: "system_marker", marker: "video_placeholder", original }
    case "file":
      return { type: "system_marker", marker: "file_placeholder", original }
    default:
      return {
        type: "system_marker",
        marker: "unknown_placeholder",
        label: `[${messageType}]`,
        original,
      }
  }
}
