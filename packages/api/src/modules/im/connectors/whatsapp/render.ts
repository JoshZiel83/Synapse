/**
 * WhatsApp Cloud outbound rendering. PURE.
 *
 * `planWhatsappSends(degradedMessage)` walks a DEGRADED CanonicalMessage and
 * produces an ordered list of "one POST" plan items, because the Cloud API
 * message envelope is single-type per request:
 *   - text     → { type:"text", text:{ body } }
 *   - image    → { type:"image", image:{ id } }    (media_id resolved later)
 *   - voice    → { type:"audio", audio:{ id, voice } }
 *   - video    → { type:"video", video:{ id } }
 *   - file     → { type:"document", document:{ id, filename } }
 *   - reaction → { type:"reaction", reaction:{ message_id, emoji } }
 *
 * Mentions are flattened to "@name" text by degradation (supportsMention is
 * false for Cloud API). `interaction_prompt` / card likewise degrade to text
 * before this runs.
 *
 * Reply (`replyTo`) is attached to the FIRST send item only (via the
 * caller-supplied `replyToExternalId`) so a multi-part reply quotes the
 * inbound once. The render stays pure: it does not resolve media bytes →
 * media_id (outbound.ts does that), it just emits the upload/send intent.
 */

import type {
  CanonicalFileRef,
  CanonicalMessage,
  CanonicalPart,
} from "../../messaging/canonical-message.js"
import type { WhatsappMediaCategory } from "./types.js"

export type WhatsappSendPlanItem =
  | { kind: "text"; text: string }
  | {
      kind: "media"
      category: WhatsappMediaCategory
      /** WhatsApp message `type` field for this media. */
      messageType: "image" | "audio" | "video" | "document"
      fileRef: CanonicalFileRef
      /** audio voice-note flag (ptt). */
      voice?: boolean
      /** filename for documents. */
      filename?: string
    }
  | {
      kind: "reaction"
      targetExternalMessageId: string
      /** empty string removes the reaction. */
      emoji: string
    }

function mediaItemForPart(part: CanonicalPart): WhatsappSendPlanItem | null {
  switch (part.type) {
    case "image":
      if (!part.fileRef.sha256) return null
      return {
        kind: "media",
        category: "image",
        messageType: "image",
        fileRef: part.fileRef,
      }
    case "voice":
      if (!part.fileRef.sha256) return null
      return {
        kind: "media",
        category: "audio",
        messageType: "audio",
        fileRef: part.fileRef,
        voice: true,
      }
    case "video":
      if (!part.fileRef.sha256) return null
      return {
        kind: "media",
        category: "video",
        messageType: "video",
        fileRef: part.fileRef,
      }
    case "file":
      if (!part.fileRef.sha256) return null
      return {
        kind: "media",
        category: "document",
        messageType: "document",
        fileRef: part.fileRef,
        filename: part.fileRef.name,
      }
    default:
      return null
  }
}

function textForPart(part: CanonicalPart): string {
  switch (part.type) {
    case "text":
      return part.text
    case "mention":
      return `@${part.displayName}`
    case "quote":
      return part.quoted.preview ? `> ${part.quoted.preview}` : ""
    case "system_marker":
      return part.label ?? ""
    case "card":
      return part.fallbackText || ""
    case "interaction_prompt":
      return part.title
        ? `${part.title}\n${part.fallbackText}`
        : part.fallbackText
    default:
      return ""
  }
}

/**
 * Plan one or more outbound sends from a degraded CanonicalMessage. Adjacent
 * text parts coalesce into a single text send; each media part is its own
 * send; reactions are their own send. Order matches canonical part order.
 */
export function planWhatsappSends(
  msg: CanonicalMessage
): WhatsappSendPlanItem[] {
  const items: WhatsappSendPlanItem[] = []
  let textBuf: string[] = []

  const flushText = () => {
    const text = textBuf.join(" ").trim()
    textBuf = []
    if (text) items.push({ kind: "text", text })
  }

  for (const part of msg.parts) {
    if (part.type === "reaction") {
      flushText()
      if (part.target.externalMessageId) {
        items.push({
          kind: "reaction",
          targetExternalMessageId: part.target.externalMessageId,
          emoji: part.emoji,
        })
      }
      continue
    }
    const media = mediaItemForPart(part)
    if (media) {
      flushText()
      items.push(media)
      continue
    }
    const piece = textForPart(part)
    if (piece) textBuf.push(piece)
  }
  flushText()
  return items
}
