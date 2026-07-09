import assert from "node:assert/strict"
import test from "node:test"
import {
  normalizeToolCallTaskOutputChunkRow,
  normalizeToolCallTaskRow,
} from "./repo.js"
import {
  presentToolCallTask,
  presentToolCallTaskOutputChunk,
} from "./presenter.js"
import type {
  ToolCallTaskOutputChunkRawRow,
  ToolCallTaskRawRow,
} from "./repo.types.js"

const NOW = new Date("2026-06-14T00:00:00.000Z")

function rawTaskRow(
  overrides: Partial<ToolCallTaskRawRow> = {}
): ToolCallTaskRawRow {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    workspaceId: "00000000-0000-4000-8000-000000000102",
    conversationId: "00000000-0000-4000-8000-000000000103",
    executorKind: "runtime_tool",
    deliveryKind: "session_wakeup",
    humanSurface: "silent",
    principalSubjectId: "00000000-0000-4000-8000-000000000104",
    sessionId: "00000000-0000-4000-8000-000000000105",
    remoteAgentRunId: null,
    turnId: null,
    sourceToolCallId: "tool-call-1",
    sourceToolName: "device.exec",
    lifecycleStatus: "working",
    outcome: null,
    statusMessage: null,
    supportsCancel: true,
    supportsOutputTail: true,
    revision: "1",
    requestKey: "tool-call:tool-call-1",
    requesterParticipantId: null,
    targetParticipantId: null,
    resolvedByParticipantId: null,
    resolvedAt: null,
    requestPayload: '{"command":"uptime"}',
    immediateResultPayload: { queued: true },
    finalResultPayload: '{"exitCode":0}',
    finalErrorPayload: null,
    metadata: '{"traceId":"trace-1"}',
    conversationItemId: null,
    completionItemId: null,
    deadlineAt: null,
    expiresAt: null,
    retentionTtlMs: null,
    retainUntil: null,
    cancelRequestedAt: null,
    cancelReason: null,
    lastOutputSeq: "0",
    lastOutputAt: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

test("tool-call task repo normalizer decodes JSONB payload fields before presentation", () => {
  const row = normalizeToolCallTaskRow(rawTaskRow())

  assert.deepEqual(row.requestPayload, { command: "uptime" })
  assert.deepEqual(row.immediateResultPayload, { queued: true })
  assert.deepEqual(row.finalResultPayload, { exitCode: 0 })
  assert.deepEqual(row.finalErrorPayload, {})
  assert.deepEqual(row.metadata, { traceId: "trace-1" })

  const presented = presentToolCallTask(row)
  assert.equal(presented?.createdAt, "2026-06-14T00:00:00.000Z")
  assert.deepEqual(presented?.requestPayload, { command: "uptime" })
  assert.deepEqual(presented?.metadata, { traceId: "trace-1" })
})

test("tool-call task repo normalizer rejects non-object JSON payload drift", () => {
  assert.throws(
    () =>
      normalizeToolCallTaskRow(
        rawTaskRow({
          requestPayload: JSON.stringify(["not", "an", "object"]),
        })
      ),
    /tool-call task requestPayload must be a JSON object/
  )

  assert.throws(
    () =>
      normalizeToolCallTaskRow(
        rawTaskRow({
          metadata: "not-json",
        })
      ),
    /tool-call task metadata must be valid JSON/
  )

  assert.throws(
    () =>
      normalizeToolCallTaskRow(
        rawTaskRow({
          immediateResultPayload: "42",
        })
      ),
    /tool-call task immediateResultPayload must be a JSON object/
  )
})

test("tool-call task output chunk repo normalizer decodes metadata before presentation", () => {
  const rawChunk: ToolCallTaskOutputChunkRawRow = {
    seq: "3",
    stream: "stdout",
    textValue: "hello",
    metadata: '{"line":"first"}',
    createdAt: NOW,
  }
  const row = normalizeToolCallTaskOutputChunkRow(rawChunk)

  assert.deepEqual(row.metadata, { line: "first" })

  const presented = presentToolCallTaskOutputChunk(row)
  assert.equal(presented.seq, 3)
  assert.equal(presented.createdAt, "2026-06-14T00:00:00.000Z")
  assert.deepEqual(presented.metadata, { line: "first" })
})

test("tool-call task output chunk repo normalizer rejects non-object metadata", () => {
  assert.throws(
    () =>
      normalizeToolCallTaskOutputChunkRow({
        seq: "3",
        stream: "stdout",
        textValue: "hello",
        metadata: JSON.stringify(["not", "an", "object"]),
        createdAt: NOW,
      }),
    /tool-call task output chunk metadata must be a JSON object/
  )
})
