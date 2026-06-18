/**
 * Telegram inbound normalization (PURE).
 *
 * Turns a `Message` (from a long-poll Update or a webhook POST) into an
 * `InboundEnvelope` carrying a `CanonicalMessage`. Media (photo/voice/audio/
 * video/video_note/document/animation/sticker) become `system_marker`
 * placeholders that stash the raw `{file_id, file_unique_id, mime, name,
 * duration, width, height}` in `.original`; the side-effecting `inbound-media.ts`
 * pass downloads them and replaces the placeholder with a real media part.
 *
 *   - `externalMessageId` = `String(message.message_id)` (NOT update_id).
 *     Keyed with `chat.id` (the endpoint external id). Dedup-on-`update_id`
 *     happens in the handler/loop, not here.
 *   - `receivedAt` = `fromUnixSeconds(message.date)` (Telegram `date` is Unix
 *     SECONDS) → an IsoInstantString. The datetime guard is strict.
 *   - endpointType `direct` for `private` chats, else `group`
 *     (group/supergroup); channels are out of v1 scope but still classified
 *     as `group` so they never crash normalization.
 */

import { fromUnixSeconds } from "@synapse/shared/datetime"
import {
  buildCanonicalMessage,
  type CanonicalMessage,
  type CanonicalPart,
} from "../../messaging/canonical-message.js"
import type { InboundEnvelope } from "../types.js"
import { parseTelegramMentions } from "./mentions.js"
import type {
  TelegramFileMeta,
  TelegramMessage,
  TelegramPhotoSize,
} from "./types.js"

/** Pick the largest PhotoSize (highest pixel area) from a photo array. */
function largestPhoto(
  photos: TelegramPhotoSize[]
): TelegramPhotoSize | undefined {
  let best: TelegramPhotoSize | undefined
  for (const p of photos) {
    const area = (p.width || 0) * (p.height || 0)
    const bestArea = best ? (best.width || 0) * (best.height || 0) : -1
    if (!best || area > bestArea) best = p
  }
  return best
}

/** Build the `.original` blob a media placeholder carries for the enrich pass. */
function mediaOriginal(
  file: { file_id: string; file_unique_id: string },
  extra: Record<string, unknown>
): Record<string, unknown> {
  return {
    file_id: file.file_id,
    file_unique_id: file.file_unique_id,
    ...extra,
  }
}

/** Map a Telegram message's media field to a single `system_marker` part. */
function mediaPart(message: TelegramMessage): CanonicalPart | null {
  if (message.photo && message.photo.length > 0) {
    const p = largestPhoto(message.photo)
    if (!p) return null
    return {
      type: "system_marker",
      marker: "image_placeholder",
      original: mediaOriginal(p, {
        mime: "image/jpeg",
        width: p.width,
        height: p.height,
        size: p.file_size,
      }),
    }
  }
  const voice = message.voice
  if (voice) {
    return {
      type: "system_marker",
      marker: "voice_placeholder",
      original: mediaOriginal(voice, {
        mime: voice.mime_type || "audio/ogg",
        duration: voice.duration,
        name: "voice.ogg",
      }),
    }
  }
  const audio = message.audio
  if (audio) {
    return {
      type: "system_marker",
      marker: "voice_placeholder",
      original: mediaOriginal(audio, {
        mime: audio.mime_type || "audio/mpeg",
        duration: audio.duration,
        name: audio.file_name || "audio",
      }),
    }
  }
  const video = message.video
  if (video) {
    return {
      type: "system_marker",
      marker: "video_placeholder",
      original: mediaOriginal(video, {
        mime: video.mime_type || "video/mp4",
        duration: video.duration,
        width: video.width,
        height: video.height,
        name: video.file_name || "video.mp4",
      }),
    }
  }
  const videoNote = message.video_note
  if (videoNote) {
    return {
      type: "system_marker",
      marker: "video_placeholder",
      original: mediaOriginal(videoNote, {
        mime: "video/mp4",
        duration: videoNote.duration,
        name: "video_note.mp4",
      }),
    }
  }
  const animation = message.animation
  if (animation) {
    return {
      type: "system_marker",
      marker: "video_placeholder",
      original: mediaOriginal(animation, {
        mime: animation.mime_type || "video/mp4",
        width: animation.width,
        height: animation.height,
        name: animation.file_name || "animation.mp4",
      }),
    }
  }
  const sticker = message.sticker
  if (sticker) {
    // Only static WEBP stickers are downloadable as an image; animated TGS /
    // video WEBM are skipped at the enrich stage (kept as placeholder).
    return {
      type: "system_marker",
      marker: "image_placeholder",
      label: "[sticker]",
      original: mediaOriginal(sticker, {
        mime: "image/webp",
        width: sticker.width,
        height: sticker.height,
        is_animated: sticker.is_animated === true,
        is_video: sticker.is_video === true,
        name: "sticker.webp",
      }),
    }
  }
  const doc = message.document
  if (doc) {
    return {
      type: "system_marker",
      marker: "file_placeholder",
      original: mediaOriginal(doc, {
        mime: doc.mime_type || "application/octet-stream",
        name: doc.file_name || "file",
        size: doc.file_size,
      }),
    }
  }
  return null
}

