import assert from "node:assert/strict"
import test from "node:test"

import {
  codexTurnStartParamsToRequestParams,
  parseCodexElicitationRequest,
  parseCodexPlanUpdated,
  parseCodexUserInputRequest,
  readCodexElicitationContent,
  readCodexThreadResult,
  readCodexThreadStartedId,
  readCodexTurnCompletedError,
  readCodexUserInputAnswers,
} from "./codex-driver-events.js"

test("readCodexThreadStartedId reads generated thread notification shape", () => {
  assert.equal(
    readCodexThreadStartedId({ thread: { id: "thread-1" } }),
    "thread-1"
  )
  assert.equal(readCodexThreadStartedId({ thread: { id: 123 } }), undefined)
  assert.equal(readCodexThreadStartedId(null), undefined)
})

test("parseCodexUserInputRequest normalizes generated question payloads", () => {
  assert.deepEqual(
    parseCodexUserInputRequest({
      questions: [{ id: "q1", question: "  Need input? " }, "drifted-question"],
    }),
    {
      title: "Need input?",
      questions: [{ id: "q1", question: "  Need input? " }],
    }
  )
  assert.deepEqual(parseCodexUserInputRequest({ questions: "bad" }), {
    title: "Question from Codex",
    questions: [],
  })
})

test("readCodexThreadResult reads thread id variants and model", () => {
  assert.deepEqual(
    readCodexThreadResult(
      { thread: { threadId: "thread-fallback-shape" }, model: "gpt-5" },
      undefined
    ),
    { threadId: "thread-fallback-shape", model: "gpt-5" }
  )
  assert.deepEqual(readCodexThreadResult({}, "existing-thread"), {
    threadId: "existing-thread",
    model: undefined,
  })
})

test("parseCodexPlanUpdated normalizes plan updates", () => {
  assert.deepEqual(
    parseCodexPlanUpdated({
      explanation: "working",
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "", status: "pending" },
        { step: "Patch" },
      ],
    }),
    {
      explanation: "working",
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Patch", status: "pending" },
      ],
    }
  )
})

test("readCodexTurnCompletedError extracts nested error message", () => {
  assert.equal(
    readCodexTurnCompletedError({
      turn: { error: { message: "turn failed" } },
    }),
    "turn failed"
  )
  assert.equal(readCodexTurnCompletedError({ turn: { error: {} } }), undefined)
})

test("readCodexUserInputAnswers extracts answer map from permission decision", () => {
  assert.deepEqual(
    readCodexUserInputAnswers({
      behavior: "allow",
      updatedInput: { answers: { q1: { answers: ["yes"] } } },
    }),
    { q1: { answers: ["yes"] } }
  )
  assert.deepEqual(readCodexUserInputAnswers({ behavior: "allow" }), {})
  assert.deepEqual(
    readCodexUserInputAnswers({ behavior: "deny", message: "no" }),
    {}
  )
})

test("parseCodexElicitationRequest maps form schema to user-input questions", () => {
  assert.deepEqual(
    parseCodexElicitationRequest({
      message: " Fill the form ",
      serverName: "calendar",
      requestedSchema: {
        properties: {
          room: {
            title: "Room",
            description: "Choose room",
            enum: ["A", "B"],
          },
          notes: { description: "Notes" },
        },
      },
    }),
    {
      title: "Fill the form",
      questions: [
        {
          id: "room",
          header: "Room",
          type: "single_select",
          prompt: "Choose room",
          required: true,
          options: [
            { id: "option-1-1", label: "A" },
            { id: "option-1-2", label: "B" },
          ],
        },
        {
          id: "notes",
          header: "Field 2",
          type: "free_text",
          prompt: "Notes",
          required: true,
        },
      ],
    }
  )
})

test("readCodexElicitationContent accepts only JSON-compatible answers", () => {
  assert.deepEqual(
    readCodexElicitationContent({
      behavior: "allow",
      updatedInput: { answers: { room: "A", count: 1 } },
    }),
    { room: "A", count: 1 }
  )
  assert.equal(
    readCodexElicitationContent({
      behavior: "allow",
      updatedInput: { answers: { bad: Number.POSITIVE_INFINITY } },
    }),
    null
  )
  assert.equal(
    readCodexElicitationContent({ behavior: "deny", message: "no" }),
    null
  )
})

test("codexTurnStartParamsToRequestParams preserves turn/start payload fields", () => {
  assert.deepEqual(
    codexTurnStartParamsToRequestParams({
      threadId: "thread-1",
      input: [{ type: "text", text: "hello", text_elements: [] }],
      cwd: "/tmp/project",
    }),
    {
      threadId: "thread-1",
      input: [{ type: "text", text: "hello", text_elements: [] }],
      cwd: "/tmp/project",
    }
  )
})
