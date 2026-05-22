/**
 * Render a CanonicalMessage to a Feishu outbound payload.
 *
 * V1: text and interactive cards. Other parts degrade to text via
 * messaging/degradation.ts before reaching here.
 *
 * Returns the body shape that the Lark SDK's im.message.create expects.
 */

import type { CanonicalMessage } from "../../messaging/canonical-message.js"
import { renderFeishuMention } from "./mentions.js"

export type FeishuMessageType = "text" | "interactive"

export interface FeishuRenderedMessage {
  msg_type: FeishuMessageType
  content: string
}

/**
 * Render a degraded CanonicalMessage to a Feishu outbound payload.
 * Card parts take precedence (only one card per message in V1).
 *
 * Caller is responsible for running degradation first if the platform's
 * caps differ from Feishu's.
 */
export function renderFeishuMessage(
  msg: CanonicalMessage
): FeishuRenderedMessage {
  // Card priority: if any card part, send as interactive
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
 * Render the message's parts as a single text string with Feishu mention
 * markup inlined. Mention parts get rendered as <at>; text parts pass through;
 * quote becomes a "> " prefix; system_marker uses its label.
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
      // image/file/card/reaction: degradation should have handled
      default:
        break
    }
  }
  return fragments.join(" ").trim()
}