/** Build the CanonicalMessage parts: mentions + text + at most one media part. */
function buildMessage(message: TelegramMessage): CanonicalMessage {
  const parts: CanonicalPart[] = []
  const text = message.text ?? message.caption ?? ""
  const entities = message.entities ?? message.caption_entities

  if (text) {
    const { mentions } = parseTelegramMentions({
      rawText: text,
      rawMentions: entities,
    })
    // Emit mention parts first (so agent visibility records them), then the
    // text verbatim — Telegram text already inlines the @handle/name.
    for (const m of mentions) {
      parts.push({
        type: "mention",
        externalId: m.externalId,
        displayName: m.displayName ?? m.key,
      })
    }
    parts.push({ type: "text", text })
  }

  const media = mediaPart(message)
  if (media) parts.push(media)

  return buildCanonicalMessage(parts)
}

function senderName(message: TelegramMessage): string | undefined {
  const from = message.from
  if (!from) return undefined
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ")
  return name || from.username || String(from.id)
}

function endpointDisplayName(message: TelegramMessage): string | undefined {
  const chat = message.chat
  if (chat.type === "private") {
    return (
      [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
      chat.username ||
      undefined
    )
  }
  return chat.title || chat.username || undefined
}

/**
 * Normalize a Telegram message into an InboundEnvelope. Returns null for
 * messages we can't address (no chat) or that carry no usable content.
 */
export function normalizeTelegramMessage(
  message: TelegramMessage
): InboundEnvelope | null {
  if (!message || typeof message.message_id !== "number" || !message.chat) {
    return null
  }
  const chat = message.chat
  const endpointType = chat.type === "private" ? "direct" : "group"
  const canonical = buildMessage(message)
  // Drop truly empty messages (e.g. a service event we don't model) so we
  // don't emit a contentless envelope.
  if (canonical.parts.length === 0) return null

  const sender = message.from
  const envelope: InboundEnvelope = {
    endpointType,
    endpointExternalId: String(chat.id),
    externalMessageId: String(message.message_id),
    receivedAt: fromUnixSeconds(message.date),
    sender: {
      externalId: sender ? String(sender.id) : String(chat.id),
      ...(senderName(message) ? { displayName: senderName(message) } : {}),
      metadata: sender
        ? {
            isBot: sender.is_bot === true,
            ...(sender.username ? { username: sender.username } : {}),
          }
        : {},
    },
    message: canonical,
    raw: { chatType: chat.type },
  }
  const displayName = endpointDisplayName(message)
  if (displayName) envelope.endpointDisplayName = displayName
  if (message.reply_to_message) {
    envelope.externalReplyToId = String(message.reply_to_message.message_id)
  }
  return envelope
}
