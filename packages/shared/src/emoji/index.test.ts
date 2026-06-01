import { test } from "node:test"
import assert from "node:assert/strict"

import { getTwemojiUrl, TWEMOJI_ASSET_BASE } from "./index.js"

const svg = (cp: string) => `${TWEMOJI_ASSET_BASE}svg/${cp}.svg`

test("getTwemojiUrl maps representative emoji to their v14 asset code points", () => {
  assert.equal(getTwemojiUrl("😀"), svg("1f600"))
  assert.equal(getTwemojiUrl("👍"), svg("1f44d"))
  assert.equal(getTwemojiUrl("🇨🇳"), svg("1f1e8-1f1f3"))
  // keycap / variation-selector forms keep FE0F (matches convert.toCodePoint)
  assert.equal(getTwemojiUrl("❤️"), svg("2764-fe0f"))
  assert.equal(getTwemojiUrl("1️⃣"), svg("31-fe0f-20e3"))
  // ZWJ sequence
  assert.equal(
    getTwemojiUrl("👨‍👩‍👧‍👦"),
    svg("1f468-200d-1f469-200d-1f467-200d-1f466")
  )
})

test("getTwemojiUrl trims surrounding whitespace", () => {
  assert.equal(getTwemojiUrl("  🔥  "), svg("1f525"))
})

test("getTwemojiUrl returns null for non-emoji / empty input", () => {
  assert.equal(getTwemojiUrl(""), null)
  assert.equal(getTwemojiUrl(null), null)
  assert.equal(getTwemojiUrl(undefined), null)
  assert.equal(getTwemojiUrl("张三"), null)
  assert.equal(getTwemojiUrl("Alice"), null)
  assert.equal(getTwemojiUrl("123"), null)
})
