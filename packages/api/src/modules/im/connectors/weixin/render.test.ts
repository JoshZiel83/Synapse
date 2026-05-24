import test from "node:test"
import assert from "node:assert/strict"
import { buildCanonicalMessage } from "../../messaging/canonical-message.js"
import { degradeForCapabilities } from "../../messaging/degradation.js"
import { renderWeixinMessage } from "./render.js"
import { WEIXIN_MESSAGE_CAPABILITIES } from "./capabilities.js"

test("text-only renders plainText", () => {
  const msg = buildCanonicalMessage([{ type: "text", text: "hello" }])
  assert.equal(renderWeixinMessage(msg).text, "hello")
})

test("empty message renders [消息]", () => {
  const msg = buildCanonicalMessage([])
  assert.equal(renderWeixinMessage(msg).text, "[消息]")
})

test("after degradation, mention becomes @name in text", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "hi " },
    { type: "mention", displayName: "alice" },
  ])
  const degraded = degradeForCapabilities(msg, WEIXIN_MESSAGE_CAPABILITIES)
  assert.equal(renderWeixinMessage(degraded).text, "hi @alice")
})

test("after degradation, image becomes [图片] placeholder", () => {
  const msg = buildCanonicalMessage([
    { type: "image", fileRef: { url: "x" } },
    { type: "text", text: "see" },
  ])
  const degraded = degradeForCapabilities(msg, WEIXIN_MESSAGE_CAPABILITIES)
  assert.equal(renderWeixinMessage(degraded).text, "[图片] see")
})

test("text exceeding 5k bytes is truncated by degradation", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "a".repeat(10_000) },
  ])
  const degraded = degradeForCapabilities(msg, WEIXIN_MESSAGE_CAPABILITIES)
  const out = renderWeixinMessage(degraded).text
  assert.ok(out.length < 10_000)
  assert.ok(out.endsWith("…"))
})
