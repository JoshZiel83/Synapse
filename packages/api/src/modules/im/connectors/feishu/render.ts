/**
 * Plan a CanonicalMessage into one or more Feishu outbound payloads.
 *
 * Feishu's `im.message.create` accepts exactly one msg_type per call.
 * A CanonicalMessage with mixed text + image + file therefore turns
 * into a small ordered sequence of sends. This module produces the
 * plan (one entry per send); the outbound dispatcher in outbound.ts
 * executes them.
 *
 * Rules (in priority order):
 *
 *   1. Card parts are exclusive — if any card is present, emit a
 *      single `interactive` send and ignore other parts. (Feishu cards
 *      cannot be mixed with text/image in one message anyway.)
 *   2. Otherwise:
 *        - If text/mention/quote/system_marker collapse into non-empty
 *          text, emit a `text` send first.
 *        - Then one `image` send per image part, in order.
 *        - Then one `file` send per file part, in order.
 *
 * Returns an empty plan if none of the above apply (e.g. message
 * contains only reaction parts, which are routed through the
 * status-reaction adapter, not outbound send).
 */

import type {
  CanonicalFileRef,
  CanonicalMessage,
} from "../../messaging/canonical-message.js"
import { renderFeishuMention } from "./mentions.js"

export type FeishuMessageType = "text" | "interactive" | "image" | "file"

export type FeishuSendPlanItem =
  | { kind: "text"; content: string }
  | { kind: "interactive"; payload: Record<string, unknown> }
  | { kind: "image"; fileRef: CanonicalFileRef }
  | { kind: "file"; fileRef: CanonicalFileRef & { name: string } }

export interface FeishuRenderedMessage {
  msg_type: FeishuMessageType
  content: string
}

/**
 * Legacy single-message renderer. Kept because mention/render unit
 * tests still rely on the text-with-mentions path; new outbound flow
 * uses `planFeishuSends` instead.
 */
export function renderFeishuMessage(
  msg: CanonicalMessage
): FeishuRenderedMessage {
  const card = msg.parts.find((p) => p.type === "card")
  if (card && card.type === "card") {
    return {
      msg_type: "interactive",
      content: JSON.stringify(card.payload),
    }
  }
  const text = renderTextWithMentions(msg)
  return {
    msg_type: "text",
    content: JSON.stringify({ text: text || "[消息]" }),
  }
}

/**
 * Plan a CanonicalMessage into the ordered list of Feishu sends that
 * will deliver it. See module doc for ordering rules.
 */
export function planFeishuSends(msg: CanonicalMessage): FeishuSendPlanItem[] {
  // Card takes the whole message.
  const card = msg.parts.find((p) => p.type === "card")
  if (card && card.type === "card") {
    return [{ kind: "interactive", payload: card.payload }]
  }

  const items: FeishuSendPlanItem[] = []

  const text = renderTextWithMentions(msg)
  if (text) {
    items.push({ kind: "text", content: text })
  }

  for (const part of msg.parts) {
    if (part.type === "image") {
      items.push({ kind: "image", fileRef: part.fileRef })
    } else if (part.type === "file") {
      items.push({
        kind: "file",
        fileRef: part.fileRef,
      })
    }
  }

  return items
}

/**
 * Render the message's text-equivalent parts (text/mention/quote/
 * system_marker) as a single line with Feishu `<at>` mention markup
 * inlined. Image, file, card, and reaction parts are NOT serialized
 * here — they're handled separately by planFeishuSends.
 */
export function renderTextWithMentions(msg: CanonicalMessage): string {
  const fragments: string[] = []
  for (const part of msg.parts) {
    switch (part.type) {
      case "text":
        if (part.text) fragments.push(part.text)
        break
      case "mention":
        if (part.externalId) {
          fragments.push(
            renderFeishuMention({
              externalId: part.externalId,
              displayName: part.displayName || "User",
            })
          )
        } else {
          fragments.push(`@${part.displayName || "User"}`)
        }
        break
      case "quote":
        if (part.quoted.preview) {
          fragments.push(`> ${part.quoted.preview}`)
        }
        break
      case "system_marker":
        if (part.label) fragments.push(part.label)
        break
      // image / file / card / reaction are NOT inlined as text — they
      // become separate sends or are dropped entirely.
      default:
        break
    }
  }
  return fragments.join(" ").trim()
}
