import test from "node:test"
import assert from "node:assert/strict"
import {
  SUBJECT_KIND,
  actorRef,
  conversationRef,
  remoteAgentRef,
  workspaceMemberRef,
  workspaceRef,
} from "@synapse/shared"
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
  assert.equal(
    targetSupportsConversationTypeOverride({ subject: workspaceRef("ws-1") }),
    true
  )
  assert.equal(
    targetSupportsConversationTypeOverride({ subject: actorRef("a-1") }),
    true
  )
  assert.equal(
    targetSupportsConversationTypeOverride({
      subject: workspaceMemberRef("m-1"),
    }),
    false
  )
  assert.equal(
    targetSupportsConversationTypeOverride({
      subject: conversationRef("c-1"),
    }),
    false
  )
  assert.equal(
    targetSupportsConversationTypeOverride({
      subject: actorRef("a-1"),
      scope: conversationRef("c-1"),
    }),
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
      target: { subject: conversationRef("c-1") },
      parentConversationTypeMask: 0b11111,
      conversationTypeMaskOverride: 0b00001,
      buildError: (m) => new Error(m),
      invalidMaskMessage: "x",
    })
  )
})

test("assertGrantConversationTypeOverrideAllowed allows overrides on workspace + actor scopes", () => {
  const ws = assertGrantConversationTypeOverrideAllowed({
    target: { subject: workspaceRef("ws-1") },
    parentConversationTypeMask: 0b11111,
    conversationTypeMaskOverride: 0b00111,
    buildError: (m) => new Error(m),
    invalidMaskMessage: "x",
  })
  assert.equal(ws, 0b00111)
  const actor = assertGrantConversationTypeOverrideAllowed({
    target: { subject: actorRef("a-1") },
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
        target: { subject: workspaceRef("ws-1") },
        effectiveConversationTypeMask: 0b11111,
        buildError: (m) => new Error(m),
      })
      assert.equal(result, null)
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
        target: { subject: conversationRef(conversationId) },
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
          target: { subject: conversationRef(conversationId) },
          effectiveConversationTypeMask: 0b10000,
          buildError: (m) => new Error(m),
        }),
        /blocked by the current conversation type policy/
      )
    })
  }
)

test(
  "validateConversationScopedAccessTarget(actor + scope=conversation) requires an active participant",
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
          target: {
            subject: actorRef(actorId),
            scope: conversationRef(conversationId),
          },
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
        target: {
          subject: actorRef(actorId),
          scope: conversationRef(conversationId),
        },
        effectiveConversationTypeMask: 0b11111,
        buildError: (m) => new Error(m),
      })
      assert.ok(ok)
    })
  }
)

test(
  "validateConversationScopedAccessTarget(remote_agent + scope=conversation) requires an active participant — round-8 P2",
  { timeout: 5 * 60_000 },
  async () => {
    // Round-8 P2 regression: validator used to only know about actor +
    // scope=conversation. The runtime visibility path matches
    // remote_agent_in_conversation (tool-resolver) so creation must
    // validate it too — otherwise a remote_agent + scope=conv grant
    // could be written for a remote agent that isn't in the
    // conversation.
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, ownerId)
      const conversationId = await insertConversation(db, workspaceId)
      const remoteAgentId = await insertRemoteAgent(db, workspaceId)

      // No participant row yet → must reject.
      await assert.rejects(
        validateConversationScopedAccessTarget({
          db,
          target: {
            subject: remoteAgentRef(remoteAgentId),
            scope: conversationRef(conversationId),
          },
          effectiveConversationTypeMask: 0b11111,
          buildError: (m) => new Error(m),
        }),
        /active participant/
      )

      // Add the participant row → must accept.
      const remoteAgentSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.REMOTE_AGENT,
        remoteAgentId,
      })
      await db
        .insertInto("conversation_participants")
        .values({
          conversation_id: conversationId,
          participant_type: "remote_agent",
          subject_id: remoteAgentSubjectId,
          state: "active",
        })
        .execute()
      const ok = await validateConversationScopedAccessTarget({
        db,
        target: {
          subject: remoteAgentRef(remoteAgentId),
          scope: conversationRef(conversationId),
        },
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

async function insertRemoteAgent(
  db: AnyDb,
  workspaceId: string
): Promise<string> {
  const row = await db
    .insertInto("remote_agents")
    .values({
      workspace_id: workspaceId,
      name: `agent-${Math.random().toString(36).slice(2, 10)}`,
      title: "test remote agent",
      runtime_kind: "claude_code",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}
