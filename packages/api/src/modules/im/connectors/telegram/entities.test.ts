import test from "node:test"
import assert from "node:assert/strict"
import { escapeHtml, splitForLimit } from "./entities.js"

test("escapeHtml: escapes < > & only", () => {
  assert.equal(escapeHtml("a < b & c > d"), "a &lt; b &amp; c &gt; d")
  assert.equal(escapeHtml('"quote" stays'), '"quote" stays')
})

test("splitForLimit: short string is one chunk", () => {
  assert.deepEqual(splitForLimit("hello", 10), ["hello"])
  assert.deepEqual(splitForLimit("", 10), [])
})

test("splitForLimit: prefers newline boundaries", () => {
  const text = "line1\nline2\nline3"
  const chunks = splitForLimit(text, 8)
  // First cut at the newline within 8 cols -> "line1"
  assert.equal(chunks[0], "line1")
  assert.ok(chunks.every((c) => c.length <= 8))
})

test("splitForLimit: hard-cuts when no newline within window", () => {
  const text = "abcdefghijklmnop"
  const chunks = splitForLimit(text, 5)
  assert.deepEqual(chunks, ["abcde", "fghij", "klmno", "p"])
})

test("splitForLimit: never splits a surrogate pair", () => {
  // 😀 is a surrogate pair (2 UTF-16 code units). Limit 3 would land mid-pair.
  const text = "a😀b😀c"
  const chunks = splitForLimit(text, 3)
  for (const c of chunks) {
    // No chunk should start or end with a lone surrogate.
    const first = c.charCodeAt(0)
    const last = c.charCodeAt(c.length - 1)
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), "no leading low surrogate")
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), "no trailing high surrogate")
  }
  assert.equal(chunks.join(""), text.replace(/\n/g, ""))
})

/** A chunk is markup-safe iff it has no unterminated `&…;` entity and no
 *  unbalanced `<…>` tag at its boundary (Telegram parse_mode:HTML would 400). */
function assertNoBrokenMarkup(chunk: string): void {
  // No dangling '&' without a following ';' inside the chunk.
  const lastAmp = chunk.lastIndexOf("&")
  if (lastAmp !== -1) {
    assert.ok(
      chunk.indexOf(";", lastAmp) !== -1,
      `chunk ends mid-entity: …${chunk.slice(-12)}`
    )
  }
  // No '<' without a matching '>' after it (open tag at the boundary).
  const lastLt = chunk.lastIndexOf("<")
  const lastGt = chunk.lastIndexOf(">")
  assert.ok(lastLt <= lastGt, `chunk ends inside a tag: …${chunk.slice(-16)}`)
}

test("splitForLimit: never cuts mid-entity on a long newline-free line", () => {
  // Build a >limit line where the hard cut at `limit` lands inside `&amp;`.
  // Filler of length limit-2, then "&amp;" so the cut (at limit) is between
  // '&am' and 'p;'. The OLD splitter sliced raw → "…&am" (broken). The fix
  // backs the cut off to before '&'.
  const limit = 20
  const filler = "a".repeat(limit - 2) // 18 'a's
  const text = `${filler}&amp;${"b".repeat(limit)}` // forces a cut inside &amp;
  const chunks = splitForLimit(text, limit)
  for (const c of chunks) assertNoBrokenMarkup(c)
  // Lossless: chunks rejoin to the original (no newline dropping here).
  assert.equal(chunks.join(""), text)
})

test("splitForLimit: never cuts inside an <a> anchor straddling the cap", () => {
  const limit = 30
  // Put the anchor so the raw cut at `limit` lands inside the opening tag.
  const lead = "x".repeat(limit - 5)
  const anchor = '<a href="tg://user?id=42">name</a>'
  const text = lead + anchor + "y".repeat(limit)
  const chunks = splitForLimit(text, limit)
  for (const c of chunks) assertNoBrokenMarkup(c)
  assert.equal(chunks.join(""), text)
})

test("splitForLimit: real >4096 escaped line with mention at the boundary stays valid", () => {
  // Mimic render output: escaped text + an anchor whose start sits right at
  // index 4096 in a single newline-free line.
  const head = "&lt;".repeat(1024) // 4096 units of escaped '<'
  const anchor = '<a href="tg://user?id=7">u</a>'
  const text = head + anchor + "&amp;".repeat(2000)
  const chunks = splitForLimit(text) // default 4096 cap
  assert.ok(chunks.length >= 2)
  for (const c of chunks) {
    assert.ok(c.length <= 4096)
    assertNoBrokenMarkup(c)
  }
  assert.equal(chunks.join(""), text)
})
