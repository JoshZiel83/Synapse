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
  CanonicalFileRef,
  CanonicalMessage,
  CanonicalPart,
} from "../../messaging/canonical-message.js"
import { QQ_FILE_TYPE, type QqFileType } from "./media-constants.js"
import { QQ_MSG_TYPE } from "./types.js"

export type QqSendPlanItem =
  | {
      kind: "text"
      msgType: typeof QQ_MSG_TYPE.TEXT | typeof QQ_MSG_TYPE.MARKDOWN
      content: string
    }
  | {
      kind: "media"
      msgType: typeof QQ_MSG_TYPE.MEDIA
      fileType: QqFileType
      fileRef: CanonicalFileRef
    }

/**
 * Plan one or more outbound POSTs from a CanonicalMessage. QQ's message
 * envelope is single-message-type per POST so a mixed text+image+voice
 * canonical message becomes (text, image, voice) plans in order.
 *
 * Stage 4 emitted text-only. Stage 5 adds image/voice/video/file plans
 * (one per media part). Plans are ordered to match canonical part
 * order so the user sees them in the same sequence the AI emitted.
 *
 * Mentions are flattened to `@name` text by degradation
 * (supportsMention=false in v1); media without fileRef.url/fileId is
 * dropped silently (canonical-encoding lossy fallback already saved
 * the canonicalParts so a future replay could recover it).
 */
export function planQqSends(msg: CanonicalMessage): QqSendPlanItem[] {
  const items: QqSendPlanItem[] = []
  let textBuf: string[] = []

  const flushText = () => {
    const text = textBuf.join(" ").trim()
    textBuf = []
    if (text) {
      items.push({ kind: "text", msgType: QQ_MSG_TYPE.TEXT, content: text })
    }
  }

  for (const part of msg.parts) {
    const mediaItem = renderMediaPart(part)
    if (mediaItem) {
      flushText()
      items.push(mediaItem)
      continue
    }
    const piece = renderTextPart(part)
    if (piece) textBuf.push(piece)
  }
  flushText()
  return items
}

function renderMediaPart(part: CanonicalPart): QqSendPlanItem | null {
  switch (part.type) {
    case "image":
      return mediaPlanForRef(part.fileRef, QQ_FILE_TYPE.IMAGE)
    case "voice":
      return mediaPlanForRef(part.fileRef, QQ_FILE_TYPE.VOICE)
    case "video":
      return mediaPlanForRef(part.fileRef, QQ_FILE_TYPE.VIDEO)
    case "file":
      return mediaPlanForRef(part.fileRef, QQ_FILE_TYPE.FILE)
    default:
      return null
  }
}

function mediaPlanForRef(
  fileRef: CanonicalFileRef,
  fileType: QqFileType
): QqSendPlanItem | null {
  if (!fileRef.url && !fileRef.fileId) return null
  return {
    kind: "media",
    msgType: QQ_MSG_TYPE.MEDIA,
    fileType,
    fileRef,
  }
}

function renderTextPart(part: CanonicalPart): string {
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
      // Stage 8 owns this; until then degradation converts it to text.
      // If we still see one, render the fallback text inline.
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
      // Handled by renderMediaPart; never contributes to the text buf.
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
