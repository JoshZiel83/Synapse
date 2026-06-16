import assert from "node:assert/strict"
import test from "node:test"

import {
  parseCancelTaskToolInput,
  parseGetTaskStatusToolInput,
  parseListTasksToolInput,
  parseSelfEventSubscriptionMatcherInput,
  parseTailTaskOutputToolInput,
} from "./session-tools-input-codec.js"
import { ToolExecutionError } from "./tool-errors.js"

test("parseSelfEventSubscriptionMatcherInput accepts absent and object matcher input", () => {
  assert.equal(parseSelfEventSubscriptionMatcherInput(undefined), undefined)
  assert.equal(parseSelfEventSubscriptionMatcherInput("   "), undefined)
  assert.equal(
    parseSelfEventSubscriptionMatcherInput({ ignored: true }),
    undefined
  )

  assert.deepEqual(
    parseSelfEventSubscriptionMatcherInput(
      JSON.stringify({
        kind: "deployment",
        labels: ["prod"],
        nested: { severity: "high" },
      })
    ),
    {
      kind: "deployment",
      labels: ["prod"],
      nested: { severity: "high" },
    }
  )
})

test("parseSelfEventSubscriptionMatcherInput rejects invalid JSON", () => {
  assert.throws(
    () => parseSelfEventSubscriptionMatcherInput("{"),
    (error) =>
      error instanceof ToolExecutionError &&
      error.message === "matcher must be valid JSON"
  )
})

test("parseSelfEventSubscriptionMatcherInput rejects non-object JSON", () => {
  for (const value of ["[]", "null", '"text"', "42", "true"]) {
    assert.throws(
      () => parseSelfEventSubscriptionMatcherInput(value),
      (error) =>
        error instanceof ToolExecutionError &&
        error.message === "matcher must be a JSON object string",
      value
    )
  }
})

test("parseListTasksToolInput normalizes status filters and limit", () => {
  assert.deepEqual(parseListTasksToolInput(undefined), {
    statuses: undefined,
    limit: 20,
  })
  assert.deepEqual(
    parseListTasksToolInput({
      statuses: [" working ", "unknown", "", "failed"],
      limit: 2.8,
    }),
    {
      statuses: ["working", "failed"],
      limit: 2,
    }
  )
  assert.deepEqual(parseListTasksToolInput({ statuses: "working", limit: 0 }), {
    statuses: undefined,
    limit: 1,
  })
})

test("task id tool inputs require a non-empty taskId", () => {
  assert.deepEqual(parseGetTaskStatusToolInput({ taskId: " task-1 " }), {
    taskId: "task-1",
  })
  assert.deepEqual(
    parseCancelTaskToolInput({
      taskId: " task-1 ",
      reason: " no longer needed ",
    }),
    {
      taskId: "task-1",
      reason: "no longer needed",
    }
  )

  for (const parser of [
    parseGetTaskStatusToolInput,
    parseCancelTaskToolInput,
    parseTailTaskOutputToolInput,
  ]) {
    assert.throws(
      () => parser({ taskId: "   " }),
      (error) =>
        error instanceof ToolExecutionError &&
        error.message === "taskId is required"
    )
  }
})

test("parseTailTaskOutputToolInput normalizes cursor, limit, and stream", () => {
  assert.deepEqual(
    parseTailTaskOutputToolInput({
      taskId: " task-1 ",
      afterSeq: -4.7,
      limit: 0,
      stream: " stderr ",
    }),
    {
      taskId: "task-1",
      afterSeq: 0,
      limit: 1,
      stream: "stderr",
    }
  )
  assert.deepEqual(
    parseTailTaskOutputToolInput({
      taskId: "task-2",
      afterSeq: 3.9,
      limit: 4.1,
      stream: "bogus",
    }),
    {
      taskId: "task-2",
      afterSeq: 3,
      limit: 4,
      stream: "combined",
    }
  )
})
