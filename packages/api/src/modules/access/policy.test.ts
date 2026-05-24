import test from "node:test"
import assert from "node:assert/strict"
import { SUBJECT_KIND } from "@synapse/shared"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "./subject-registry.js"
import {
  assertConversationTypeMaskWithinParent,
  assertGrantConversationTypeOverrideAllowed,
  targetSupportsConversationTypeOverride,
  validateConversationScopedAccessTarget,
} from "./policy.js"

type AnyDb = import("kysely").Kysely<any>

test("targetSupportsConversationTypeOverride accepts workspace + actor only", () => {
  assert.equal(targetSupportsConversationTypeOverride("workspace"), true)
  assert.equal(targetSupportsConversationTypeOverride("actor"), true)
  assert.equal(
    targetSupportsConversationTypeOverride("workspace_member"),
    false
  )
  assert.equal(targetSupportsConversationTypeOverride("conversation"), false)
  assert.equal(
    targetSupportsConversationTypeOverride("actor_in_conversation"),
    false
  )
})

test("assertConversationTypeMaskWithinParent returns the parent mask when override is null/undefined", () => {
  const buildError = (m: string) => new Error(m)
  assert.equal(
    assertConversationTypeMaskWithinParent({
      parentConversationTypeMask: 0b11111,
      conversationTypeMaskOverride: null,
      buildError,
      invalidMaskMessage: "x",
    }),
    0b11111
  )
  assert.equal(
    assertConversationTypeMaskWithinParent({
      parentConversationTypeMask: 0b11111,
      conversationTypeMaskOverride: undefined,
      buildError,
      invalidMaskMessage: "x",
    }),
    0b11111
  )
})

test("assertConversationTypeMaskWithinParent narrows when override is a subset of parent", () => {
  const buildError = (m: string) => new Error(m)
  const mask = assertConversationTypeMaskWithinParent({
    parentConversationTypeMask: 0b11111,
    conversationTypeMaskOverride: 0b00011,
    buildError,
    invalidMaskMessage: "x",
  })
  assert.equal(mask, 0b00011)
})

test("assertConversationTypeMaskWithinParent throws when narrowing yields an invalid (empty) mask", () => {
  assert.throws(() =>
    assertConversationTypeMaskWithinParent({
      parentConversationTypeMask: 0b00001,
      conversationTypeMaskOverride: 0b00010, // disjoint
      buildError: (m) => new Error(m),
      invalidMaskMessage: "invalid",
    })
  )
})

test("assertGrantConversationTypeOverrideAllowed rejects an override on a conversation-scoped target", () => {
  assert.throws(() =>
    assertGrantConversationTypeOverrideAllowed({
      targetType: "conversation",
      parentConversationTypeMask: 0b11111,
      conversationTypeMaskOverride: 0b00001,
      buildError: (m) => new Error(m),
      invalidMaskMessage: "x",
    })
  )
})

test("assertGrantConversationTypeOverrideAllowed allows overrides on workspace + actor scopes", () => {
  const ws = assertGrantConversationTypeOverrideAllowed({
    targetType: "workspace",
    parentConversationTypeMask: 0b11111,
    conversationTypeMaskOverride: 0b00111,
    buildError: (m) => new Error(m),
    invalidMaskMessage: "x",
  })
  assert.equal(ws, 0b00111)
  const actor = assertGrantConversationTypeOverrideAllowed({
    targetType: "actor",
    parentConversationTypeMask: 0b11111,
    conversationTypeMaskOverride: null,
    buildError: (m) => new Error(m),
    invalidMaskMessage: "x",
  })
  assert.equal(actor, 0b11111)
})

test(
  "validateConversationScopedAccessTarget returns null for non-conversation-scoped targets",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const result = await validateConversationScopedAccessTarget({
        db,
        targetType: "workspace",
        effectiveConversationTypeMask: 0b11111,
        buildError: (m) => new Error(m),
      })
      assert.equal(result, null)
    })
  }
)

test(
  "validateConversationScopedAccessTarget throws when conversationId is missing",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      await assert.rejects(
        validateConversationScopedAccessTarget({
          db,
          targetType: "conversation",
          effectiveConversationTypeMask: 0b11111,
          buildError: (m) => new Error(m),
        }),
        /conversationId is required/
      )
    })
  }
)

test(
  "validateConversationScopedAccessTarget loads the conversation and matches the mask",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, ownerId)
      const conversationId = await insertConversation(db, workspaceId)
      const result = await validateConversationScopedAccessTarget({
        db,
        targetType: "conversation",
        conversationId,
        effectiveConversationTypeMask: 0b11111,
        buildError: (m) => new Error(m),
      })
      assert.ok(result)
      assert.equal(result?.conversationId, conversationId)
    })
  }
)

test(
  "validateConversationScopedAccessTarget rejects mismatched conversation type",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, ownerId)
      const conversationId = await insertConversation(db, workspaceId)
      // group + internal = bit 1; mask 0b10000 (virtual only) disallows it.
      await assert.rejects(
        validateConversationScopedAccessTarget({
          db,
          targetType: "conversation",
          conversationId,
          effectiveConversationTypeMask: 0b10000,
          buildError: (m) => new Error(m),
        }),
        /blocked by the current conversation type policy/
      )
    })
  }
)

test(
  "validateConversationScopedAccessTarget(actor_in_conversation) requires actorId AND active participant",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, ownerId)
      const conversationId = await insertConversation(db, workspaceId)
      const actorId = await insertActor(db, workspaceId)

      await assert.rejects(
        validateConversationScopedAccessTarget({
          db,
          targetType: "actor_in_conversation",
          conversationId,
          effectiveConversationTypeMask: 0b11111,
          buildError: (m) => new Error(m),
        }),
        /actorId is required/
      )

      await assert.rejects(
        validateConversationScopedAccessTarget({
          db,
          targetType: "actor_in_conversation",
          conversationId,
          actorId,
          effectiveConversationTypeMask: 0b11111,
          buildError: (m) => new Error(m),
        }),
        /active participant/
      )

      const actorSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId,
      })
      await db
        .insertInto("conversation_participants")
        .values({
          conversation_id: conversationId,
          participant_type: "actor",
          subject_id: actorSubjectId,
          state: "active",
        })
        .execute()
      const ok = await validateConversationScopedAccessTarget({
        db,
        targetType: "actor_in_conversation",
        conversationId,
        actorId,
        effectiveConversationTypeMask: 0b11111,
        buildError: (m) => new Error(m),
      })
      assert.ok(ok)
    })
  }
)

async function insertUser(db: AnyDb): Promise<string> {
  const row = await db
    .insertInto("users")
    .values({
      email: `u-${Math.random().toString(36).slice(2, 10)}@example.test`,
      name: "test user",
      password_hash: "unused-hash",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertWorkspace(db: AnyDb, ownerId: string): Promise<string> {
  const row = await db
    .insertInto("workspaces")
    .values({
      owner_id: ownerId,
      slug: `ws-${Math.random().toString(36).slice(2, 10)}`,
      name: "test workspace",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertConversation(
  db: AnyDb,
  workspaceId: string
): Promise<string> {
  const row = await db
    .insertInto("conversations")
    .values({
      kind: "group",
      boundary: "internal",
      internal_workspace_id: workspaceId,
      title: "test conversation",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertActor(db: AnyDb, workspaceId: string): Promise<string> {
  const row = await db
    .insertInto("actors")
    .values({
      workspace_id: workspaceId,
      name: "test actor",
      role: "assistant",
      title: "test",
      current_version: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}
