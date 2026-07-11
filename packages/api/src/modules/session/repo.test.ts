import assert from "node:assert/strict"
import test from "node:test"
import { assertIsoInstantString } from "@synapse/shared/datetime"
import {
  decodeSessionCollaborationState,
  normalizeRuntimeToolCallRow,
  normalizeRuntimeToolCallTaskRow,
  normalizeRuntimeToolResultRow,
  normalizeSessionMessageItemRow,
  normalizeSessionRow,
  normalizeSessionWakeupRow,
  sessionCollaborationPatchToDbValues,
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

test("session collaboration patch serializes typed state at repo write boundary", () => {
  assert.deepEqual(
    sessionCollaborationPatchToDbValues({
      collaborationMode: "plan_drafting",
      collaborationState: {
        planDraft: {
          summary: "Plan",
          checklist: [{ step: "Review", status: "pending" }],
          explanation: "Need review",
          enteredAt: assertIsoInstantString("2026-06-17T00:00:00.000Z"),
        },
      },
      activePlanApprovalTaskId: null,
    }),
    {
      collaborationMode: "plan_drafting",
      collaborationState: {
        planDraft: {
          summary: "Plan",
          checklist: [{ step: "Review", status: "pending" }],
          explanation: "Need review",
          enteredAt: "2026-06-17T00:00:00.000Z",
        },
      },
      activePlanApprovalTaskId: null,
    }
  )
})

test("normalizeSessionMessageItemRow decodes item metadata at repo exit", () => {
  assert.deepEqual(
    normalizeSessionMessageItemRow({
      metadata: JSON.stringify({ silentActions: true }),
    } as SessionMessageItemDbRow).metadata,
    { silentActions: true }
  )
  assert.throws(
    () =>
      normalizeSessionMessageItemRow({
        metadata: JSON.stringify(["not-object"]),
      } as SessionMessageItemDbRow),
    /session message metadata must be a JSON object/
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

  assert.throws(
    () =>
      normalizeSessionWakeupRow({
        metadata: JSON.stringify(["not-object"]),
      } as SessionWakeupDbRow),
    /session wakeup metadata must be a JSON object/
  )
})

test("normalizeRuntimeToolCallRow decodes tool call JSON at repo exit", () => {
  const row = normalizeRuntimeToolCallRow({
    normalizedInput: JSON.stringify({ path: "/tmp/a.txt" }),
    sourceSnapshot: JSON.stringify({ kind: "runtime", stableKey: "tool/a" }),
  } as ToolCallDbRow)

  assert.deepEqual(row.normalizedInput, { path: "/tmp/a.txt" })
  assert.deepEqual(row.sourceSnapshot, { kind: "runtime", stableKey: "tool/a" })

  assert.throws(
    () =>
      normalizeRuntimeToolCallRow({
        normalizedInput: JSON.stringify(["not-object"]),
        sourceSnapshot: JSON.stringify({ kind: "runtime" }),
      } as ToolCallDbRow),
    /runtime tool call normalizedInput must be a JSON object/
  )
  assert.throws(
    () =>
      normalizeRuntimeToolCallRow({
        normalizedInput: JSON.stringify({ path: "/tmp/a.txt" }),
        sourceSnapshot: "not-json",
      } as ToolCallDbRow),
    /runtime tool call sourceSnapshot must be valid JSON/
  )
})

test("normalizeRuntimeToolResultRow decodes result metadata at repo exit", () => {
  const row = normalizeRuntimeToolResultRow({
    metadata: JSON.stringify({ toolMeta: { exit_code: 0 } }),
  } as ToolResultDbRow)

  assert.deepEqual(row.metadata, { toolMeta: { exit_code: 0 } })

  assert.throws(
    () =>
      normalizeRuntimeToolResultRow({
        metadata: JSON.stringify(["not-object"]),
      } as ToolResultDbRow),
    /runtime tool result metadata must be a JSON object/
  )
})

test("normalizeRuntimeToolCallTaskRow decodes final payloads at repo exit", () => {
  const row = normalizeRuntimeToolCallTaskRow({
    finalResultPayload: JSON.stringify({ ok: true }),
    finalErrorPayload: JSON.stringify({ message: "failed" }),
  } as ToolCallTaskDbRow)

  assert.deepEqual(row.finalResultPayload, { ok: true })
  assert.deepEqual(row.finalErrorPayload, { message: "failed" })
})

test("normalizeRuntimeToolCallTaskRow rejects non-object final payloads", () => {
  assert.throws(
    () =>
      normalizeRuntimeToolCallTaskRow({
        finalResultPayload: JSON.stringify(["not-object"]),
        finalErrorPayload: JSON.stringify({ message: "failed" }),
      } as ToolCallTaskDbRow),
    /runtime tool call task finalResultPayload must be a JSON object/
  )
  assert.throws(
    () =>
      normalizeRuntimeToolCallTaskRow({
        finalResultPayload: JSON.stringify({ ok: true }),
        finalErrorPayload: "not-json",
      } as ToolCallTaskDbRow),
    /runtime tool call task finalErrorPayload must be valid JSON/
  )
})
