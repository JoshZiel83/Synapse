import assert from "node:assert/strict"
import test from "node:test"
import { SUBJECT_KIND } from "@synapse/shared"
import { normalizeMemoryRow } from "./repo.js"
import { presentMemoryRow } from "./presenter.js"
import type { MemoryRow } from "./repo.types.js"

function memoryRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    memorySpaceId: "00000000-0000-4000-8000-000000000003",
    spaceOwnerSubjectId: "00000000-0000-4000-8000-000000000004",
    spaceScopeSubjectId: null,
    spaceNamespaceKey: "default",
    ownerKind: SUBJECT_KIND.WORKSPACE,
    ownerWorkspaceId: "00000000-0000-4000-8000-000000000002",
    ownerWorkspaceMemberId: null,
    ownerActorId: null,
    ownerRemoteAgentId: null,
    ownerConversationId: null,
    scopeKind: null,
    scopeWorkspaceIdViaJoin: null,
    scopeConversationIdViaJoin: null,
    category: "fact",
    state: "active",
    importance: 0.5,
    confidence: 0.8,
    tags: ["project"],
    textDigest: "remember the plan",
    searchText: "remember the plan",
    indexStatus: "ready",
    embeddingModel: "test-model",
    embeddingDim: 384,
    indexedAt: null,
    indexError: null,
    sourceItemId: null,
    sourceToolCallId: null,
    sourceTurnId: null,
    supersedesItemId: null,
    metadata: {},
    createdAt: new Date("2026-06-14T00:00:00.000Z"),
    updatedAt: new Date("2026-06-14T00:00:00.000Z"),
    ownerLabel: null,
    scopeLabel: null,
    ...overrides,
  }
}

test("normalizeMemoryRow decodes metadata at repo exit", () => {
  const row = normalizeMemoryRow(
    memoryRow({
      metadata: JSON.stringify({
        source: "manual",
        pinned: true,
      }) as unknown as MemoryRow["metadata"],
    })
  )

  assert.deepEqual(row.metadata, {
    source: "manual",
    pinned: true,
  })

  const memory = presentMemoryRow(row, [])
  assert.deepEqual(memory.metadata, {
    source: "manual",
    pinned: true,
  })
})

test("normalizeMemoryRow rejects malformed metadata at repo exit", () => {
  assert.throws(
    () =>
      normalizeMemoryRow(
        memoryRow({
          metadata: "not json" as unknown as MemoryRow["metadata"],
        })
      ),
    /memory item metadata must be valid JSON/
  )
})

test("normalizeMemoryRow rejects non-object metadata at repo exit", () => {
  assert.throws(
    () =>
      normalizeMemoryRow(
        memoryRow({
          metadata: JSON.stringify([
            "not-object",
          ]) as unknown as MemoryRow["metadata"],
        })
      ),
    /memory item metadata must be a JSON object/
  )
})
