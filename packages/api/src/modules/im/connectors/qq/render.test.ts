import test from "node:test"
import assert from "node:assert/strict"
import { buildCanonicalMessage } from "../../messaging/canonical-message.js"
import { planQqSends } from "./render.js"

test("planQqSends: text part → single msg_type=0 plan", () => {
  const msg = buildCanonicalMessage([{ type: "text", text: "hello world" }])
  const plan = planQqSends(msg)
  assert.equal(plan.length, 1)
  assert.equal(plan[0].msgType, 0)
  assert.equal(plan[0].content, "hello world")
})

test("planQqSends: empty parts → empty plan", () => {
  assert.deepEqual(planQqSends(buildCanonicalMessage([])), [])
})

test("planQqSends: system_marker keeps a label so the message isn't silent", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "see:" },
    { type: "system_marker", marker: "image_placeholder" },
  ])
  const plan = planQqSends(msg)
  assert.equal(plan.length, 1)
  assert.equal(plan[0].kind, "text")
  if (plan[0].kind === "text") {
    assert.equal(plan[0].content, "see: [图片]")
  }
})

test("planQqSends: quote part becomes leading > preview", () => {
  const msg = buildCanonicalMessage([
    {
      type: "quote",
      quoted: { externalMessageId: "M0", preview: "earlier line" },
    },
    { type: "text", text: "follow-up" },
  ])
  const plan = planQqSends(msg)
  assert.equal(plan[0].kind, "text")
  if (plan[0].kind === "text") {
    assert.equal(plan[0].content, "> earlier line follow-up")
  }
})

test("planQqSends: media parts produce a media plan item (Stage 5)", () => {
  const msg = buildCanonicalMessage([
    { type: "image", fileRef: { fileId: "f1", url: "https://x/y" } },
  ])
  const plan = planQqSends(msg)
  assert.equal(plan.length, 1)
  assert.equal(plan[0].kind, "media")
  if (plan[0].kind === "media") {
    assert.equal(plan[0].fileType, 1) // QQ_FILE_TYPE.IMAGE
    assert.equal(plan[0].fileRef.url, "https://x/y")
  }
})

test("planQqSends: media parts with neither url nor fileId are dropped", () => {
  const msg = buildCanonicalMessage([{ type: "image", fileRef: {} }])
  assert.deepEqual(planQqSends(msg), [])
})

test("planQqSends: mixed text + media interleave in canonical order", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "before" },
    { type: "image", fileRef: { url: "https://x/y" } },
    { type: "text", text: "after" },
  ])
  const plan = planQqSends(msg)
  assert.equal(plan.length, 3)
  assert.equal(plan[0].kind, "text")
  assert.equal(plan[1].kind, "media")
  assert.equal(plan[2].kind, "text")
})

test("planQqSends: interaction_prompt falls back to title + fallbackText", () => {
  const msg = buildCanonicalMessage([
    {
      type: "interaction_prompt",
      taskId: "ir-1",
      title: "Approve?",
      fallbackText: "go to dashboard",
      options: [],
    },
  ])
  const plan = planQqSends(msg)
  assert.equal(plan.length, 1)
  assert.equal(plan[0].kind, "text")
  if (plan[0].kind === "text") {
    assert.match(plan[0].content, /Approve\?/)
    assert.match(plan[0].content, /dashboard/)
  }
})

test("planQqSends: interaction_prompt + long_connection emits keyboard plan", () => {
  const msg = buildCanonicalMessage([
    {
      type: "interaction_prompt",
      taskId: "ir-2",
      title: "需要审批",
      fallbackText: "请到 dashboard 处理",
      options: [
        { id: "approve", label: "✅", actionToken: "tok-1", style: "primary" },
        { id: "deny", label: "❌", actionToken: "tok-2", style: "danger" },
      ],
    },
  ])
  const plan = planQqSends(msg, { connectionMode: "long_connection" })
  assert.equal(plan.length, 1)
  assert.equal(plan[0].kind, "keyboard")
  if (plan[0].kind === "keyboard") {
    assert.equal(plan[0].msgType, 2)
    assert.ok(plan[0].payload.markdown.content.includes("需要审批"))
    assert.equal(plan[0].payload.keyboard.content.rows[0]!.buttons.length, 2)
  }
})

test("planQqSends: interaction_prompt + webhook (no connectionMode) → text fallback", () => {
  const msg = buildCanonicalMessage([
    {
      type: "interaction_prompt",
      taskId: "ir-3",
      title: "x",
      fallbackText: "y",
      options: [{ id: "a", label: "A", actionToken: "t" }],
    },
  ])
  const plan = planQqSends(msg, { connectionMode: "webhook" })
  assert.equal(plan.length, 1)
  assert.equal(plan[0].kind, "text")
})
