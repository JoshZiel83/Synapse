/**
 * Telegram outbound rendering (PURE).
 *
 * Walks a DEGRADED CanonicalMessage and produces an ordered list of send
 * items, one per Bot API call. Telegram is single-attachment-per-message, so
 * a mixed text+image+voice message becomes (text, photo, voice) items in
 * canonical order. Only the FIRST item carries the reply parameters.
 *
 * Text is rendered as HTML (escape < > &) with `<a href="tg://user?id=…">`
 * mention anchors inlined. Long text is split at 4096 (caption 1024) on
 * newline boundaries (see entities.ts) → multiple text items.
 */

import type {
  CanonicalFileRef,
  CanonicalMessage,
  CanonicalPart,
} from "../../messaging/canonical-message.js"
import { escapeHtml, splitForLimit } from "./entities.js"
import { renderTelegramMention } from "./mentions.js"

// NOTE: media items carry NO caption. Telegram captions are intentionally
// unused: a mixed text+media CanonicalMessage is planned as ordered, separate
// items (text item then photo item) rather than a captioned photo. The old
// `caption` field + `splitCaption` helper were dead code (renderMediaPart
// never set a caption, so outbound always forwarded `undefined`) and were
// removed. Re-adding captions would mean deciding which adjacent text becomes
// the caption (≤1024) vs a trailing text item — deferred, not wired.
export type TelegramSendItem =
  | { kind: "text"; html: string }
  | { kind: "photo"; fileRef: CanonicalFileRef }
  | {
      kind: "voice"
      fileRef: CanonicalFileRef
      durationSec?: number
    }
  | {
      kind: "video"
      fileRef: CanonicalFileRef
      durationSec?: number
      width?: number
      height?: number
    }
  | { kind: "document"; fileRef: CanonicalFileRef }

/** Plan ordered Telegram sends from a degraded CanonicalMessage. */
export function planTelegramSends(msg: CanonicalMessage): TelegramSendItem[] {
  const items: TelegramSendItem[] = []
  let textBuf: string[] = []

  const flushText = () => {
    const joined = textBuf.join("").trim()
    textBuf = []
    if (!joined) return
    for (const chunk of splitForLimit(joined)) {
      if (chunk.trim()) items.push({ kind: "text", html: chunk })
    }
  }

  for (const part of msg.parts) {
    const media = renderMediaPart(part)
    if (media) {
      flushText()
      items.push(media)
      continue
    }
    const piece = renderTextPart(part)
    if (piece) textBuf.push(piece)
  }
  flushText()
  return items
}

function renderMediaPart(part: CanonicalPart): TelegramSendItem | null {
  switch (part.type) {
    case "image":
      if (!part.fileRef.sha256) return null
      return { kind: "photo", fileRef: part.fileRef }
    case "voice":
      if (!part.fileRef.sha256) return null
      return {
        kind: "voice",
        fileRef: part.fileRef,
        ...(part.durationMs != null
          ? { durationSec: Math.round(part.durationMs / 1000) }
          : {}),
      }
    case "video":
      if (!part.fileRef.sha256) return null
      return {
        kind: "video",
        fileRef: part.fileRef,
        ...(part.durationMs != null
          ? { durationSec: Math.round(part.durationMs / 1000) }
          : {}),
        ...(part.width != null ? { width: part.width } : {}),
        ...(part.height != null ? { height: part.height } : {}),
      }
    case "file":
      if (!part.fileRef.sha256) return null
      return { kind: "document", fileRef: part.fileRef }
    default:
      return null
  }
}

/** Render a part's text contribution as HTML (escaped). Empty string = skip. */
function renderTextPart(part: CanonicalPart): string {
  switch (part.type) {
    case "text":
      return escapeHtml(part.text)
    case "mention":
      return renderTelegramMention({
        externalId: part.externalId ?? "",
        displayName: part.displayName,
      })
    case "quote":
      return part.quoted.preview
        ? `&gt; ${escapeHtml(part.quoted.preview)}\n`
        : ""
    case "system_marker":
      return escapeHtml(part.label ?? labelForMarker(part.marker))
    case "interaction_prompt":
      return part.title
        ? `${escapeHtml(part.title)}\n${escapeHtml(part.fallbackText)}`
        : escapeHtml(part.fallbackText)
    case "card":
      return escapeHtml(part.fallbackText || "[card]")
    case "reaction":
      return escapeHtml(part.emoji)
    case "image":
    case "voice":
    case "video":
    case "file":
      return ""
  }
}

function labelForMarker(marker: string): string {
  switch (marker) {
    case "image_placeholder":
      return "[image]"
    case "voice_placeholder":
      return "[voice]"
    case "video_placeholder":
      return "[video]"
    case "file_placeholder":
      return "[file]"
    case "card_placeholder":
      return "[card]"
    default:
      return "[message]"
  }
}
