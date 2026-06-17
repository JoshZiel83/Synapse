import assert from "node:assert/strict"
import test from "node:test"

import {
  RemoteAgentTaskPayloadError,
  normalizeRemoteAgentPlanChecklist,
  normalizeRemoteAgentUserInputQuestions,
} from "./task-request-payload.js"

function assertPayloadError(fn: () => unknown, message: string) {
  assert.throws(
    fn,
    (error) =>
      error instanceof RemoteAgentTaskPayloadError &&
      error.message === `invalid remote-agent task payload: ${message}`
  )
}

test("normalizeRemoteAgentUserInputQuestions accepts daemon question payloads", () => {
  assert.deepEqual(
    normalizeRemoteAgentUserInputQuestions([
      { id: "q1", question: "  Continue? ", type: "free_text" },
      { id: "q2", text: "Pick a mode", options: ["Fast", "Safe"] },
    ]),
    [
      {
        id: "q1",
        header: "Q1",
        type: "text",
        prompt: "Continue?",
        required: true,
        secret: false,
      },
      {
        id: "q2",
        header: "Q2",
        type: "single_select",
        prompt: "Pick a mode",
        required: true,
        options: [
          { id: "q2_option_1", label: "Fast" },
          { id: "q2_option_2", label: "Safe" },
        ],
        allowOther: false,
      },
    ]
  )
})

test("normalizeRemoteAgentUserInputQuestions accepts app-style options", () => {
  assert.deepEqual(
    normalizeRemoteAgentUserInputQuestions([
      {
        id: "scope",
        header: "Scope",
        type: "multi",
        prompt: "Select scope",
        description: "Choose all that apply",
        required: false,
        options: [
          { id: "a", label: "A", description: "Alpha" },
          { value: "b", preview: "Preview B" },
        ],
        allowOther: true,
        minSelections: 0.2,
        maxSelections: 2.8,
      },
    ]),
    [
      {
        id: "scope",
        header: "Scope",
        type: "multi_select",
        prompt: "Select scope",
        description: "Choose all that apply",
        required: false,
        options: [
          { id: "a", label: "A", description: "Alpha" },
          { id: "b", label: "b", preview: "Preview B" },
        ],
        allowOther: true,
        minSelections: 0,
        maxSelections: 2,
      },
    ]
  )
})

test("normalizeRemoteAgentUserInputQuestions rejects malformed questions", () => {
  assertPayloadError(
    () => normalizeRemoteAgentUserInputQuestions([]),
    "questions must contain at least one question"
  )
  assertPayloadError(
    () => normalizeRemoteAgentUserInputQuestions(["bad"]),
    "question 1 is invalid"
  )
  assertPayloadError(
    () => normalizeRemoteAgentUserInputQuestions([{ id: "q1" }]),
    "question 1 is missing prompt"
  )
  assertPayloadError(
    () =>
      normalizeRemoteAgentUserInputQuestions([
        { id: "q1", prompt: "One" },
        { id: "q1", prompt: "Two" },
      ]),
    'question id "q1" is duplicated'
  )
  assertPayloadError(
    () =>
      normalizeRemoteAgentUserInputQuestions([
        { id: "q1", prompt: "Pick", type: "single_select" },
      ]),
    "question 1 requires at least one option"
  )
})

test("normalizeRemoteAgentPlanChecklist accepts daemon and app checklist payloads", () => {
  assert.equal(normalizeRemoteAgentPlanChecklist(undefined), undefined)
  assert.deepEqual(
    normalizeRemoteAgentPlanChecklist([
      { id: "c1", text: "  Draft implementation ", done: false },
      { id: "c2", text: " Ship it ", done: true },
      { step: "Monitor", status: "in_progress" },
    ]),
    [
      { step: "Draft implementation", status: "pending" },
      { step: "Ship it", status: "completed" },
      { step: "Monitor", status: "in_progress" },
    ]
  )
})

test("normalizeRemoteAgentPlanChecklist rejects malformed checklist payloads", () => {
  assertPayloadError(
    () => normalizeRemoteAgentPlanChecklist("bad"),
    "checklist must be an array"
  )
  assertPayloadError(
    () => normalizeRemoteAgentPlanChecklist([null]),
    "checklist item 1 is invalid"
  )
  assertPayloadError(
    () => normalizeRemoteAgentPlanChecklist([{ id: "c1" }]),
    "checklist item 1 is missing step"
  )
  assertPayloadError(
    () =>
      normalizeRemoteAgentPlanChecklist([{ step: "Review", status: "done" }]),
    "checklist item 1 has invalid status"
  )
})
