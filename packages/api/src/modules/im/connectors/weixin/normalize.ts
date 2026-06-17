/**
 * Personal-WeChat (ilinkai) inbound message normalization.
 *
 * The ilink protocol sends array `item_list` per message; each item is
 * one of text/voice/image/file/video. We collapse to the first non-empty
 * text/voice transcription and emit a system_marker for richer types.
 */

import {
  buildCanonicalMessage,
  type CanonicalMessage,
  type CanonicalPart,
} from "../../messaging/canonical-message.js"
import { WEIXIN_ITEM_TYPE } from "./protocol.js"

/** ilink CDN media reference (image/voice/file/video item `media` field). */
export interface WeixinCdnMedia {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  full_url?: string
}

export interface WeixinMessageItem {
  type?: number
  msg_id?: string
  text_item?: { text?: string }
  voice_item?: { text?: string; media?: WeixinCdnMedia }
  /** `aeskey` (hex) is preferred over media.aes_key for image decryption. */
  image_item?: { media?: WeixinCdnMedia; aeskey?: string }
  file_item?: { media?: WeixinCdnMedia; file_name?: string }
  video_item?: { media?: WeixinCdnMedia }
}

/**
 * Build the `original` payload stashed on a media placeholder so the inbound
 * enrich pass (inbound-media.ts) can download + decrypt the bytes. Returns
 * undefined when the item has no downloadable CDN reference.
 */
function mediaOriginal(
  kind: "image" | "file" | "video",
  media: WeixinCdnMedia | undefined,
  extra?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!media) return undefined
  const encryptQueryParam = nonEmpty(media.encrypt_query_param)
  const fullUrl = nonEmpty(media.full_url)
  if (!encryptQueryParam && !fullUrl) return undefined
  return {
    kind,
    encrypt_query_param: encryptQueryParam,
    full_url: fullUrl,
    aes_key: nonEmpty(media.aes_key),
    ...extra,
  }
}

export interface WeixinMessage {
  message_id?: number
  from_user_id?: string
  create_time_ms?: number
  item_list?: WeixinMessageItem[]
  context_token?: string
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

export interface WeixinNormalizedEnvelope {
  endpointType: "direct"
  endpointExternalId: string
  externalMessageId: string
  senderExternalId: string
  message: CanonicalMessage
  rawText: string
  raw: Record<string, unknown>
  contextToken?: string
}

export function normalizeWeixinMessage(
  message: WeixinMessage
): WeixinNormalizedEnvelope | null {
  const senderExternalId = nonEmpty(message.from_user_id)
  if (!senderExternalId) return null

  const itemMessageId =
    message.item_list?.map((i) => nonEmpty(i.msg_id)).find(Boolean) ||
    String(message.message_id || "")
  const externalMessageId = nonEmpty(itemMessageId)
  if (!externalMessageId) return null

  const items = message.item_list || []
  const parts: CanonicalPart[] = []
  let firstText: string | undefined
  for (const item of items) {
    const text = nonEmpty(item.text_item?.text)
    if (text) {
      parts.push({ type: "text", text })
      firstText = firstText || text
      continue
    }
    const voiceText = nonEmpty(item.voice_item?.text)
    if (voiceText) {
      parts.push({
        type: "system_marker",
        marker: "voice_placeholder",
        label: `[语音] ${voiceText}`,
        original: { type: "voice", text: voiceText },
      })
      firstText = firstText || `[语音] ${voiceText}`
      continue
    }
    if (item.type === WEIXIN_ITEM_TYPE.IMAGE) {
      parts.push({
        type: "system_marker",
        marker: "image_placeholder",
        original: mediaOriginal("image", item.image_item?.media, {
          aeskey_hex: nonEmpty(item.image_item?.aeskey),
        }),
      })
      firstText = firstText || "[图片]"
      continue
    }
    if (item.type === WEIXIN_ITEM_TYPE.VOICE) {
      // Voice audio is SILK-encoded; we surface only the STT transcript (above)
      // and never download the raw audio. Leave a bare placeholder otherwise.
      parts.push({ type: "system_marker", marker: "voice_placeholder" })
      firstText = firstText || "[语音]"
      continue
    }
    if (item.type === WEIXIN_ITEM_TYPE.FILE) {
      parts.push({
        type: "system_marker",
        marker: "file_placeholder",
        original: mediaOriginal("file", item.file_item?.media, {
          file_name: nonEmpty(item.file_item?.file_name),
        }),
      })
      firstText = firstText || "[文件]"
      continue
    }
    if (item.type === WEIXIN_ITEM_TYPE.VIDEO) {
      parts.push({
        type: "system_marker",
        marker: "video_placeholder",
        original: mediaOriginal("video", item.video_item?.media),
      })
      firstText = firstText || "[视频]"
      continue
    }
  }
  if (parts.length === 0) {
    parts.push({
      type: "system_marker",
      marker: "unknown_placeholder",
      label: "[微信消息]",
    })
    firstText = "[微信消息]"
  }

  return {
    endpointType: "direct",
    endpointExternalId: senderExternalId,
    externalMessageId,
    senderExternalId,
    message: buildCanonicalMessage(parts),
    rawText: firstText || "",
    raw: {
      createTimeMs: message.create_time_ms,
      contextToken: nonEmpty(message.context_token),
    },
    contextToken: nonEmpty(message.context_token),
  }
}
