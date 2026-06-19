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

import { TELEGRAM_MAX_TEXT_LENGTH } from "./types.js"

/** Escape the three HTML-significant characters for `parse_mode: "HTML"`. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * Given a hard-cut index into the already-rendered HTML string, back the cut
 * off so it never lands inside an HTML entity (`&amp;`/`&lt;`/`&gt;`) or
 * inside a tag (`<a href=…>` / `</a>`). A chunk that ends mid-`&…;` or
 * mid-`<…>` is malformed HTML → Telegram 400 "can't parse entities".
 *
 * We scan backwards from `cut`: if the nearest unmatched `&` or `<` to the
 * left has no closing `;`/`>` at or before `cut`, the cut is inside that
 * run, so we move the cut to just before that opening char. Returns the
 * adjusted cut (≥ 0; the caller guarantees forward progress for the
 * pathological all-markup case by falling back to the raw cut).
 */
function backOffMarkupBoundary(text: string, cut: number): number {
  // Entity: find the last '&' before cut; if its terminating ';' is at or
  // after cut (or absent), the cut is inside the entity run.
  const amp = text.lastIndexOf("&", cut - 1)
  if (amp >= 0) {
    const semi = text.indexOf(";", amp)
    // A valid entity is short; if there is no ';' within a small window the
    // '&' is a literal (shouldn't happen post-escape) — leave the cut alone.
    if (semi === -1 || semi >= cut) {
      if (semi !== -1 && semi - amp <= 10) return amp
    }
  }
  // Tag: find the last '<' before cut; if its closing '>' is at or after cut
  // (or absent), the cut is inside the tag.
  const lt = text.lastIndexOf("<", cut - 1)
  if (lt >= 0) {
    const gt = text.indexOf(">", lt)
    if (gt === -1 || gt >= cut) return lt
  }
  return cut
}

/**
 * Split a (possibly very long) string into chunks each ≤ `limit` UTF-16
 * code units, preferring newline boundaries. Never splits a surrogate pair.
 *
 * NOTE: operates on the FINAL escaped/rendered string. The only markup we
 * emit is `&amp;`/`&lt;`/`&gt;` entities and `<a …>…</a>` mention anchors.
 * A hard cut that lands inside an entity run or a tag would emit malformed
 * HTML → Telegram 400. So after choosing a cut we back it off past any
 * unterminated `&…;` / `<…>` it lands inside (see backOffMarkupBoundary).
 * An anchor's `<a …>` and `</a>` are each guarded as tags; if a >limit line
 * is one giant anchor the cut still falls before `<a` and the whole anchor
 * stays in the next chunk.
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
    const newlineCut = cut > 0
    if (cut <= 0) cut = limit
    // Don't split a surrogate pair: a high surrogate at cut-1 means the cut
    // lands between the two halves — back off by one.
    const codeBefore = rest.charCodeAt(cut - 1)
    if (codeBefore >= 0xd800 && codeBefore <= 0xdbff) cut -= 1
    // Don't split inside an HTML entity or tag. A newline-boundary cut is
    // never inside markup (entities/tags contain no '\n'), so only the
    // hard-cut path needs this back-off.
    if (!newlineCut) {
      const adjusted = backOffMarkupBoundary(rest, cut)
      // Guarantee forward progress: only adopt the back-off if it leaves a
      // non-empty piece. A degenerate line that is markup from index 0 keeps
      // the raw cut (correctness already best-effort for such inputs).
      if (adjusted > 0) cut = adjusted
    }
    const piece = rest.slice(0, cut)
    chunks.push(piece)
    // Drop a single boundary newline so it isn't duplicated as leading ws.
    rest = rest.slice(cut).replace(/^\n/, "")
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}
