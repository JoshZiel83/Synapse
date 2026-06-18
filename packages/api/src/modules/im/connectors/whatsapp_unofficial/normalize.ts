/**
 * PURE inbound normalization: a Baileys `WAMessage` → `InboundEnvelope`.
 *
 * No IO. Media parts come out as `system_marker` placeholders carrying the
 * original message content in `.original` so `media.ts` can later download the
 * decrypted bytes and project a real fileRef. Datetime uses `fromUnixSeconds`
 * (messageTimestamp is Unix SECONDS) per the strict datetime guard.
 *
 * Endpoint model:
 *   - direct (`@s.whatsapp.net` / `@lid`): endpoint = remoteJid, sender = remoteJid
 *   - group  (`@g.us`): endpoint = remoteJid (the group), sender = key.participant
 *   - `@broadcast` / `@newsletter` / status: dropped (returns null)
 *
 * Dedup: `externalMessageId = message.key.id` (stable, non-empty → enables the
 * DB unique-index dedup; a blank id silently disables dedup, so we drop blanks).
 */

import { fromUnixSeconds, serverReceiveInstant } from "@synapse/shared/datetime"
import {
  buildCanonicalMessage,
  type CanonicalMessage,
  type CanonicalPart,
} from "../../messaging/canonical-message.js"
import type { InboundEnvelope, ParsedInboundMention } from "../types.js"
import {
  classifyJid,
  coerceFileLength,
  endpointTypeForJid,
  jidUser,
  mediaKindForContentType,
  normalizeJid,
  WA_CONTENT,
  type WaMediaKind,
} from "./types.js"

// Minimal structural views over the Baileys proto (so this file stays pure +
// testable without importing the giant proto namespace at runtime).
export interface WaMessageKeyLike {
  id?: string | null
  remoteJid?: string | null
  fromMe?: boolean | null
  participant?: string | null
}

export interface WaContextInfoLike {
  stanzaId?: string | null
  participant?: string | null
  mentionedJid?: string[] | null
}

export interface WaMessageContentLike {
  conversation?: string | null
  extendedTextMessage?: {
    text?: string | null
    contextInfo?: WaContextInfoLike | null
  } | null
  imageMessage?: WaMediaContentLike | null
  videoMessage?: (WaMediaContentLike & { seconds?: number | null }) | null
  audioMessage?:
    | (WaMediaContentLike & { seconds?: number | null; ptt?: boolean | null })
    | null
  documentMessage?: (WaMediaContentLike & { fileName?: string | null }) | null
  stickerMessage?: WaMediaContentLike | null
  reactionMessage?: {
    text?: string | null
    key?: WaMessageKeyLike | null
  } | null
  [key: string]: unknown
}

export interface WaMediaContentLike {
  caption?: string | null
  mimetype?: string | null
  fileLength?: unknown
  fileName?: string | null
  contextInfo?: WaContextInfoLike | null
  width?: number | null
  height?: number | null
  seconds?: number | null
}

export interface WaMessageLike {
  key?: WaMessageKeyLike | null
  message?: WaMessageContentLike | null
  messageTimestamp?: number | { low: number; high: number } | string | null
  pushName?: string | null
}

/** Mirror Baileys' `getContentType`: the first message-content key present. */
export function pickContentType(
  content: WaMessageContentLike | null | undefined
): string | undefined {
  if (!content) return undefined
  for (const k of Object.keys(content)) {
    const v = content[k]
    if (v !== undefined && v !== null) return k
  }
  return undefined
}

