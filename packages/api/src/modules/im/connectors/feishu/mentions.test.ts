import test from "node:test"
import assert from "node:assert/strict"
import { parseFeishuMentions, renderFeishuMention } from "./mentions.js"

test("returns text unchanged when no mentions", () => {
  const r = parseFeishuMentions({ rawText: "hello", rawMentions: null })
  assert.equal(r.text, "hello")
  assert.deepEqual(r.mentions, [])
})

test("replaces @_user_1 placeholder with <at> tag", () => {
  const r = parseFeishuMentions({
    rawText: "@_user_1 你好",
    rawMentions: [{ key: "@_user_1", id: { open_id: "ou_a" }, name: "Alice" }],
  })
  assert.equal(r.text, '<at user_id="ou_a">Alice</at> 你好')
  assert.deepEqual(r.mentions, [
    { externalId: "ou_a", displayName: "Alice", key: "@_user_1" },
  ])
})

test("uses user_id when open_id missing", () => {
  const r = parseFeishuMentions({
    rawText: "ping @_user_1",
    rawMentions: [{ key: "@_user_1", id: { user_id: "uid_x" }, name: "Bob" }],
  })
  assert.equal(r.text, 'ping <at user_id="uid_x">Bob</at>')
})

test("falls back to @name when no id present", () => {
  const r = parseFeishuMentions({
    rawText: "@_user_1",
    rawMentions: [{ key: "@_user_1", id: {}, name: "Carol" }],
  })
  assert.equal(r.text, "@Carol")
  // Mention list excludes entries without externalId
  assert.deepEqual(r.mentions, [])
})

test("deduplicates by externalId", () => {
  const r = parseFeishuMentions({
    rawText: "@_user_1 and @_user_2",
    rawMentions: [
      { key: "@_user_1", id: { open_id: "ou_a" }, name: "Alice" },
      { key: "@_user_2", id: { open_id: "ou_a" }, name: "AliceAgain" },
    ],
  })
  // Both placeholders get replaced; mention list has one entry
  assert.equal(r.mentions.length, 1)
  assert.ok(r.text.includes("Alice"))
  assert.ok(r.text.includes("AliceAgain"))
})

test("trims surrounding whitespace", () => {
  const r = parseFeishuMentions({
    rawText: "  hello  ",
    rawMentions: [],
  })
  assert.equal(r.text, "hello")
})

test("ignores malformed mentions array", () => {
  const r = parseFeishuMentions({
    rawText: "x",
    rawMentions: ["string-not-object"],
  })
  assert.equal(r.text, "x")
  assert.deepEqual(r.mentions, [])
})

test("renderFeishuMention emits XML-like tag", () => {
  assert.equal(
    renderFeishuMention({ externalId: "ou_x", displayName: "Bob" }),
    '<at user_id="ou_x">Bob</at>'
  )
})
