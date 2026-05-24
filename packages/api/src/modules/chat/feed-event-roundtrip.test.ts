// Unit test: confirms an event item with structured contentBlocks (e.g.
// automation_notice carrying a file_ref) survives both the API render path
// AND the FE chat-store re-encode without losing file_ref structure.
//
// Before Phase 6 the FE was re-deriving contentBlocks via
// summarizeConversationEvent + textBlocks, which silently flattened
// file_refs to text. Phase 6 made chat-store pass item.contentBlocks
// through verbatim; this test guards that contract.
import test from "node:test"
import assert from "node:assert/strict"

import {
  renderConversationEventTimelineBlocks,
  renderConversationEventContextBlocks,
} from "./event-registry.js"
import type { CanonicalContentBlock } from "@synapse/shared"

const validFileRef: CanonicalContentBlock = {
  type: "file_ref",
  id: "block-1",
  fileId: "00000000-0000-4000-8000-000000000001",
  url: "/files/00000000-0000-4000-8000-000000000001",
  mimeType: "image/png",
  originalName: "chart.png",
  sizeBytes: 1024,
  category: "image",
}

const validTextBlock: CanonicalContentBlock = {
  type: "text",
  id: "block-2",
  text: "Automation fired: chart attached.",
}

test("automation_notice with messageBlocks preserves file_ref through timeline render", () => {
  const blocks = renderConversationEventTimelineBlocks("automation_notice", {
    message: "fallback ignored when blocks present",
    messageBlocks: [validTextBlock, validFileRef],
  } as any)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, "text")
  assert.equal(blocks[1].type, "file_ref")
  assert.equal((blocks[1] as any).fileId, validFileRef.fileId)
})

test("automation_notice with messageBlocks preserves file_ref through context render", () => {
  const blocks = renderConversationEventContextBlocks("automation_notice", {
    message: "fallback",
    messageBlocks: [validFileRef],
  } as any)
  assert.ok(blocks)
  assert.equal(blocks!.length, 1)
  assert.equal(blocks![0].type, "file_ref")
})

test("task_notice with messageBlocks preserves file_ref through both render paths", () => {
  const tl = renderConversationEventTimelineBlocks("task_notice", {
    message: "fallback",
    messageBlocks: [validFileRef],
  } as any)
  const ctx = renderConversationEventContextBlocks("task_notice", {
    message: "fallback",
    messageBlocks: [validFileRef],
  } as any)
  assert.equal(tl.length, 1)
  assert.equal(tl[0].type, "file_ref")
  assert.equal((tl[0] as any).fileId, validFileRef.fileId)
  assert.equal(ctx?.length, 1)
  assert.equal(ctx?.[0].type, "file_ref")
})

test("event payload with malformed messageBlocks falls back to message text, doesn't smuggle garbage", () => {
  const blocks = renderConversationEventTimelineBlocks("automation_notice", {
    message: "real fallback message",
    messageBlocks: [
      { type: "text" }, // missing required `text`
      { type: "file_ref", fileId: "x" }, // missing required fields
      { foo: "bar" }, // no discriminator
    ],
  } as any)
  // None of the garbage items pass isCanonicalContentBlock — falls back to text.
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, "text")
  assert.equal((blocks[0] as any).text, "real fallback message")
})

test("event payload where messageBlocks is one valid + several garbage filters cleanly", () => {
  const blocks = renderConversationEventTimelineBlocks("automation_notice", {
    message: "fallback",
    messageBlocks: [
      { type: "text" }, // garbage
      validFileRef, // good
      { type: "weird" }, // garbage
    ],
  } as any)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, "file_ref")
  assert.equal((blocks[0] as any).fileId, validFileRef.fileId)
})
