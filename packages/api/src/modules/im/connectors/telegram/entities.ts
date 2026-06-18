/**
 * Telegram text formatting + long-message splitting (PURE).
 *
 * We send with `parse_mode: "HTML"` (escape only `< > &`) rather than
 * MarkdownV2 (18 reserved chars). The only HTML we emit is the
 * `<a href="tg://user?id=…">name</a>` mention anchor from mentions.ts, so
 * everything else is plain escaped text.
 *
 * Splitting: Telegram caps a text message at 4096 UTF-16 code units and a
 * caption at 1024. We slice on newline boundaries where possible, and we
 * slice by UTF-16 code units (string `.length` / `.slice`) so a surrogate
 * pair (emoji) is never cut in half AND so the boundary matches Telegram's
 * own UTF-16 length accounting.
 */

import {
  TELEGRAM_MAX_CAPTION_LENGTH,
  TELEGRAM_MAX_TEXT_LENGTH,
} from "./types.js"

/** Escape the three HTML-significant characters for `parse_mode: "HTML"`. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * Split a (possibly very long) string into chunks each ≤ `limit` UTF-16
 * code units, preferring newline boundaries. Never splits a surrogate pair.
 *
 * NOTE: operates on the FINAL escaped/rendered string. Because the only
 * markup we emit is `<a …>…</a>` anchors that are themselves short and never
 * straddle a 4096-cap chunk in practice (mentions are inline words), we
 * split on raw boundaries; a chunk boundary that lands inside an anchor is
 * avoided by preferring newline cuts and only hard-cutting as a last resort.
 */
export function splitForLimit(
  text: string,
  limit: number = TELEGRAM_MAX_TEXT_LENGTH
): string[] {
  if (text.length <= limit) return text.length === 0 ? [] : [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    // Prefer the last newline within the limit window.
    let cut = rest.lastIndexOf("\n", limit)
    if (cut <= 0) cut = limit
    // Don't split a surrogate pair: a high surrogate at cut-1 means the cut
    // lands between the two halves — back off by one.
    const codeBefore = rest.charCodeAt(cut - 1)
    if (codeBefore >= 0xd800 && codeBefore <= 0xdbff) cut -= 1
    const piece = rest.slice(0, cut)
    chunks.push(piece)
    // Drop a single boundary newline so it isn't duplicated as leading ws.
    rest = rest.slice(cut).replace(/^\n/, "")
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/** Split a caption to the 1024 cap (first chunk is the caption; rest follow as text). */
export function splitCaption(text: string): {
  caption: string
  overflow: string[]
} {
  if (text.length <= TELEGRAM_MAX_CAPTION_LENGTH) {
    return { caption: text, overflow: [] }
  }
  const all = splitForLimit(text, TELEGRAM_MAX_CAPTION_LENGTH)
  const [caption, ...overflow] = all
  // The overflow tail is plain text — re-split at the text cap (always ≥ caption cap).
  const reflowed = overflow.flatMap((c) =>
    splitForLimit(c, TELEGRAM_MAX_TEXT_LENGTH)
  )
  return { caption: caption ?? "", overflow: reflowed }
}