function timestampToSeconds(
  value: WaMessageLike["messageTimestamp"]
): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  if (value && typeof value === "object" && "low" in value && "high" in value) {
    const n = value.high * 0x1_0000_0000 + (value.low >>> 0)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Outcome of normalization: an envelope plus the media keys to enrich. */
export interface NormalizedInbound {
  envelope: InboundEnvelope
  /**
   * Media parts (by index into `envelope.message.parts`) to download. The
   * media stage maps `system_marker` placeholders → real fileRefs in place.
   */
  mediaParts: Array<{ partIndex: number; kind: WaMediaKind }>
}

function mentionsFromContextInfo(
  ctx: WaContextInfoLike | null | undefined
): ParsedInboundMention[] {
  if (!ctx?.mentionedJid?.length) return []
  return ctx.mentionedJid.map((jid) => ({
    externalId: normalizeJid(jid),
    key: `@${jidUser(jid)}`,
  }))
}

function placeholderPart(
  kind: WaMediaKind,
  media: WaMediaContentLike
): CanonicalPart {
  const marker =
    kind === "image"
      ? "image_placeholder"
      : kind === "video"
        ? "video_placeholder"
        : kind === "audio"
          ? "voice_placeholder"
          : kind === "sticker"
            ? "image_placeholder"
            : "file_placeholder"
  return {
    type: "system_marker",
    marker,
    original: {
      kind,
      caption: media.caption ?? undefined,
      mimetype: media.mimetype ?? undefined,
      fileName: media.fileName ?? undefined,
      fileLength: coerceFileLength(media.fileLength),
      width: media.width ?? undefined,
      height: media.height ?? undefined,
      seconds: media.seconds ?? undefined,
    },
  }
}

/**
 * Normalize a single `messages.upsert` message. Returns null for messages we
 * do not ingest (fromMe, no id, broadcast/newsletter, empty/unknown content,
 * pure reactions — those are handled separately by the reaction path).
 */
export function normalizeWhatsappMessage(
  raw: WaMessageLike
): NormalizedInbound | null {
  const key = raw.key
  if (!key || key.fromMe) return null
  const messageId = typeof key.id === "string" ? key.id.trim() : ""
  if (!messageId) return null

  const remoteJid = normalizeJid(key.remoteJid)
  if (!remoteJid) return null
  const jidClass = classifyJid(remoteJid)
  if (jidClass === "broadcast" || jidClass === "other") return null

  const content = raw.message
  if (!content) return null
  const contentType = pickContentType(content)
  if (!contentType) return null
  // Pure reactions are not inbound messages in our model.
  if (contentType === WA_CONTENT.reaction) return null

  const endpointType = endpointTypeForJid(remoteJid)
  const senderJid =
    endpointType === "group"
      ? normalizeJid(key.participant) || remoteJid
      : remoteJid

  const parts: CanonicalPart[] = []
  const mediaParts: NormalizedInbound["mediaParts"] = []
  let mentions: ParsedInboundMention[] = []
  let replyToId: string | undefined

  if (contentType === WA_CONTENT.conversation) {
    const text = content.conversation ?? ""
    if (text) parts.push({ type: "text", text })
  } else if (contentType === WA_CONTENT.extendedText) {
    const ext = content.extendedTextMessage
    const text = ext?.text ?? ""
    mentions = mentionsFromContextInfo(ext?.contextInfo)
    replyToId = ext?.contextInfo?.stanzaId ?? undefined
    for (const m of mentions) {
      parts.push({
        type: "mention",
        externalId: m.externalId,
        displayName: m.key,
      })
    }
    if (text) parts.push({ type: "text", text })
  } else {
    const mediaKind = mediaKindForContentType(contentType)
    if (mediaKind) {
      const media = content[contentType] as WaMediaContentLike
      mentions = mentionsFromContextInfo(media?.contextInfo)
      replyToId = media?.contextInfo?.stanzaId ?? undefined
      const idx = parts.length
      parts.push(placeholderPart(mediaKind, media ?? {}))
      mediaParts.push({ partIndex: idx, kind: mediaKind })
      if (media?.caption) parts.push({ type: "text", text: media.caption })
    } else {
      // Unknown content — surface a generic placeholder so nothing is lost.
      parts.push({ type: "system_marker", marker: "unknown_placeholder" })
    }
  }

  if (parts.length === 0) return null

  const message: CanonicalMessage = buildCanonicalMessage(parts)

  const seconds = timestampToSeconds(raw.messageTimestamp)
  const receivedAt =
    seconds == null
      ? // datetime-ok: genuine no-event-time default (messageTimestamp absent).
        serverReceiveInstant()
      : fromUnixSeconds(seconds)

  const senderDisplayName =
    typeof raw.pushName === "string" && raw.pushName.trim()
      ? raw.pushName.trim()
      : undefined

  const envelope: InboundEnvelope = {
    endpointType,
    endpointExternalId: remoteJid,
    externalMessageId: messageId,
    sender: {
      externalId: senderJid,
      ...(senderDisplayName ? { displayName: senderDisplayName } : {}),
    },
    receivedAt,
    message,
    ...(replyToId ? { externalReplyToId: replyToId } : {}),
    raw: { remoteJid, contentType, jidClass },
  }

  return { envelope, mediaParts }
}

/**
 * `renderOutboundMention`: WhatsApp renders a mention as the literal
 * `@<number>` in the text, paired with the JID in `contextInfo.mentionedJid`
 * (the outbound builder collects the JIDs). Here we only produce the text
 * token; the builder reads `externalId` to populate `mentionedJid`.
 */
export function renderWhatsappMention(input: {
  externalId: string
  displayName: string
}): string {
  const num = jidUser(input.externalId)
  return num ? `@${num}` : `@${input.displayName}`
}

/** `parseInboundMentions`: pull mentions out of a raw mentionedJid list. */
export function parseWhatsappMentions(rawMentions: unknown): {
  text: string
  mentions: ParsedInboundMention[]
} {
  if (!Array.isArray(rawMentions)) return { text: "", mentions: [] }
  const mentions: ParsedInboundMention[] = []
  for (const jid of rawMentions) {
    if (typeof jid !== "string") continue
    mentions.push({ externalId: normalizeJid(jid), key: `@${jidUser(jid)}` })
  }
  return { text: "", mentions }
}
