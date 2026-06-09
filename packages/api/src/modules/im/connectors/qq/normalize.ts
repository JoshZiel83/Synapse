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

import { redis } from "../../../../infrastructure/redis/index.js"
import { createLogger } from "../../../../infrastructure/logger/index.js"
import { nowIsoInstant } from "@synapse/shared/datetime"
import type { Timestamp } from "@synapse/shared/types"
import {
  buildCanonicalMessage,
  textOnlyMessage,
  type CanonicalMessage,
  type CanonicalPart,
} from "../../messaging/canonical-message.js"
import type { InboundEnvelope } from "../types.js"
import {
  encodeDirectEndpointExternalId,
  encodeGroupEndpointExternalId,
  encodeSenderExternalId,
} from "./address-encoding.js"
import {
  getRefIndexEntry,
  parseRefIndices,
  setRefIndexEntry,
} from "./ref-index.js"

const log = createLogger("im.qq")

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
  timestamp?: Timestamp
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
  timestamp?: Timestamp
  attachments?: unknown[]
}

/**
 * Normalize a C2C_MESSAGE_CREATE payload into an InboundEnvelope.
 * Returns null when required fields are missing (logged at the call
 * site).
 *
 * If `accountId` is supplied, this function ALSO:
 *   - reads `message_scene.ext` for ref_msg_idx; if present + cached,
 *     prepends a `quote` CanonicalPart with the original sender/content
 *     so the AI has the referenced context
 *   - writes a new ref-index entry keyed by `msg_idx` so a future
 *     "user quotes this message" event can recover the original
 *
 * Without `accountId`, ref-index lookups/writes are skipped (back-
 * compat for callers that already plumb the envelope themselves).
 */
export async function normalizeQqC2cMessage(
  data: QqC2cMessageEventData,
  opts?: { accountId?: string }
): Promise<InboundEnvelope | null> {
  const msgId = trimmed(data.id)
  const userOpenid = trimmed(data.author?.user_openid)
  if (!msgId || !userOpenid) return null

  const senderExternalId = encodeSenderExternalId({
    kind: "c2c",
    userOpenid,
  })
  const parts = await buildPartsWithQuote({
    accountId: opts?.accountId,
    rawText: data.content ?? "",
    ext: data.message_scene?.ext,
  })
  const message =
    parts.length === 0
      ? buildCanonicalMessage([])
      : buildCanonicalMessage(parts)

  // Stash this message in the ref-index cache so a future "user quotes
  // this one" event can recover the original content.
  await recordSelfRefIndex({
    accountId: opts?.accountId,
    ext: data.message_scene?.ext,
    content: textFromContent(data.content ?? ""),
    senderExternalId,
    timestamp: data.timestamp ?? nowIsoInstant(),
  })

  return {
    endpointType: "direct",
    endpointExternalId: encodeDirectEndpointExternalId(userOpenid),
    externalMessageId: msgId,
    sender: {
      externalId: senderExternalId,
      metadata: {
        userOpenid,
        unionOpenid: trimmed(data.author?.union_openid),
      },
    },
    receivedAt: data.timestamp ?? nowIsoInstant(),
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
 *
 * Same `accountId`-driven ref-index behavior as C2C.
 */
export async function normalizeQqGroupAtMessage(
  data: QqGroupAtMessageEventData,
  opts?: { accountId?: string }
): Promise<InboundEnvelope | null> {
  const msgId = trimmed(data.id)
  const groupOpenid = trimmed(data.group_openid)
  const memberOpenid = trimmed(data.author?.member_openid)
  if (!msgId || !groupOpenid || !memberOpenid) return null

  const senderExternalId = encodeSenderExternalId({
    kind: "group_member",
    groupOpenid,
    memberOpenid,
  })
  const cleanedText = stripLeadingMention(data.content ?? "")
  const parts = await buildPartsWithQuote({
    accountId: opts?.accountId,
    rawText: cleanedText,
    ext: data.message_scene?.ext,
  })
  const message =
    parts.length === 0
      ? buildCanonicalMessage([])
      : buildCanonicalMessage(parts)

  await recordSelfRefIndex({
    accountId: opts?.accountId,
    ext: data.message_scene?.ext,
    content: textFromContent(cleanedText),
    senderExternalId,
    timestamp: data.timestamp ?? nowIsoInstant(),
  })

  return {
    endpointType: "group",
    endpointExternalId: encodeGroupEndpointExternalId(groupOpenid),
    externalMessageId: msgId,
    sender: {
      externalId: senderExternalId,
      metadata: {
        memberOpenid,
        groupOpenid,
        unionOpenid: trimmed(data.author?.union_openid),
      },
    },
    receivedAt: data.timestamp ?? nowIsoInstant(),
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

function textFromContent(raw: string): string {
  return raw.trim()
}

/**
 * Build canonical parts from raw content, optionally prepending a
 * `quote` part recovered from the ref-index cache.
 */
async function buildPartsWithQuote(params: {
  accountId: string | undefined
  rawText: string
  ext: unknown
}): Promise<CanonicalPart[]> {
  const parts: CanonicalPart[] = []
  if (params.accountId) {
    const { refMsgIdx } = parseRefIndices({ ext: params.ext })
    if (refMsgIdx) {
      const entry = await getRefIndexEntry(redis, {
        accountId: params.accountId,
        refIdx: refMsgIdx,
      }).catch(() => null)
      if (entry) {
        parts.push({
          type: "quote",
          quoted: {
            preview: entry.content.slice(0, 500),
          },
        })
      }
    }
  }
  const text = textFromContent(params.rawText)
  if (text) parts.push({ type: "text", text })
  return parts
}

/**
 * Stash this message in the ref-index cache so a future "user quotes
 * this message" event can recover its content. No-op when accountId or
 * msg_idx is missing.
 */
async function recordSelfRefIndex(params: {
  accountId: string | undefined
  ext: unknown
  content: string
  senderExternalId: string
  timestamp: Timestamp
}): Promise<void> {
  if (!params.accountId) return
  const { msgIdx } = parseRefIndices({ ext: params.ext })
  if (!msgIdx) return
  await setRefIndexEntry(redis, {
    accountId: params.accountId,
    refIdx: msgIdx,
    entry: {
      content: params.content,
      senderId: params.senderExternalId,
      timestamp: params.timestamp,
    },
  }).catch((err) => {
    // Logging only — losing ref-index is recoverable, the original
    // message still emits.
    log.warn(
      { err },
      `[im:qq] failed to write ref-index for account ${params.accountId}`
    )
  })
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
