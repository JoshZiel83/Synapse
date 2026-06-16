import assert from "node:assert/strict"
import test from "node:test"

import {
  parseCreateMemoryToolInput,
  parseRenameSelfToolInput,
} from "./actor-state-tools-input-codec.js"
import { ToolExecutionError } from "./tool-errors.js"

test("parseCreateMemoryToolInput normalizes memory action input", () => {
  assert.deepEqual(
    parseCreateMemoryToolInput({
      content: " User prefers concise updates. ",
      category: " preference ",
      spaceType: " actor_private ",
      importance: "0.9",
      confidence: "0.75",
      textDigest: " user update preference ",
      tags: " user, updates, , style ",
    }),
    {
      content: "User prefers concise updates.",
      category: "preference",
      spaceType: "actor_private",
      importance: 0.9,
      confidence: 0.75,
      textDigest: "user update preference",
      tags: ["user", "updates", "style"],
    }
  )
})

test("parseCreateMemoryToolInput preserves defaults and scope alias", () => {
  assert.deepEqual(
    parseCreateMemoryToolInput({
      content: "Keep PRs small.",
      scope: " conversation_shared ",
      importance: "bad",
      confidence: undefined,
    }),
    {
      content: "Keep PRs small.",
      category: "fact",
      spaceType: "conversation_shared",
      importance: 0.5,
      confidence: 0.8,
      textDigest: undefined,
      tags: [],
    }
  )
  assert.deepEqual(parseCreateMemoryToolInput({ content: "Remember this." }), {
    content: "Remember this.",
    category: "fact",
    spaceType: "participant_private",
    importance: 0.5,
    confidence: 0.8,
    textDigest: undefined,
    tags: [],
  })
})

test("parseCreateMemoryToolInput rejects missing content", () => {
  assert.throws(
    () => parseCreateMemoryToolInput({ content: " " }),
    (error) =>
      error instanceof ToolExecutionError &&
      error.message === "content is required"
  )
})

test("parseRenameSelfToolInput normalizes and requires newName", () => {
  assert.deepEqual(parseRenameSelfToolInput({ newName: " Demo Agent " }), {
    newName: "Demo Agent",
  })
  assert.throws(
    () => parseRenameSelfToolInput({ newName: "" }),
    (error) =>
      error instanceof ToolExecutionError &&
      error.message === "newName is required"
  )
})
