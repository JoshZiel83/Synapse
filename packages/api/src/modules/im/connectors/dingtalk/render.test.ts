import test from "node:test"
import assert from "node:assert/strict"
import { renderOpenApiPayload, renderSessionWebhookPayload } from "./render.js"
import { buildCanonicalMessage } from "../../messaging/canonical-message.js"

test("renderSessionWebhookPayload: text-only body with derived title", () => {
  const msg = buildCanonicalMessage([{ type: "text", text: "hello world" }])
  const body = renderSessionWebhookPayload(msg)
  assert.equal(body.msgtype, "markdown")
  assert.equal(body.markdown?.text, "hello world")
  assert.equal(body.markdown?.title, "hello world")
  assert.deepEqual(body.at, { atUserIds: [], isAtAll: false })
})

test("renderSessionWebhookPayload: collects mention staffIds into atUserIds", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "ping " },
    { type: "mention", externalId: "alice", displayName: "Alice" },
    { type: "text", text: " and " },
    { type: "mention", externalId: "bob", displayName: "Bob" },
  ])
  const body = renderSessionWebhookPayload(msg)
  assert.deepEqual(body.at?.atUserIds, ["alice", "bob"])
})

test("renderSessionWebhookPayload: filters senderId:-prefixed mentions out of at-array", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "ping " },
    { type: "mention", externalId: "alice", displayName: "Alice" },
    { type: "mention", externalId: "senderId:42", displayName: "Anon" },
  ])
  const body = renderSessionWebhookPayload(msg)
  assert.deepEqual(body.at?.atUserIds, ["alice"])
  // The @<displayName> text placeholder for the dropped mention is still
  // visible in the markdown body so the message reads naturally.
  assert.match(body.markdown?.text ?? "", /@Anon/)
})

test("renderSessionWebhookPayload: undefined externalId mentions filtered too", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "ping " },
    { type: "mention", displayName: "Unresolved" },
    { type: "mention", externalId: "carol", displayName: "Carol" },
  ])
  const body = renderSessionWebhookPayload(msg)
  assert.deepEqual(body.at?.atUserIds, ["carol"])
})

test("renderSessionWebhookPayload: empty message uses '[消息]' placeholder", () => {
  const msg = buildCanonicalMessage([])
  const body = renderSessionWebhookPayload(msg)
  assert.equal(body.markdown?.text, "[消息]")
})

test("renderOpenApiPayload: returns {msgKey, msgParam} with no top-level `at`", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "hi " },
    { type: "mention", externalId: "alice", displayName: "Alice" },
  ])
  const body = renderOpenApiPayload(msg)
  assert.equal(body.msgKey, "sampleMarkdown")
  const parsed = JSON.parse(body.msgParam) as { title: string; text: string }
  assert.ok(parsed.text.length > 0)
  // No `at` field — DingTalk OpenAPI mention semantics aren't confirmed
  // in v1, so we surface mentions as inline text only.
  assert.ok(!("at" in body))
})

test("renderOpenApiPayload: mention parts render as @<displayName> text", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "ping " },
    { type: "mention", externalId: "alice", displayName: "Alice" },
  ])
  const body = renderOpenApiPayload(msg)
  const parsed = JSON.parse(body.msgParam) as { title: string; text: string }
  assert.match(parsed.text, /@Alice/)
})

test("renderOpenApiPayload: empty message uses '[消息]' placeholder", () => {
  const msg = buildCanonicalMessage([])
  const body = renderOpenApiPayload(msg)
  const parsed = JSON.parse(body.msgParam) as { title: string; text: string }
  assert.equal(parsed.text, "[消息]")
})
