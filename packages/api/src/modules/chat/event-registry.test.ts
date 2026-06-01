// Unit tests for chat event-registry noticeBlocks strict validation.
//
// Phase 6 tightened the messageBlocks acceptance from "any object" to
// `isCanonicalContentBlock` so malformed payloads can't smuggle garbage
// into the LLM context window as fake "blocks".
import test from "node:test"
import assert from "node:assert/strict"

import {
  renderConversationEventContextBlocks,
  renderConversationEventTimelineBlocks,
} from "./event-registry.js"
import { extractText, type CanonicalContentBlock } from "@synapse/shared"

const validTextBlock: CanonicalContentBlock = {
  type: "text",
  id: "block-1",
  text: "valid notice body",
}
const validFileRefBlock: CanonicalContentBlock = {
  type: "file_ref",
  id: "block-2",
  sha256: "a".repeat(64),
  path: "/conversation/img.png",
  mimeType: "image/png",
  name: "img.png",
  sizeBytes: 64,
  category: "image",
}

test("noticeBlocks accepts valid canonical text + file_ref blocks", () => {
  const blocks = renderConversationEventTimelineBlocks("automation_notice", {
    message: "fallback",
    messageBlocks: [validTextBlock, validFileRefBlock],
  } as any)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, "text")
  assert.equal(blocks[1].type, "file_ref")
})

test("noticeBlocks rejects malformed messageBlocks and falls back to text", () => {
  const blocks = renderConversationEventTimelineBlocks("automation_notice", {
    message: "fallback body",
    // garbage items: missing required fields, wrong shape, primitive values
    messageBlocks: [
      { type: "text" }, // missing `text` field
      { type: "file_ref", fileId: "x" }, // missing required fields
      { type: "weird" }, // unknown type
      "not an object",
      42,
      null,
    ],
  } as any)
  // Since none of the items pass isCanonicalContentBlock, falls back to message
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, "text")
  assert.equal((blocks[0] as any).text, "fallback body")
})

test("noticeBlocks: mixed garbage + one valid block filters garbage but keeps the valid one", () => {
  const blocks = renderConversationEventTimelineBlocks("automation_notice", {
    message: "fallback",
    messageBlocks: [
      { type: "text" }, // garbage
      validTextBlock, // good
      { type: "image", garbage: true }, // wrong shape — not in canonical union
    ],
  } as any)
  // Strict filter keeps only the canonical block
  assert.equal(blocks.length, 1)
  assert.equal(extractText(blocks), "valid notice body")
})

test("noticeBlocks: no messageBlocks falls back to message string", () => {
  const blocks = renderConversationEventTimelineBlocks("task_notice", {
    message: "you have a task",
  } as any)
  assert.equal(extractText(blocks), "you have a task")
})

test("noticeBlocks: no messageBlocks / no message falls back to sourceTitle", () => {
  const blocks = renderConversationEventTimelineBlocks("task_notice", {
    sourceTitle: "Task X",
    sourceDescription: "description here",
  } as any)
  assert.equal(extractText(blocks), "Task X\ndescription here")
})

test("renderConversationEventContextBlocks routes through the same filter", () => {
  const blocks = renderConversationEventContextBlocks("automation_notice", {
    message: "fallback",
    messageBlocks: [{ broken: "object" }, { type: "garbage" }],
  } as any)
  assert.ok(blocks)
  assert.equal(blocks!.length, 1)
  assert.equal((blocks![0] as any).text, "fallback")
})
