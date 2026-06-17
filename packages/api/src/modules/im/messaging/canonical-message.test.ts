import test from "node:test"
import assert from "node:assert/strict"
import {
  buildCanonicalMessage,
  derivePlainText,
  parseCanonicalMessage,
  serializeCanonicalMessage,
  textOnlyMessage,
  type CanonicalPart,
} from "./canonical-message.js"

test("textOnlyMessage builds a single text part with plainText", () => {
  const msg = textOnlyMessage("hello")
  assert.equal(msg.schemaVersion, 1)
  assert.equal(msg.plainText, "hello")
  assert.deepEqual(msg.parts, [{ type: "text", text: "hello" }])
})

test("derivePlainText joins parts with single space and trims", () => {
  const parts: CanonicalPart[] = [
    { type: "text", text: "  hi  " },
    { type: "mention", displayName: "alice", externalId: "ou_x" },
    { type: "text", text: "how are you" },
  ]
  assert.equal(derivePlainText(parts), "hi   @alice how are you")
})

test("derivePlainText renders image part as [图片]", () => {
  const parts: CanonicalPart[] = [
    { type: "text", text: "look:" },
    { type: "image", fileRef: { sha256: "x" } },
  ]
  assert.equal(derivePlainText(parts), "look: [图片]")
})

test("derivePlainText uses file name when present, generic label otherwise", () => {
  assert.equal(
    derivePlainText([{ type: "file", fileRef: { name: "report.pdf" } }]),
    "[文件 report.pdf]"
  )
})

test("derivePlainText falls back to fallbackText for cards, then placeholder", () => {
  assert.equal(
    derivePlainText([
      {
        type: "card",
        schema: "feishu_interactive_v1",
        payload: {},
        fallbackText: "Welcome card",
      },
    ]),
    "Welcome card"
  )
  assert.equal(
    derivePlainText([
      {
        type: "card",
        schema: "feishu_interactive_v1",
        payload: {},
        fallbackText: "",
      },
    ]),
    "[卡片]"
  )
})

test("derivePlainText quotes use blockquote prefix; empty preview drops the part", () => {
  assert.equal(
    derivePlainText([
      { type: "quote", quoted: { preview: "earlier message" } },
    ]),
    "> earlier message"
  )
  assert.equal(
    derivePlainText([
      { type: "quote", quoted: { preview: "" } },
      { type: "text", text: "next" },
    ]),
    "next"
  )
})

test("derivePlainText reaction part contributes raw emoji", () => {
  assert.equal(
    derivePlainText([
      { type: "reaction", emoji: "👀", target: { externalMessageId: "om_x" } },
    ]),
    "👀"
  )
})

test("derivePlainText system_marker uses label fallback to default", () => {
  assert.equal(
    derivePlainText([{ type: "system_marker", marker: "voice_placeholder" }]),
    "[语音]"
  )
  assert.equal(
    derivePlainText([
      { type: "system_marker", marker: "voice_placeholder", label: "[音频]" },
    ]),
    "[音频]"
  )
})

test("buildCanonicalMessage copies parts and recomputes plainText", () => {
  const parts: CanonicalPart[] = [{ type: "text", text: "abc" }]
  const msg = buildCanonicalMessage(parts)
  parts.push({ type: "text", text: "def" })
  // Mutation of caller's array should not leak in
  assert.equal(msg.parts.length, 1)
  assert.equal(msg.plainText, "abc")
})

test("parseCanonicalMessage round-trips a structured message via serialize", () => {
  const original = buildCanonicalMessage([
    { type: "text", text: "hi" },
    { type: "mention", displayName: "bob", externalId: "ou_bob" },
    {
      type: "card",
      schema: "feishu_interactive_v1",
      payload: { body: "x" },
      fallbackText: "card",
    },
    { type: "reaction", emoji: "✅", target: { externalMessageId: "om_y" } },
  ])
  const back = parseCanonicalMessage(serializeCanonicalMessage(original))
  assert.deepEqual(back, original)
})

test("parseCanonicalMessage maps unknown part types to system_marker with original", () => {
  const back = parseCanonicalMessage({
    schemaVersion: 1,
    parts: [
      { type: "future_kind", data: 42 },
      { type: "text", text: "ok" },
    ],
  })
  assert.equal(back.parts.length, 2)
  assert.equal(back.parts[0].type, "system_marker")
  if (back.parts[0].type === "system_marker") {
    assert.equal(back.parts[0].marker, "unknown_placeholder")
    assert.deepEqual(back.parts[0].original, { type: "future_kind", data: 42 })
  }
  assert.equal(back.parts[1].type, "text")
})

test("parseCanonicalMessage handles malformed input by returning empty message", () => {
  assert.equal(parseCanonicalMessage(null).parts.length, 0)
  assert.equal(parseCanonicalMessage(undefined).parts.length, 0)
  assert.equal(parseCanonicalMessage("not an object").parts.length, 0)
  assert.equal(parseCanonicalMessage([]).parts.length, 0)
  assert.equal(parseCanonicalMessage({ parts: "not an array" }).parts.length, 0)
})
