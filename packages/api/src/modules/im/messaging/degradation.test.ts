import test from "node:test"
import assert from "node:assert/strict"
import { buildCanonicalMessage } from "./canonical-message.js"
import {
  degradeForCapabilities,
  truncateToBytes,
  type MessageCapabilities,
} from "./degradation.js"
import { FEISHU_MESSAGE_CAPABILITIES } from "../connectors/feishu/capabilities.js"
import { WEIXIN_MESSAGE_CAPABILITIES } from "../connectors/weixin/capabilities.js"

// Import the actual production capability descriptors. Tests previously
// imported parallel constants from degradation.ts that drifted from the
// real connector values (e.g. Feishu image/file was true in the constant
// but false on the real connector after the V1 capability tightening) —
// keep these two pointers identical.
const FEISHU_CAPABILITIES = FEISHU_MESSAGE_CAPABILITIES
const WEIXIN_CAPABILITIES = WEIXIN_MESSAGE_CAPABILITIES

test("Feishu capabilities pass through chat-like part types unchanged", () => {
  // Feishu now natively supports image (im.image.create) and file
  // (im.file.create), so degradation leaves both parts intact and the
  // outbound dispatcher uploads + sends them as proper attachment
  // messages. See connectors/feishu/attachments.ts.
  const msg = buildCanonicalMessage([
    { type: "text", text: "hi" },
    { type: "mention", displayName: "alice", externalId: "ou_a" },
    { type: "image", fileRef: { sha256: "img" } },
    { type: "file", fileRef: { name: "spec.pdf", sha256: "spec" } },
    {
      type: "card",
      schema: "feishu_interactive_v1",
      payload: { x: 1 },
      fallbackText: "card",
    },
    { type: "quote", quoted: { externalMessageId: "om_q", preview: "hi" } },
    {
      type: "reaction",
      emoji: "✅",
      target: { externalMessageId: "om_t" },
    },
  ])
  const out = degradeForCapabilities(msg, FEISHU_CAPABILITIES)
  assert.equal(out.parts.length, msg.parts.length)
  assert.equal(out.parts[0].type, "text")
  assert.equal(out.parts[1].type, "mention")
  assert.equal(out.parts[2].type, "image")
  assert.equal(out.parts[3].type, "file")
  assert.equal(out.parts[4].type, "card")
  assert.equal(out.parts[5].type, "quote")
  assert.equal(out.parts[6].type, "reaction")
})

test("WeChat capabilities flatten mention to text and drop reactions", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "hey" },
    { type: "mention", displayName: "alice", externalId: "ou_a" },
    { type: "text", text: "yo" },
    {
      type: "reaction",
      emoji: "✅",
      target: { externalMessageId: "om_t" },
    },
  ])
  const out = degradeForCapabilities(msg, WEIXIN_CAPABILITIES)
  // text + mention(text) + text → merged into single text
  assert.equal(out.parts.length, 1)
  assert.equal(out.parts[0].type, "text")
  if (out.parts[0].type === "text") {
    assert.equal(out.parts[0].text, "hey@aliceyo")
  }
})

test("WeChat capabilities keep image part (media now supported)", () => {
  const msg = buildCanonicalMessage([
    { type: "image", fileRef: { sha256: "img", mimeType: "image/png" } },
  ])
  const out = degradeForCapabilities(msg, WEIXIN_CAPABILITIES)
  // WeChat now uploads image/video/file to the CDN; the part is kept for the
  // outbound sender rather than degraded to a placeholder.
  assert.equal(out.parts[0].type, "image")
})

test("WeChat capabilities keep file part (media now supported)", () => {
  const msg = buildCanonicalMessage([
    { type: "file", fileRef: { name: "doc.pdf" } },
  ])
  const out = degradeForCapabilities(msg, WEIXIN_CAPABILITIES)
  assert.equal(out.parts[0].type, "file")
})

test("WeChat still degrades voice to placeholder (no voice send)", () => {
  const msg = buildCanonicalMessage([
    { type: "voice", fileRef: { sha256: "a" }, transcript: "hi" },
  ])
  const out = degradeForCapabilities(msg, WEIXIN_CAPABILITIES)
  assert.equal(out.parts[0].type, "system_marker")
  if (out.parts[0].type === "system_marker") {
    assert.equal(out.parts[0].marker, "voice_placeholder")
  }
})

