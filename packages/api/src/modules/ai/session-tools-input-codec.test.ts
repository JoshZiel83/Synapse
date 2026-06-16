import assert from "node:assert/strict"
import test from "node:test"

import {
  parseCancelTaskToolInput,
  parseGetTaskStatusToolInput,
  parseListTasksToolInput,
  parseScheduleSelfWakeupToolInput,
  parseSelfEventSubscriptionMatcherInput,
  parseSubscribeEventToolInput,
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

test("parseScheduleSelfWakeupToolInput normalizes automation schedule input", () => {
  assert.deepEqual(
    parseScheduleSelfWakeupToolInput({
      name: " Morning wakeup ",
      scheduleKind: " at ",
      scheduleExpr: "2026-06-17T10:00:00.000Z",
      intervalSeconds: 30.5,
      timezone: " Asia/Shanghai ",
      message: " check status ",
      wakeReason: " daily check ",
      activeUntil: "2026-06-18T10:00:00.000Z",
      maxTriggerCount: 2,
    }),
    {
      name: "Morning wakeup",
      scheduleKind: "at",
      scheduleExpr: "2026-06-17T10:00:00.000Z",
      intervalSeconds: 30.5,
      timezone: "Asia/Shanghai",
      message: "check status",
      wakeReason: "daily check",
      activeUntil: "2026-06-18T10:00:00.000Z",
      maxTriggerCount: 2,
      startsAt: "2026-06-17T10:00:00.000Z",
    }
  )
  assert.deepEqual(
    parseScheduleSelfWakeupToolInput({
      name: " Interval wakeup ",
      scheduleKind: "interval",
      message: "ping",
      maxTriggerCount: 2.5,
    }),
    {
      name: "Interval wakeup",
      scheduleKind: "interval",
      scheduleExpr: "",
      intervalSeconds: undefined,
      timezone: undefined,
      message: "ping",
      wakeReason: undefined,
      activeUntil: undefined,
      maxTriggerCount: undefined,
      startsAt: undefined,
    }
  )
})

test("parseScheduleSelfWakeupToolInput rejects invalid schedule input", () => {
  assert.throws(
    () =>
      parseScheduleSelfWakeupToolInput({
        name: "",
        scheduleKind: "at",
        message: "ping",
      }),
    (error) =>
      error instanceof ToolExecutionError &&
      error.message === "name and message are required"
  )
  assert.throws(
    () =>
      parseScheduleSelfWakeupToolInput({
        name: "wake",
        scheduleKind: "daily",
        message: "ping",
      }),
    (error) =>
      error instanceof ToolExecutionError &&
      error.message === "scheduleKind must be one of: cron, at, interval"
  )
  assert.throws(
    () =>
      parseScheduleSelfWakeupToolInput({
        name: "wake",
        scheduleKind: "at",
        scheduleExpr: "2026-06-17T10:00:00Z",
        message: "ping",
      }),
    (error) =>
      error instanceof ToolExecutionError &&
      error.message ===
        "scheduleExpr must be a canonical UTC ISO-8601 instant string with millisecond precision"
  )
})

test("parseSubscribeEventToolInput normalizes event subscription input", () => {
  assert.deepEqual(
    parseSubscribeEventToolInput({
      name: " Deploy notice ",
      eventSourceId: " source-1 ",
      matcher: JSON.stringify({ kind: "deploy", status: "failed" }),
      message: " wake me ",
      wakeReason: " deployment failed ",
      once: true,
      activeUntil: "2026-06-18T10:00:00.000Z",
      maxTriggerCount: 3,
    }),
    {
      name: "Deploy notice",
      eventSourceId: "source-1",
      matcher: { kind: "deploy", status: "failed" },
      message: "wake me",
      wakeReason: "deployment failed",
      once: true,
      activeUntil: "2026-06-18T10:00:00.000Z",
      maxTriggerCount: 3,
    }
  )
  assert.deepEqual(
    parseSubscribeEventToolInput({
      name: "Deploy notice",
      eventSourceId: "source-1",
      message: "wake me",
      once: "true",
      maxTriggerCount: 3.2,
    }),
    {
      name: "Deploy notice",
      eventSourceId: "source-1",
      matcher: undefined,
      message: "wake me",
      wakeReason: undefined,
      once: false,
      activeUntil: undefined,
      maxTriggerCount: undefined,
    }
  )
})

test("parseSubscribeEventToolInput rejects invalid event subscription input", () => {
  assert.throws(
    () =>
      parseSubscribeEventToolInput({
        name: "subscription",
        eventSourceId: "",
        message: "wake me",
      }),
    (error) =>
      error instanceof ToolExecutionError &&
      error.message === "name, eventSourceId, and message are required"
  )
  assert.throws(
    () =>
      parseSubscribeEventToolInput({
        name: "subscription",
        eventSourceId: "source-1",
        matcher: "{",
        message: "wake me",
      }),
    (error) =>
      error instanceof ToolExecutionError &&
      error.message === "matcher must be valid JSON"
  )
})
