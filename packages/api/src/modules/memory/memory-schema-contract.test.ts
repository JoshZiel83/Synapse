import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { MEMORY_PERMISSION, SUBJECT_KIND } from "@synapse/shared"
import {
  CreateMemoryAccessGrantInputSchema,
  CreateMemoryInputSchema,
  MemoryAccessGrantEnvelopeViewSchema,
  MemoryAccessGrantRevokeResultViewSchema,
  MemoryItemEnvelopeViewSchema,
  MemoryListQuerySchema,
  MemoryMoveResultViewSchema,
  MemoryPermissionContextQuerySchema,
  MemoryRecallInputSchema,
  MemoryRecallResultViewSchema,
  MemorySearchInputSchema,
  MemorySearchResultViewSchema,
  MoveMemoryInputSchema,
  UpdateMemoryInputSchema,
} from "@synapse/shared/schemas"
import { presentMemoryAccessGrant } from "./presenter.js"

const NOW = "2026-06-13T00:00:00.000Z"

function uuid() {
  return crypto.randomUUID()
}

function memoryView(overrides: Record<string, unknown> = {}) {
  const id = uuid()
  return {
    id,
    workspaceId: uuid(),
    spaceId: uuid(),
    owner: {
      kind: SUBJECT_KIND.WORKSPACE,
      workspaceId: uuid(),
    },
    namespaceKey: "default",
    category: "fact",
    state: "active",
    status: "active",
    stability: "durable",
    importance: 0.7,
    confidence: 0.8,
    tags: ["architecture"],
    textDigest: "Use shared schemas for app contracts.",
    searchText: "Use shared schemas for app contracts.",
    contentBlocks: [{ id: uuid(), type: "text", text: "Shared contract" }],
    sourceItemId: undefined,
    sourceToolCallId: undefined,
    sourceTurnId: undefined,
    supersedesMemoryId: undefined,
    metadata: { source: "test" },
    indexStatus: "ready",
    embeddingModel: "text-embedding-3-small",
    embeddingDim: 1536,
    indexedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ownerLabel: "Workspace",
    ...overrides,
  }
}

test("CreateMemoryInputSchema parses preset payloads with canonical content blocks", () => {
  const parsed = CreateMemoryInputSchema.parse({
    preset: "participant_private",
    presetActorId: crypto.randomUUID(),
    presetConversationId: crypto.randomUUID(),
    category: "fact",
    contentBlocks: [
      { type: "text", text: "Important context" },
      {
        type: "mention",
        mention: {
          participantType: "actor",
          actorId: crypto.randomUUID(),
        },
      },
    ],
  })

  assert.equal(parsed.contentBlocks?.length, 2)
})

test("CreateMemoryInputSchema rejects empty memory content", () => {
  const result = CreateMemoryInputSchema.safeParse({
    preset: "workspace_shared",
    category: "fact",
  })

  assert.equal(result.success, false)
})

test("UpdateMemoryInputSchema accepts partial editable memory fields", () => {
  const parsed = UpdateMemoryInputSchema.parse({
    state: "archived",
    metadata: { reason: "manual cleanup" },
  })

  assert.equal(parsed.state, "archived")
})

test("memory input metadata is an open object record, not array or scalar", () => {
  const parsed = CreateMemoryInputSchema.parse({
    category: "fact",
    content: "Memory with opaque metadata",
    metadata: { nested: { ok: true }, score: 0.8 },
  })
  assert.deepEqual(parsed.metadata, { nested: { ok: true }, score: 0.8 })

  assert.equal(
    CreateMemoryInputSchema.safeParse({
      category: "fact",
      content: "bad",
      metadata: ["not", "a", "record"],
    }).success,
    false
  )
  assert.equal(
    MemorySearchInputSchema.safeParse({
      queryText: "bad",
      metadata: "not-a-record",
    }).success,
    false
  )
})

test("MemoryListQuerySchema parses comma-separated tags and coerced limits", () => {
  const parsed = MemoryListQuerySchema.parse({
    tags: "alpha, beta,,gamma",
    limit: "25",
  })

  assert.deepEqual(parsed.tags, ["alpha", "beta", "gamma"])
  assert.equal(parsed.limit, 25)
})

test("MemoryPermissionContextQuerySchema owns memory permission query context", () => {
  const conversationId = crypto.randomUUID()
  const parsed = MemoryPermissionContextQuerySchema.parse({
    conversationId,
  })

  assert.equal(parsed.conversationId, conversationId)
  assert.equal(
    MemoryPermissionContextQuerySchema.safeParse({
      conversation_id: conversationId,
    }).success,
    false
  )
})

test("MemorySearchInputSchema parses canonical owner and scope filters", () => {
  const parsed = MemorySearchInputSchema.parse({
    queryText: "design decision",
    owners: [
      {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId: crypto.randomUUID(),
      },
    ],
    scopes: [
      {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: crypto.randomUUID(),
      },
    ],
    categories: ["decision"],
    states: ["active"],
  })

  assert.equal(parsed.owners?.[0]?.kind, SUBJECT_KIND.WORKSPACE)
})

