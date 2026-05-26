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
  assert.equal(plan[0].content, "see: [图片]")
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
  assert.equal(plan[0].content, "> earlier line follow-up")
})

test("planQqSends: media-only parts (image/voice/video/file) produce empty plan", () => {
  // Degradation has already converted them to system_markers in
  // production (supportsImage/Voice/Video/File=false in Stage 4
  // capabilities); if we still see typed media here, they render to
  // nothing because Stage 4 doesn't ship media (Stage 5 does).
  const msg = buildCanonicalMessage([
    { type: "image", fileRef: { fileId: "f1", url: "https://x/y" } },
  ])
  const plan = planQqSends(msg)
  assert.equal(plan.length, 0)
})

test("planQqSends: interaction_prompt falls back to title + fallbackText", () => {
  const msg = buildCanonicalMessage([
    {
      type: "interaction_prompt",
      interactionRequestId: "ir-1",
      title: "Approve?",
      fallbackText: "go to dashboard",
      options: [],
    },
  ])
  const plan = planQqSends(msg)
  assert.equal(plan.length, 1)
  assert.match(plan[0].content, /Approve\?/)
  assert.match(plan[0].content, /dashboard/)
})
