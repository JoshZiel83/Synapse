import assert from "node:assert/strict"
import test from "node:test"
import {
  decodeSessionCollaborationState,
  normalizeRuntimeToolCallRow,
  normalizeRuntimeToolCallTaskRow,
  normalizeRuntimeToolResultRow,
  normalizeSessionMessageItemRow,
  normalizeSessionRow,
  normalizeSessionWakeupRow,
} from "./repo.js"
import type {
  SessionDbRow,
  SessionMessageItemDbRow,
  SessionWakeupDbRow,
  ToolCallDbRow,
  ToolCallTaskDbRow,
  ToolResultDbRow,
} from "./repo.types.js"

test("decodeSessionCollaborationState decodes and validates collaboration_state JSON", () => {
  const decoded = decodeSessionCollaborationState(
    JSON.stringify({
      planDraft: {
        checklist: [{ step: "Ship", status: "pending" }],
        summary: "  summary  ",
      },
    })
  )

  assert.deepEqual(decoded, {
    planDraft: {
      checklist: [{ step: "Ship", status: "pending" }],
      summary: "summary",
      explanation: undefined,
      enteredAt: undefined,
    },
  })
})

test("decodeSessionCollaborationState rejects malformed collaboration_state JSON", () => {
  assert.throws(
    () => decodeSessionCollaborationState(JSON.stringify(["not-object"])),
    /collaboration_state must be valid JSON/i
  )
  assert.throws(
    () => decodeSessionCollaborationState({ activePlanApprovalTaskId: "task" }),
    /collaborationState\.activePlanApprovalTaskId is not allowed/i
  )
})

test("normalizeSessionRow decodes collaboration state at repo exit", () => {
  const row = normalizeSessionRow({
    collaborationState: JSON.stringify({
      planDraft: {
        checklist: [{ step: "Review", status: "completed" }],
      },
    }),
  } as SessionDbRow)

  assert.deepEqual(row.collaborationState, {
    planDraft: {
      checklist: [{ step: "Review", status: "completed" }],
      summary: undefined,
      explanation: undefined,
      enteredAt: undefined,
    },
  })
})

test("normalizeSessionMessageItemRow decodes item metadata at repo exit", () => {
  assert.deepEqual(
    normalizeSessionMessageItemRow({
      metadata: JSON.stringify({ silentActions: true }),
    } as SessionMessageItemDbRow).metadata,
    { silentActions: true }
  )
  assert.deepEqual(
    normalizeSessionMessageItemRow({
      metadata: JSON.stringify(["not-object"]),
    } as SessionMessageItemDbRow).metadata,
    {}
  )
})

test("normalizeSessionWakeupRow decodes wakeup metadata at repo exit", () => {
  assert.deepEqual(
    normalizeSessionWakeupRow({
      metadata: JSON.stringify({
        activationKind: "auto",
        delivery: "task_completion",
      }),
    } as SessionWakeupDbRow).metadata,
    {
      activationKind: "auto",
      delivery: "task_completion",
    }
  )

  assert.deepEqual(
    normalizeSessionWakeupRow({
      metadata: JSON.stringify(["not-object"]),
    } as SessionWakeupDbRow).metadata,
    {}
  )
})

test("normalizeRuntimeToolCallRow decodes tool call JSON at repo exit", () => {
  const row = normalizeRuntimeToolCallRow({
    normalizedInput: JSON.stringify({ path: "/tmp/a.txt" }),
    sourceSnapshot: JSON.stringify({ kind: "device", stableKey: "tool/a" }),
  } as ToolCallDbRow)

  assert.deepEqual(row.normalizedInput, { path: "/tmp/a.txt" })
  assert.deepEqual(row.sourceSnapshot, { kind: "device", stableKey: "tool/a" })
})

test("normalizeRuntimeToolResultRow decodes result metadata at repo exit", () => {
  const row = normalizeRuntimeToolResultRow({
    metadata: JSON.stringify({ toolMeta: { exit_code: 0 } }),
  } as ToolResultDbRow)

  assert.deepEqual(row.metadata, { toolMeta: { exit_code: 0 } })
})

test("normalizeRuntimeToolCallTaskRow decodes final payloads at repo exit", () => {
  const row = normalizeRuntimeToolCallTaskRow({
    finalResultPayload: JSON.stringify({ ok: true }),
    finalErrorPayload: JSON.stringify({ message: "failed" }),
  } as ToolCallTaskDbRow)

  assert.deepEqual(row.finalResultPayload, { ok: true })
  assert.deepEqual(row.finalErrorPayload, { message: "failed" })
})
