/**
 * QQ text rendering (Stage 4).
 *
 * Walks a degraded CanonicalMessage and produces the bytes the QQ
 * outbound API expects. Stage 4 is text-only; Stage 5 extends with
 * media plans, Stage 8 with interaction_prompt.
 *
 * `planQqSends` returns an ordered list of "one POST" plans because
 * the QQ message envelope is single-message-type per request:
 *   - text → msg_type=0, content
 *   - markdown → msg_type=2, markdown.content
 *
 * Stage 4 always emits `msg_type=0` (plain text). A future revision
 * may opt into markdown when the message contains formatting hints,
 * but doing so changes platform-side rendering and asset URL handling
 * (see Stage 8 keyboard payload which requires markdown).
 *
 * Mentions are flattened to `@name` text by degradation (since
 * QQ_MESSAGE_CAPABILITIES.supportsMention is false in v1); we don't
 * see them here.
 *
 * `system_marker` placeholders contribute their label so the user
 * sees "[图片]" rather than the image disappearing.
 */

import type {
  CanonicalMessage,
  CanonicalPart,
} from "../../messaging/canonical-message.js"
import { QQ_MSG_TYPE } from "./types.js"

export type QqSendPlanItem = {
  /** msg_type sent to QQ — 0 (text) for Stage 4. */
  msgType: typeof QQ_MSG_TYPE.TEXT | typeof QQ_MSG_TYPE.MARKDOWN
  /** Body string — content for text, markdown.content for markdown. */
  content: string
}

export function planQqSends(msg: CanonicalMessage): QqSendPlanItem[] {
  const text = flattenToText(msg.parts)
  if (!text) return []
  return [{ msgType: QQ_MSG_TYPE.TEXT, content: text }]
}

function flattenToText(parts: CanonicalPart[]): string {
  const out: string[] = []
  for (const part of parts) {
    const piece = renderPart(part)
    if (piece) out.push(piece)
  }
  return out.join(" ").trim()
}

function renderPart(part: CanonicalPart): string {
  switch (part.type) {
    case "text":
      return part.text
    case "mention":
      // Degradation flattens mentions when supportsMention=false; if we
      // somehow see one through, fall back to "@name".
      return `@${part.displayName}`
    case "quote":
      return part.quoted.preview ? `> ${part.quoted.preview}` : ""
    case "system_marker":
      return part.label ?? labelForMarker(part.marker)
    case "interaction_prompt":
      // Stage 8 owns this; Stage 4 has capability false → degradation
      // already converted it to text. If we still see one, render the
      // fallback text inline.
      return part.title
        ? `${part.title}\n${part.fallbackText}`
        : part.fallbackText
    case "card":
      return part.fallbackText || "[卡片]"
    case "reaction":
      return part.emoji
    case "image":
    case "voice":
    case "video":
    case "file":
      // Stage 5 handles media as separate plan items + uploads; until
      // then degradation has already converted these to system_marker.
      return ""
  }
}

function labelForMarker(marker: string): string {
  switch (marker) {
    case "image_placeholder":
      return "[图片]"
    case "voice_placeholder":
      return "[语音]"
    case "video_placeholder":
      return "[视频]"
    case "file_placeholder":
      return "[文件]"
    case "card_placeholder":
      return "[卡片]"
    default:
      return "[消息]"
  }
}
