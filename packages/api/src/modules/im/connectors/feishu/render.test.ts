import test from "node:test"
import assert from "node:assert/strict"
import { buildCanonicalMessage } from "../../messaging/canonical-message.js"
import { renderFeishuMessage, renderTextWithMentions } from "./render.js"

test("text-only message renders as msg_type=text with JSON content", () => {
  const out = renderFeishuMessage(
    buildCanonicalMessage([{ type: "text", text: "hi" }])
  )
  assert.equal(out.msg_type, "text")
  assert.equal(out.content, JSON.stringify({ text: "hi" }))
})

test("mention is rendered as <at> markup inline", () => {
  const out = renderTextWithMentions(
    buildCanonicalMessage([
      { type: "text", text: "Hello" },
      { type: "mention", externalId: "ou_a", displayName: "Alice" },
      { type: "text", text: "how are you" },
    ])
  )
  assert.ok(out.includes('<at user_id="ou_a">Alice</at>'))
})

test("mention without externalId falls back to @name", () => {
  const out = renderTextWithMentions(
    buildCanonicalMessage([{ type: "mention", displayName: "Anon" }])
  )
  assert.equal(out, "@Anon")
})

test("card part takes priority and renders as interactive", () => {
  const out = renderFeishuMessage(
    buildCanonicalMessage([
      { type: "text", text: "ignored" },
      {
        type: "card",
        schema: "feishu_interactive_v1",
        payload: { schema: "2.0", body: "x" },
        fallbackText: "fb",
      },
    ])
  )
  assert.equal(out.msg_type, "interactive")
  assert.equal(out.content, JSON.stringify({ schema: "2.0", body: "x" }))
})

test("quote part becomes blockquote prefix", () => {
  const out = renderTextWithMentions(
    buildCanonicalMessage([
      { type: "quote", quoted: { preview: "earlier" } },
      { type: "text", text: "now" },
    ])
  )
  assert.equal(out, "> earlier now")
})

test("empty message renders as [消息]", () => {
  const out = renderFeishuMessage(buildCanonicalMessage([]))
  assert.equal(out.content, JSON.stringify({ text: "[消息]" }))
})

test("system_marker label flows into text", () => {
  const out = renderTextWithMentions(
    buildCanonicalMessage([
      { type: "system_marker", marker: "voice_placeholder", label: "[音频]" },
    ])
  )
  assert.equal(out, "[音频]")
})
