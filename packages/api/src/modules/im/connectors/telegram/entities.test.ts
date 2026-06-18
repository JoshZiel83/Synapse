import test from "node:test"
import assert from "node:assert/strict"
import { escapeHtml, splitCaption, splitForLimit } from "./entities.js"

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

test("splitCaption: <=1024 returns whole as caption", () => {
  const { caption, overflow } = splitCaption("short")
  assert.equal(caption, "short")
  assert.deepEqual(overflow, [])
})

test("splitCaption: long caption splits off overflow", () => {
  const text = "x".repeat(1500)
  const { caption, overflow } = splitCaption(text)
  assert.equal(caption.length, 1024)
  assert.ok(overflow.length >= 1)
  assert.equal(caption + overflow.join(""), text)
})
