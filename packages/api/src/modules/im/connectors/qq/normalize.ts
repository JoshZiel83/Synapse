/**
 * QQ inbound → CanonicalMessage normalization (Stage 2 — text only).
 *
 * Stage 2 handles:
 *   - C2C_MESSAGE_CREATE   → endpoint=direct, sender=c2c:{user_openid}
 *   - GROUP_AT_MESSAGE_CREATE → endpoint=group, sender=gm:{group}:{member}
 *
 * Out of scope here (deferred):
 *   - Quoted/refIdx backfill — Stage 7 enriches messages with a `quote`
 *     CanonicalPart by looking up cached refIdx state in Redis.
 *   - Attachments — Stage 5 downloads + ingests to the files service +
 *     emits image/voice/video/file parts.
 *   - INTERACTION_CREATE — Stage 8 handles button clicks; webhook
 *     never carries these (QQ delivers them via WebSocket only).
 */

import {
  buildCanonicalMessage,
  textOnlyMessage,
  type CanonicalMessage,
} from "../../messaging/canonical-message.js"
import type { InboundEnvelope } from "../types.js"
import {
  encodeDirectEndpointExternalId,
  encodeGroupEndpointExternalId,
  encodeSenderExternalId,
} from "./address-encoding.js"

interface QqAuthor {
  user_openid?: string
  member_openid?: string
  union_openid?: string
}

interface QqMessageScene {
  ext?: string[]
}

export interface QqC2cMessageEventData {
  id: string
  author?: QqAuthor
  content?: string
  message_scene?: QqMessageScene
  message_type?: number
  timestamp?: string
  attachments?: unknown[]
}

export interface QqGroupAtMessageEventData {
  id: string
  group_openid?: string
  author?: QqAuthor
  content?: string
  mentions?: unknown[]
  message_scene?: QqMessageScene
  message_type?: number
  timestamp?: string
  attachments?: unknown[]
}

/**
 * Normalize a C2C_MESSAGE_CREATE payload into an InboundEnvelope.
 * Returns null when required fields are missing (logged at the call
 * site).
 */
export function normalizeQqC2cMessage(
  data: QqC2cMessageEventData
): InboundEnvelope | null {
  const msgId = trimmed(data.id)
  const userOpenid = trimmed(data.author?.user_openid)
  if (!msgId || !userOpenid) return null

  const message = bodyToCanonical(data.content ?? "")
  return {
    endpointType: "direct",
    endpointExternalId: encodeDirectEndpointExternalId(userOpenid),
    externalMessageId: msgId,
    sender: {
      externalId: encodeSenderExternalId({
        kind: "c2c",
        userOpenid,
      }),
      metadata: {
        userOpenid,
        unionOpenid: trimmed(data.author?.union_openid),
      },
    },
    receivedAt: data.timestamp ?? new Date().toISOString(),
    message,
    raw: {
      messageType: data.message_type,
      messageScene: data.message_scene,
      attachments: data.attachments,
    },
  }
}

/**
 * Normalize a GROUP_AT_MESSAGE_CREATE payload. Group sender external_id
 * encodes (group_openid, member_openid) so the same human in two groups
 * does not collide.
 */
export function normalizeQqGroupAtMessage(
  data: QqGroupAtMessageEventData
): InboundEnvelope | null {
  const msgId = trimmed(data.id)
  const groupOpenid = trimmed(data.group_openid)
  const memberOpenid = trimmed(data.author?.member_openid)
  if (!msgId || !groupOpenid || !memberOpenid) return null

  const message = bodyToCanonical(stripLeadingMention(data.content ?? ""))
  return {
    endpointType: "group",
    endpointExternalId: encodeGroupEndpointExternalId(groupOpenid),
    externalMessageId: msgId,
    sender: {
      externalId: encodeSenderExternalId({
        kind: "group_member",
        groupOpenid,
        memberOpenid,
      }),
      metadata: {
        memberOpenid,
        groupOpenid,
        unionOpenid: trimmed(data.author?.union_openid),
      },
    },
    receivedAt: data.timestamp ?? new Date().toISOString(),
    message,
    endpointMetadata: { groupOpenid },
    raw: {
      messageType: data.message_type,
      messageScene: data.message_scene,
      mentions: data.mentions,
      attachments: data.attachments,
    },
  }
}

function trimmed(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

function bodyToCanonical(raw: string): CanonicalMessage {
  const text = raw.trim()
  if (!text) return buildCanonicalMessage([])
  return textOnlyMessage(text)
}

/**
 * Group @-bot events deliver `content` with a leading `<@bot_openid>` /
 * literal `@BotName ` prefix that we want to strip before passing to
 * the AI. Heuristic for Stage 2: drop the leading "<@…>" token and any
 * whitespace that follows it. Stage 4.5 will replace this with proper
 * mention parsing once the `mentions[]` array drives the canonical
 * `mention` part.
 */
function stripLeadingMention(content: string): string {
  return content.replace(/^\s*<@[^>]+>\s*/u, "")
}
