/**
 * QQ text + keyboard rendering (Stages 4, 5, 8).
 *
 * Walks a degraded CanonicalMessage and produces the bytes the QQ
 * outbound API expects.
 *
 * `planQqSends` returns an ordered list of "one POST" plans because
 * the QQ message envelope is single-message-type per request:
 *   - text → msg_type=0, content
 *   - markdown + keyboard → msg_type=2, markdown.content, keyboard (Stage 8)
 *   - media → msg_type=7 (Stage 5)
 *
 * Mentions are flattened to `@name` text by degradation (since
 * QQ_MESSAGE_CAPABILITIES.supportsMention is false in v1); we don't
 * see them here.
 *
 * `system_marker` placeholders contribute their label so the user
 * sees "[图片]" rather than the image disappearing.
 *
 * Stage 8 keyboard gate: even though the static capability descriptor
 * sets `supportsInteractionPrompt:true`, only `long_connection`
 * accounts actually receive button callbacks (QQ documents
 * INTERACTION_CREATE as WS-only). Webhook accounts receive the
 * fallback text — `planQqSends` accepts a `connectionMode` so the
 * caller can opt into either path explicitly. The default
 * (`connectionMode: undefined`) treats the message as text-only, which
 * matches the pre-Stage-8 behavior.
 */

import type {
  CanonicalFileRef,
  CanonicalMessage,
  CanonicalPart,
} from "../../messaging/canonical-message.js"
import {
  buildQqInteractionKeyboard,
  type QqKeyboardPayload,
} from "./keyboard.js"
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
  | {
      kind: "keyboard"
      msgType: typeof QQ_MSG_TYPE.MARKDOWN
      payload: QqKeyboardPayload
      /**
       * Fallback text that we used when building the markdown content;
       * the outbound layer surfaces it as `lastError` context if QQ
       * rejects the keyboard payload so dashboards can show what was
       * intended.
       */
      fallbackText: string
    }

export interface PlanQqSendsOptions {
  /**
   * When `"long_connection"`, interaction_prompt parts are rendered as
   * msg_type=2 keyboard payloads. Any other value (including undefined)
   * downgrades them to plain text using `fallbackText` — Stage 8
   * documents this as the WS-only gate for QQ button callbacks.
   */
  connectionMode?: string
}

/**
 * Plan one or more outbound POSTs from a CanonicalMessage. QQ's message
 * envelope is single-message-type per POST so a mixed text+image+voice
 * canonical message becomes (text, image, voice) plans in order.
 *
 * Stage 4 emitted text-only. Stage 5 adds image/voice/video/file plans
 * (one per media part). Stage 8 adds a keyboard plan when an
 * interaction_prompt part is found AND the caller signals
 * `connectionMode === "long_connection"`. Plans are ordered to match
 * canonical part order so the user sees them in the same sequence the
 * AI emitted.
 *
 * Mentions are flattened to `@name` text by degradation
 * (supportsMention=false in v1); media without fileRef.url/fileId is
 * dropped silently (canonical-encoding lossy fallback already saved
 * the canonicalParts so a future replay could recover it).
 */
export function planQqSends(
  msg: CanonicalMessage,
  options: PlanQqSendsOptions = {}
): QqSendPlanItem[] {
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
    if (
      part.type === "interaction_prompt" &&
      options.connectionMode === "long_connection"
    ) {
      flushText()
      items.push({
        kind: "keyboard",
        msgType: QQ_MSG_TYPE.MARKDOWN,
        payload: buildQqInteractionKeyboard({
          taskId: part.taskId,
          title: part.title,
          fallbackText: part.fallbackText,
          options: part.options.map((opt) => ({
            id: opt.id,
            label: opt.label,
            actionToken: opt.actionToken,
            style: opt.style,
          })),
        }),
        fallbackText: part.fallbackText,
      })
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
      // Webhook / unknown connectionMode fallback: render the part's
      // own fallbackText (mint-time pre-computed: includes deep link
      // when account.config.configuredUrlDomains contains the dashboard
      // domain, otherwise plain "go to dashboard" text).
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
