/**
 * Telegram mention plumbing (PURE).
 *
 * Inbound: a `text_mention` entity carries the mentioned `user` object
 * directly (id + name); a `mention` entity (`@username`) carries only the
 * `@handle` slice of the text. We surface both as `ParsedInboundMention`s.
 *
 * Outbound: `renderTelegramMention` produces an HTML anchor
 * `<a href="tg://user?id=ID">name</a>` when we have a numeric user id (works
 * even without a public username), else falls back to `@username`/`name`.
 * The anchor is emitted into HTML `parse_mode` text by render.ts/entities.ts.
 */

import type { OutboundMentionInput, ParsedInboundMention } from "../types.js"
import type { TelegramMessageEntity } from "./types.js"
import { escapeHtml } from "./entities.js"

/**
 * Parse inbound mentions from a message's entities. `rawText` is the message
 * text; `rawMentions` is the `MessageEntity[]` array (loosely typed by the
 * connector contract).
 */
export function parseTelegramMentions(input: {
  rawText: string
  rawMentions: unknown
}): { text: string; mentions: ParsedInboundMention[] } {
  const entities = Array.isArray(input.rawMentions)
    ? (input.rawMentions as TelegramMessageEntity[])
    : []
  const mentions: ParsedInboundMention[] = []
  for (const e of entities) {
    if (e.type === "text_mention" && e.user) {
      const displayName = [e.user.first_name, e.user.last_name]
        .filter(Boolean)
        .join(" ")
      mentions.push({
        externalId: String(e.user.id),
        displayName: displayName || e.user.username || String(e.user.id),
        // The placeholder key is the exact text slice this entity covers.
        key: sliceUtf16(input.rawText, e.offset, e.length),
      })
    } else if (e.type === "mention") {
      const handle = sliceUtf16(input.rawText, e.offset, e.length) // includes leading "@"
      mentions.push({
        // No numeric id from a @username mention — use the handle as the id.
        externalId: handle.replace(/^@/, ""),
        displayName: handle,
        key: handle,
      })
    }
  }
  return { text: input.rawText, mentions }
}

/** Render an outbound mention as HTML. Numeric id → tg://user deep link. */
export function renderTelegramMention(input: OutboundMentionInput): string {
  const name = escapeHtml(input.displayName || "")
  if (/^\d+$/.test(input.externalId)) {
    return `<a href="tg://user?id=${input.externalId}">${name}</a>`
  }
  // Non-numeric id → assume it's a username handle.
  const handle = input.externalId.replace(/^@/, "")
  return handle ? `@${handle}` : name
}

/** UTF-16-correct slice (entity offsets are UTF-16 code units). */
function sliceUtf16(text: string, offset: number, length: number): string {
  return text.slice(offset, offset + length)
}
