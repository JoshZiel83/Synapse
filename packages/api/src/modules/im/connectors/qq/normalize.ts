/**
 * QQ inbound → CanonicalMessage normalization.
 *
 * Handles:
 *   - C2C_MESSAGE_CREATE   → endpoint=direct, sender=c2c:{user_openid}
 *   - GROUP_AT_MESSAGE_CREATE → endpoint=group, sender=gm:{group}:{member}
 *   - attachments[] → media `system_marker` placeholders (image / voice /
 *     video / file). This module stays PURE: the side-effecting
 *     `enrichInboundQqMedia` pass (inbound-media.ts) downloads the bytes
 *     into our content-addressed store and upgrades each placeholder to a
 *     real image/voice/video/file CanonicalPart carrying a `sha256`
 *     fileRef — which is what `service/inbound-message.ts` surfaces to the
 *     agent as a `file_ref` part. Until enrichment runs, the placeholder
 *     still renders as "[图片]" / "[文件]" in plainText.
 *   - Quoted/refIdx backfill — prepends a `quote` CanonicalPart by looking
 *     up cached refIdx state in Redis.
 *
 * Out of scope here:
 *   - INTERACTION_CREATE — button clicks (QQ delivers them over WebSocket
 *     only; see interaction-handler.ts).
 */

import { redis } from "../../../../infrastructure/redis/index.js"
import { createLogger } from "../../../../infrastructure/logger/index.js"
import {
  fromExternalRfc3339,
  fromUnixSeconds,
  serverReceiveInstant,
} from "@synapse/shared/datetime"
import type { Timestamp } from "@synapse/shared/types"
import {
  buildCanonicalMessage,
  textOnlyMessage,
  type CanonicalMessage,
  type CanonicalPart,
  type CanonicalSystemMarker,
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

/**
 * Convert a QQ inbound event time to a canonical instant. QQ message events
 * carry `timestamp` as an RFC3339 string (commonly with a numeric offset);
 * management events use integer Unix seconds. The value is parsed EXPLICITLY
 * via the canonical adapters (C1: one parser).
 *
 * datetime-ok: receivedAt is only a best-effort window heuristic (it feeds the
 * reply-quota window). Failing loud on a PRESENT-but-unparseable timestamp would
 * propagate up to inbound.ts, which replies `d:1` and makes QQ retry the SAME
 * poison payload forever (a retry storm). So instead of throwing we log and fall
 * back to the server-receive instant — an explicit, logged default (still C2:
 * not a silent now()). A genuinely absent timestamp uses server-receive too.
 */
function qqEventInstant(raw: unknown): Timestamp {
  if (raw == null) return serverReceiveInstant()
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      return fromExternalRfc3339(raw)
    } catch {
      log.warn({ raw }, "qq.event_time_unparseable")
      return serverReceiveInstant()
    }
  }
  if (typeof raw === "number") {
    try {
      return fromUnixSeconds(raw)
    } catch {
      log.warn({ raw }, "qq.event_time_unparseable")
      return serverReceiveInstant()
    }
  }
  // Present but neither a non-empty string nor a number (e.g. boolean/object).
  log.warn({ raw }, "qq.event_time_unparseable")
  return serverReceiveInstant()
}

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
  // Raw, untrusted wire value. QQ message events send an RFC3339 string (often
  // with a numeric offset); not a canonical instant. Converted at the boundary
  // via qqEventInstant() — never assigned the branded Timestamp directly.
  timestamp?: unknown
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
  // Raw, untrusted wire value. QQ message events send an RFC3339 string (often
  // with a numeric offset); not a canonical instant. Converted at the boundary
  // via qqEventInstant() — never assigned the branded Timestamp directly.
  timestamp?: unknown
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
  const parts = [
    ...(await buildPartsWithQuote({
      accountId: opts?.accountId,
      rawText: data.content ?? "",
      ext: data.message_scene?.ext,
    })),
    ...attachmentMediaParts(data.attachments),
  ]
  const message = buildCanonicalMessage(parts)

  // Stash this message in the ref-index cache so a future "user quotes
  // this one" event can recover the original content.
  await recordSelfRefIndex({
    accountId: opts?.accountId,
    ext: data.message_scene?.ext,
    content: textFromContent(data.content ?? ""),
    senderExternalId,
    timestamp: qqEventInstant(data.timestamp),
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
    receivedAt: qqEventInstant(data.timestamp),
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
  const parts = [
    ...(await buildPartsWithQuote({
      accountId: opts?.accountId,
      rawText: cleanedText,
      ext: data.message_scene?.ext,
    })),
    ...attachmentMediaParts(data.attachments),
  ]
  const message = buildCanonicalMessage(parts)

  await recordSelfRefIndex({
    accountId: opts?.accountId,
    ext: data.message_scene?.ext,
    content: textFromContent(cleanedText),
    senderExternalId,
    timestamp: qqEventInstant(data.timestamp),
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
    receivedAt: qqEventInstant(data.timestamp),
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

interface QqInboundAttachment {
  url?: unknown
  content_type?: unknown
  filename?: unknown
  size?: unknown
  width?: unknown
  height?: unknown
}

/**
 * Turn QQ inbound `attachments[]` into media `system_marker` placeholders.
 *
 * Pure + best-effort: an attachment without a usable `url` is skipped (it
 * can't be downloaded). The actual bytes are fetched + content-addressed by
 * the side-effecting `enrichInboundQqMedia` pass, which replaces each
 * placeholder with a real image/voice/video/file part. Keeping the raw
 * attachment object in `original` is what lets that pass recover the url +
 * content_type + filename without re-reading `envelope.raw`.
 */
function attachmentMediaParts(attachments: unknown): CanonicalPart[] {
  if (!Array.isArray(attachments)) return []
  const parts: CanonicalPart[] = []
  for (const raw of attachments) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const a = raw as QqInboundAttachment
    if (!trimmed(a.url)) continue
    parts.push({
      type: "system_marker",
      marker: markerForAttachment(a),
      original: raw as Record<string, unknown>,
    })
  }
  return parts
}

/**
 * Classify a QQ attachment into a media placeholder marker by its
 * `content_type` (a MIME-ish string) with a filename-extension fallback.
 */
function markerForAttachment(a: QqInboundAttachment): CanonicalSystemMarker {
  const ct =
    typeof a.content_type === "string" ? a.content_type.toLowerCase() : ""
  const name = typeof a.filename === "string" ? a.filename.toLowerCase() : ""
  if (
    ct.startsWith("image/") ||
    ct === "image" ||
    /\.(png|jpe?g|gif|webp|bmp|heic)$/.test(name)
  ) {
    return "image_placeholder"
  }
  if (
    ct.startsWith("video/") ||
    ct === "video" ||
    /\.(mp4|mov|avi|mkv|webm)$/.test(name)
  ) {
    return "video_placeholder"
  }
  if (
    ct.startsWith("audio/") ||
    ct.startsWith("voice") ||
    ct === "audio" ||
    /\.(silk|amr|mp3|m4a|wav|opus|ogg)$/.test(name)
  ) {
    return "voice_placeholder"
  }
  return "file_placeholder"
}