test("MemoryRecallInputSchema excludes manual_search recall type", () => {
  const valid = MemoryRecallInputSchema.safeParse({
    queryText: "project context",
    recallType: "turn_recall",
  })
  assert.equal(valid.success, true)

  const invalid = MemoryRecallInputSchema.safeParse({
    queryText: "project context",
    recallType: "manual_search",
  })
  assert.equal(invalid.success, false)
})

test("CreateMemoryAccessGrantInputSchema parses grant subjects and permissions", () => {
  const parsed = CreateMemoryAccessGrantInputSchema.parse({
    memoryItemId: null,
    subject: {
      kind: SUBJECT_KIND.ACTOR,
      actorId: crypto.randomUUID(),
    },
    scope: {
      kind: SUBJECT_KIND.CONVERSATION,
      conversationId: crypto.randomUUID(),
    },
    permissions: [MEMORY_PERMISSION.READ, MEMORY_PERMISSION.EDIT],
    source: "manual",
  })

  assert.equal(parsed.permissions.length, 2)
})

test("MoveMemoryInputSchema parses explicit target owner/scope", () => {
  const parsed = MoveMemoryInputSchema.parse({
    owner: {
      kind: SUBJECT_KIND.ACTOR,
      actorId: crypto.randomUUID(),
    },
    scope: {
      kind: SUBJECT_KIND.CONVERSATION,
      conversationId: crypto.randomUUID(),
    },
  })

  assert.equal(parsed.owner.kind, SUBJECT_KIND.ACTOR)
})

test("MemoryItemEnvelopeViewSchema validates full memory views", () => {
  const parsed = MemoryItemEnvelopeViewSchema.parse({
    memory: memoryView(),
  })

  assert.equal(parsed.memory.category, "fact")
})

test("MemorySearchResultViewSchema validates search runs and ranked memories", () => {
  const hit = {
    ...memoryView(),
    matchedChunkId: uuid(),
    rank: 1,
    finalScore: 0.92,
    vectorScore: 0.8,
    textScore: 0.7,
    similarityScore: 0.6,
    matchedTerms: ["shared", "schema"],
  }

  const parsed = MemorySearchResultViewSchema.parse({
    run: {
      id: uuid(),
      workspaceId: hit.workspaceId,
      recallType: "manual_search",
      queryText: "shared schema",
      queryBlocks: [{ id: uuid(), type: "text", text: "shared schema" }],
      metadata: {},
      createdAt: NOW,
      results: [hit],
    },
    memories: [hit],
  })

  assert.equal(parsed.memories[0]?.rank, 1)
})

test("MemoryRecallResultViewSchema validates recall reasons", () => {
  const hit = {
    ...memoryView(),
    rank: 1,
    finalScore: 0.95,
    recallReason: "Workspace-shared memory matched the current task",
  }

  const parsed = MemoryRecallResultViewSchema.parse({
    run: {
      id: uuid(),
      workspaceId: hit.workspaceId,
      recallType: "turn_recall",
      queryText: "current task",
      queryBlocks: [{ id: uuid(), type: "text", text: "current task" }],
      metadata: {},
      createdAt: NOW,
      results: [hit],
    },
    memories: [hit],
  })

  assert.equal(parsed.memories[0]?.recallReason, hit.recallReason)
})

test("MemoryMoveResultViewSchema validates thin out-of-view move responses", () => {
  const parsed = MemoryMoveResultViewSchema.parse({
    id: uuid(),
    spaceId: uuid(),
    moved: true,
  })

  assert.ok("moved" in parsed)
  assert.equal(parsed.moved, true)
})

test("presentMemoryAccessGrant output parses MemoryAccessGrantEnvelopeViewSchema", () => {
  const now = new Date(NOW)
  const parsed = MemoryAccessGrantEnvelopeViewSchema.parse({
    grant: presentMemoryAccessGrant({
      id: uuid(),
      workspaceId: uuid(),
      memorySpaceId: uuid(),
      memoryItemId: null,
      subjectId: uuid(),
      scopeSubjectId: null,
      permissions: [MEMORY_PERMISSION.READ],
      status: "active",
      source: "manual",
      createdByWorkspaceMemberId: null,
      sourceTaskId: null,
      revokedAt: null,
      supersededAt: null,
      createdAt: now,
      updatedAt: now,
    }),
  })

  assert.equal(parsed.grant.revokedAt, null)
  assert.equal(parsed.grant.createdAt, NOW)
})

test("MemoryAccessGrantRevokeResultViewSchema validates revoke result", () => {
  assert.deepEqual(
    MemoryAccessGrantRevokeResultViewSchema.parse({ revoked: true }),
    {
      revoked: true,
    }
  )
  assert.equal(
    MemoryAccessGrantRevokeResultViewSchema.safeParse({ revoked: "true" })
      .success,
    false
  )
})
