import test from "node:test"
import assert from "node:assert/strict"
import {
  collectAtUserIdsFromParts,
  parseDingtalkMentions,
  renderDingtalkMention,
} from "./mentions.js"
import type { CanonicalPart } from "../../messaging/canonical-message.js"

test("parseDingtalkMentions: mention with staffId is kept (externalId=staffId)", () => {
  const { mentions } = parseDingtalkMentions({
    rawText: "hi",
    atUsers: [{ dingtalkId: "ding-A", staffId: "alice" }],
    chatbotUserId: undefined,
  })
  assert.equal(mentions.length, 1)
  assert.equal(mentions[0].externalId, "alice")
  assert.equal(mentions[0].key, "staff:alice")
})

test("parseDingtalkMentions: mention without staffId is dropped + warned", () => {
  const warns: string[] = []
  const { mentions } = parseDingtalkMentions({
    rawText: "hi",
    atUsers: [{ dingtalkId: "ding-X" }],
    chatbotUserId: undefined,
    logger: { warn: (m) => warns.push(m) },
  })
  assert.equal(mentions.length, 0)
  assert.equal(warns.length, 1)
  assert.match(warns[0], /without staffId/)
})

test("parseDingtalkMentions: @bot self entry is filtered", () => {
  const { mentions } = parseDingtalkMentions({
    rawText: "hi",
    atUsers: [
      { dingtalkId: "ding-BOT", staffId: "bot-staff" },
      { dingtalkId: "ding-A", staffId: "alice" },
    ],
    chatbotUserId: "ding-BOT",
  })
  assert.equal(mentions.length, 1)
  assert.equal(mentions[0].externalId, "alice")
})

test("parseDingtalkMentions: empty input returns empty", () => {
  const { mentions, text } = parseDingtalkMentions({
    rawText: "",
    atUsers: undefined,
    chatbotUserId: undefined,
  })
  assert.equal(mentions.length, 0)
  assert.equal(text, "")
})

test("renderDingtalkMention: returns @<displayName>", () => {
  assert.equal(
    renderDingtalkMention({ externalId: "alice", displayName: "Alice" }),
    "@Alice"
  )
})

test("collectAtUserIdsFromParts: drops senderId-prefixed entries", () => {
  const parts: CanonicalPart[] = [
    { type: "text", text: "hi " },
    { type: "mention", externalId: "alice", displayName: "Alice" },
    { type: "mention", externalId: "senderId:42", displayName: "Anon" },
  ]
  assert.deepEqual(collectAtUserIdsFromParts(parts), ["alice"])
})

test("collectAtUserIdsFromParts: drops mentions without externalId", () => {
  const parts: CanonicalPart[] = [
    { type: "mention", displayName: "Bob" },
    { type: "mention", externalId: "carol", displayName: "Carol" },
  ]
  assert.deepEqual(collectAtUserIdsFromParts(parts), ["carol"])
})

test("collectAtUserIdsFromParts: deduplicates while preserving first-seen order", () => {
  const parts: CanonicalPart[] = [
    { type: "mention", externalId: "alice", displayName: "Alice" },
    { type: "mention", externalId: "bob", displayName: "Bob" },
    { type: "mention", externalId: "alice", displayName: "Alice" },
  ]
  assert.deepEqual(collectAtUserIdsFromParts(parts), ["alice", "bob"])
})
