import test from "node:test"
import assert from "node:assert/strict"
import { parseTelegramMentions, renderTelegramMention } from "./mentions.js"

test("parseTelegramMentions: text_mention carries user object", () => {
  const text = "hi Bob there"
  const { mentions } = parseTelegramMentions({
    rawText: text,
    rawMentions: [
      {
        type: "text_mention",
        offset: 3,
        length: 3,
        user: { id: 42, first_name: "Bob" },
      },
    ],
  })
  assert.equal(mentions.length, 1)
  assert.deepEqual(mentions[0], {
    externalId: "42",
    displayName: "Bob",
    key: "Bob",
  })
})

test("parseTelegramMentions: @username mention", () => {
  const text = "ping @alice now"
  const { mentions } = parseTelegramMentions({
    rawText: text,
    rawMentions: [{ type: "mention", offset: 5, length: 6 }],
  })
  assert.equal(mentions.length, 1)
  assert.equal(mentions[0].externalId, "alice")
  assert.equal(mentions[0].displayName, "@alice")
})

test("parseTelegramMentions: non-array mentions => empty", () => {
  const { mentions, text } = parseTelegramMentions({
    rawText: "x",
    rawMentions: undefined,
  })
  assert.deepEqual(mentions, [])
  assert.equal(text, "x")
})

test("renderTelegramMention: numeric id => tg://user anchor (HTML-escaped name)", () => {
  const html = renderTelegramMention({ externalId: "42", displayName: "A<b>" })
  assert.equal(html, '<a href="tg://user?id=42">A&lt;b&gt;</a>')
})

test("renderTelegramMention: non-numeric id => @handle", () => {
  assert.equal(
    renderTelegramMention({ externalId: "alice", displayName: "Alice" }),
    "@alice"
  )
  assert.equal(
    renderTelegramMention({ externalId: "@bob", displayName: "Bob" }),
    "@bob"
  )
})
