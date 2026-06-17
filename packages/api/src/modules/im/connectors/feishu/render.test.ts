import test from "node:test"
import assert from "node:assert/strict"
import { buildCanonicalMessage } from "../../messaging/canonical-message.js"
import {
  planFeishuSends,
  renderFeishuMessage,
  renderTextWithMentions,
} from "./render.js"

// ───────────────────────── renderTextWithMentions ─────────────────────────
// The text path now ONLY serializes text-equivalent parts (text, mention,
// quote, system_marker). Image, file, card and reaction parts are routed
// through planFeishuSends → their own sends, NOT inlined as placeholder
// text in the text message.

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

test("card part takes priority and renders as interactive (single-send path)", () => {
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

test("empty message renders as [消息] via single-send path", () => {
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

test("image part is NOT inlined as text — it's a separate send (see planFeishuSends)", () => {
  // Previously the text path emitted "[图片]" as a placeholder. Now image
  // parts flow through planFeishuSends → uploadFeishuImage → image msg,
  // so they don't pollute the text content.
  const out = renderTextWithMentions(
    buildCanonicalMessage([
      { type: "text", text: "see:" },
      { type: "image", fileRef: { sha256: "x", mimeType: "image/png" } },
    ])
  )
  assert.equal(out, "see:")
})

test("file part is NOT inlined as text either", () => {
  const out = renderTextWithMentions(
    buildCanonicalMessage([{ type: "file", fileRef: { name: "report.pdf" } }])
  )
  assert.equal(out, "")
})

// ───────────────────────── planFeishuSends ─────────────────────────

test("plan: text-only message produces a single text send", () => {
  const plan = planFeishuSends(
    buildCanonicalMessage([{ type: "text", text: "hi" }])
  )
  assert.equal(plan.length, 1)
  assert.equal(plan[0].kind, "text")
  if (plan[0].kind === "text") {
    assert.equal(plan[0].content, "hi")
  }
})

test("plan: card takes the whole message and suppresses other parts", () => {
  // Feishu cards can't be combined with text or attachments in one
  // message. The card wins; the rest is dropped.
  const plan = planFeishuSends(
    buildCanonicalMessage([
      { type: "text", text: "ignored" },
      {
        type: "card",
        schema: "feishu_interactive_v1",
        payload: { hello: 1 },
        fallbackText: "fallback",
      },
      { type: "image", fileRef: { sha256: "img" } },
    ])
  )
  assert.equal(plan.length, 1)
  assert.equal(plan[0].kind, "interactive")
  if (plan[0].kind === "interactive") {
    assert.deepEqual(plan[0].payload, { hello: 1 })
  }
})

test("plan: text + single image produces text-first then image", () => {
  const plan = planFeishuSends(
    buildCanonicalMessage([
      { type: "text", text: "see this:" },
      { type: "image", fileRef: { sha256: "img" } },
    ])
  )
  assert.equal(plan.length, 2)
  assert.equal(plan[0].kind, "text")
  assert.equal(plan[1].kind, "image")
})

test("plan: text + file produces text-first then file", () => {
  const plan = planFeishuSends(
    buildCanonicalMessage([
      { type: "text", text: "report attached" },
      { type: "file", fileRef: { name: "q4.pdf", sha256: "q4" } },
    ])
  )
  assert.equal(plan.length, 2)
  assert.equal(plan[0].kind, "text")
  assert.equal(plan[1].kind, "file")
  if (plan[1].kind === "file") {
    assert.equal(plan[1].fileRef.name, "q4.pdf")
  }
})

test("plan: multiple images emitted in order, each as its own send", () => {
  const plan = planFeishuSends(
    buildCanonicalMessage([
      { type: "image", fileRef: { sha256: "sha1" } },
      { type: "image", fileRef: { sha256: "sha2" } },
      { type: "image", fileRef: { sha256: "sha3" } },
    ])
  )
  assert.equal(plan.length, 3)
  const shas = plan.flatMap((p) =>
    p.kind === "image" ? [p.fileRef.sha256] : []
  )
  assert.deepEqual(shas, ["sha1", "sha2", "sha3"])
})

test("plan: text + image + file emits (text, image, file) in attachment order", () => {
  const plan = planFeishuSends(
    buildCanonicalMessage([
      { type: "file", fileRef: { name: "doc.pdf", sha256: "doc" } },
      { type: "image", fileRef: { sha256: "img" } },
      { type: "text", text: "before file in source, after in plan" },
    ])
  )
  // text always wins position 0; attachments follow in source order.
  assert.equal(plan.length, 3)
  assert.equal(plan[0].kind, "text")
  assert.equal(plan[1].kind, "file")
  assert.equal(plan[2].kind, "image")
})

test("plan: mentions inline into the text send (not a separate part)", () => {
  const plan = planFeishuSends(
    buildCanonicalMessage([
      { type: "text", text: "hello" },
      { type: "mention", displayName: "Alice", externalId: "ou_alice" },
      { type: "image", fileRef: { sha256: "i" } },
    ])
  )
  assert.equal(plan.length, 2)
  if (plan[0].kind === "text") {
    assert.match(plan[0].content, /<at user_id="ou_alice">Alice<\/at>/)
  } else {
    assert.fail("expected first send to be text")
  }
  assert.equal(plan[1].kind, "image")
})

test("plan: reaction-only message yields an empty plan", () => {
  const plan = planFeishuSends(
    buildCanonicalMessage([
      { type: "reaction", emoji: "👀", target: { externalMessageId: "om" } },
    ])
  )
  assert.equal(plan.length, 0)
})

test("plan: quote-only without text becomes a single quote-text send", () => {
  const plan = planFeishuSends(
    buildCanonicalMessage([
      {
        type: "quote",
        quoted: { externalMessageId: "om_q", preview: "earlier" },
      },
    ])
  )
  assert.equal(plan.length, 1)
  if (plan[0].kind === "text") {
    assert.match(plan[0].content, /> earlier/)
  } else {
    assert.fail("expected quote to render into text send")
  }
})
