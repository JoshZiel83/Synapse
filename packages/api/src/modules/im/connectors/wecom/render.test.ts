import test from "node:test"
import assert from "node:assert/strict"
import { renderWecomMarkdown, truncateUtf8 } from "./render.js"
import { buildCanonicalMessage } from "../../messaging/canonical-message.js"

test("renders text parts in order", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "hello " },
    { type: "text", text: "world" },
  ])
  assert.equal(renderWecomMarkdown(msg), "hello world")
})

test("mention parts render as @displayName plain text", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "hey " },
    { type: "mention", displayName: "Alice", participantId: "p1" },
    { type: "text", text: ", look at this" },
  ])
  assert.equal(renderWecomMarkdown(msg), "hey @Alice, look at this")
})

test("non-text/mention parts are dropped (degradation already ran)", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "before" },
    {
      type: "image",
      fileRef: { sha256: "x" },
    },
    { type: "text", text: "after" },
  ])
  assert.equal(renderWecomMarkdown(msg), "beforeafter")
})

test("truncateUtf8 returns original when under limit", () => {
  assert.equal(truncateUtf8("hello", 100), "hello")
})

test("truncateUtf8 zero / negative produces empty string", () => {
  assert.equal(truncateUtf8("hello", 0), "")
  assert.equal(truncateUtf8("hello", -3), "")
})

test("truncateUtf8 doesn't split a multi-byte rune", () => {
  // 字 = 0xE5 0xAD 0x97 (3 bytes). At byte budget 4, naive truncate would
  // emit 字 + 0xE5 — broken. Expected behavior: yield just 字 (3 bytes).
  const out = truncateUtf8("字符", 4)
  assert.equal(out, "字")
  assert.equal(Buffer.byteLength(out, "utf8"), 3)
})

test("truncateUtf8 ascii is byte-exact", () => {
  assert.equal(truncateUtf8("abcdef", 3), "abc")
})

test("renderWecomMarkdown honors caller-supplied byte budget", () => {
  const msg = buildCanonicalMessage([{ type: "text", text: "0123456789" }])
  assert.equal(renderWecomMarkdown(msg, 4), "0123")
})

test("renderWecomMarkdown default 4096 cap (large text truncated)", () => {
  const huge = "x".repeat(5000)
  const msg = buildCanonicalMessage([{ type: "text", text: huge }])
  const out = renderWecomMarkdown(msg)
  assert.equal(Buffer.byteLength(out, "utf8"), 4096)
})

// ─── Empty-message fallback (Low review finding) ───
//
// Reaction-only messages get their `reaction` parts dropped during
// degradation (capabilities.canReact=false). Without the fallback,
// `renderWecomMarkdown(...)` returned `""` and the connector sent
// `markdown.content: ""` — WeCom rejects or blanks the message.
// Match feishu/weixin's `"[消息]"` placeholder.

test("renderWecomMarkdown: empty parts array falls back to [消息]", () => {
  const msg = buildCanonicalMessage([])
  assert.equal(renderWecomMarkdown(msg), "[消息]")
})

test("renderWecomMarkdown: parts that all render to empty fall back to [消息]", () => {
  // text-with-empty-string parts — pathological but not impossible.
  const msg = buildCanonicalMessage([
    { type: "text", text: "" },
    { type: "text", text: "" },
  ])
  assert.equal(renderWecomMarkdown(msg), "[消息]")
})

test("renderWecomMarkdown: reaction-only message (after degradation) falls back to [消息]", async () => {
  // `WECOM_MESSAGE_CAPABILITIES.canReact=false` makes the degradation
  // pass drop reaction parts entirely. By the time render gets the
  // message, parts is `[]`. Verify the post-degradation fallback path.
  const { degradeForCapabilities } =
    await import("../../messaging/degradation.js")
  const { WECOM_MESSAGE_CAPABILITIES } = await import("./capabilities.js")
  const original = buildCanonicalMessage([
    {
      type: "reaction",
      emoji: "👍",
      target: { externalMessageId: "m-1" },
    },
  ])
  const degraded = degradeForCapabilities(original, WECOM_MESSAGE_CAPABILITIES)
  assert.equal(renderWecomMarkdown(degraded), "[消息]")
})