test("WeChat capabilities replace card with fallbackText, or [卡片] when empty", () => {
  const out1 = degradeForCapabilities(
    buildCanonicalMessage([
      {
        type: "card",
        schema: "feishu_interactive_v1",
        payload: {},
        fallbackText: "x",
      },
    ]),
    WEIXIN_CAPABILITIES
  )
  if (out1.parts[0].type === "text") assert.equal(out1.parts[0].text, "x")
  else assert.fail("expected text part")

  const out2 = degradeForCapabilities(
    buildCanonicalMessage([
      {
        type: "card",
        schema: "feishu_interactive_v1",
        payload: {},
        fallbackText: "",
      },
    ]),
    WEIXIN_CAPABILITIES
  )
  if (out2.parts[0].type === "text") assert.equal(out2.parts[0].text, "[卡片]")
  else assert.fail("expected text part")
})

test("WeChat capabilities flatten quote to blockquote text; empty preview drops", () => {
  const out1 = degradeForCapabilities(
    buildCanonicalMessage([
      { type: "quote", quoted: { externalMessageId: "x", preview: "earlier" } },
    ]),
    WEIXIN_CAPABILITIES
  )
  if (out1.parts[0].type === "text") {
    assert.equal(out1.parts[0].text, "> earlier\n")
  } else {
    assert.fail("expected text part")
  }
  const out2 = degradeForCapabilities(
    buildCanonicalMessage([
      { type: "quote", quoted: { preview: "" } },
      { type: "text", text: "next" },
    ]),
    WEIXIN_CAPABILITIES
  )
  assert.equal(out2.parts.length, 1)
  if (out2.parts[0].type === "text") {
    assert.equal(out2.parts[0].text, "next")
  }
})

test("text exceeding maxTextBytes is truncated with ellipsis", () => {
  const longText = "a".repeat(10_000)
  const caps: MessageCapabilities = {
    ...WEIXIN_CAPABILITIES,
    maxTextBytes: 100,
  }
  const out = degradeForCapabilities(
    buildCanonicalMessage([{ type: "text", text: longText }]),
    caps
  )
  if (out.parts[0].type === "text") {
    assert.ok(out.parts[0].text.length < longText.length)
    assert.ok(out.parts[0].text.endsWith("…"))
    assert.ok(new TextEncoder().encode(out.parts[0].text).length <= 100)
  } else {
    assert.fail("expected text part")
  }
})

test("truncateToBytes preserves multi-byte boundaries", () => {
  // Each Chinese char is 3 bytes in UTF-8
  const input = "你好世界" // 12 bytes total
  assert.equal(truncateToBytes(input, 100), input) // under budget
  // Budget 7 bytes → ellipsis is 3 bytes, leaves 4 bytes, fits 1 char
  const out = truncateToBytes(input, 7)
  assert.equal(out, "你…")
  // Budget < ellipsis is gracefully empty + ellipsis
  const tiny = truncateToBytes(input, 3)
  assert.equal(tiny, "…")
})

test("WeChat caps drop reaction silently (no part)", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "hi" },
    { type: "reaction", emoji: "✅", target: { externalMessageId: "om" } },
  ])
  const out = degradeForCapabilities(msg, WEIXIN_CAPABILITIES)
  assert.equal(out.parts.length, 1)
  assert.equal(out.parts[0].type, "text")
})

test("adjacent text parts are merged after degradation", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "A" },
    { type: "mention", displayName: "b", externalId: "x" },
    { type: "mention", displayName: "c", externalId: "y" },
    { type: "text", text: "D" },
  ])
  const out = degradeForCapabilities(msg, WEIXIN_CAPABILITIES)
  assert.equal(out.parts.length, 1)
  if (out.parts[0].type === "text") {
    assert.equal(out.parts[0].text, "A@b@cD")
  }
})

test("plainText is recomputed after degradation", () => {
  const msg = buildCanonicalMessage([
    { type: "image", fileRef: { sha256: "x" } },
    { type: "text", text: "hi" },
  ])
  const out = degradeForCapabilities(msg, WEIXIN_CAPABILITIES)
  assert.equal(out.plainText, "[图片] hi")
})

test("system_marker passes through both capability profiles unchanged", () => {
  const msg = buildCanonicalMessage([
    { type: "system_marker", marker: "voice_placeholder" },
  ])
  const out1 = degradeForCapabilities(msg, FEISHU_CAPABILITIES)
  const out2 = degradeForCapabilities(msg, WEIXIN_CAPABILITIES)
  assert.equal(out1.parts[0].type, "system_marker")
  assert.equal(out2.parts[0].type, "system_marker")
})

test("Feishu retains reactions, WeChat drops them — capability matrix invariant", () => {
  const reactionMsg = buildCanonicalMessage([
    { type: "reaction", emoji: "👀", target: { externalMessageId: "x" } },
  ])
  assert.equal(
    degradeForCapabilities(reactionMsg, FEISHU_CAPABILITIES).parts.length,
    1
  )
  assert.equal(
    degradeForCapabilities(reactionMsg, WEIXIN_CAPABILITIES).parts.length,
    0
  )
})
