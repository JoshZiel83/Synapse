import test from "node:test"
import assert from "node:assert/strict"
import { SUBJECT_KIND } from "@synapse/shared"
import { upsertAccessSubject } from "./subject-registry.js"
import { withTestDb } from "../../test/helpers/db.js"
import {
  buildConversationCapabilitySubjects,
  isActorActiveConversationParticipant,
} from "./subject-resolution.js"

type AnyDb = import("kysely").Kysely<any>

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

async function insertWorkspaceMember(
  db: AnyDb,
  workspaceId: string,
  userId: string
): Promise<string> {
  const row = await db
    .insertInto("workspace_members")
    .values({
      workspace_id: workspaceId,
      user_id: userId,
      trust_level: "member",
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

async function addActiveActorParticipant(
  db: AnyDb,
  conversationId: string,
  actorId: string
): Promise<void> {
  const subjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.ACTOR,
    actorId,
  })
  await db
    .insertInto("conversation_participants")
    .values({
      conversation_id: conversationId,
      subject_id: subjectId,
      state: "active",
    })
    .execute()
}

test(
  "isActorActiveConversationParticipant returns false when no participant row exists",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const actorId = await insertActor(db, workspaceId)
      const conversationId = await insertConversation(db, workspaceId)

      assert.equal(
        await isActorActiveConversationParticipant(db, conversationId, actorId),
        false
      )
    })
  }
)

test(
  "isActorActiveConversationParticipant returns true once an active actor participant is added",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const actorId = await insertActor(db, workspaceId)
      const conversationId = await insertConversation(db, workspaceId)
      await addActiveActorParticipant(db, conversationId, actorId)

      assert.equal(
        await isActorActiveConversationParticipant(db, conversationId, actorId),
        true
      )
    })
  }
)

test(
  "buildConversationCapabilitySubjects returns only workspace when no actor/member supplied",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const subjects = await buildConversationCapabilitySubjects(db, {
        workspaceId,
      })
      assert.deepEqual(subjects, [{ type: "workspace", id: workspaceId }])
    })
  }
)

test(
  "buildConversationCapabilitySubjects adds workspace_member when workspaceMemberId is provided",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const subjects = await buildConversationCapabilitySubjects(db, {
        workspaceId,
        workspaceMemberId: memberId,
      })
      assert.deepEqual(subjects, [
        { type: "workspace", id: workspaceId },
        { type: "workspace_member", id: memberId },
      ])
    })
  }
)

test(
  "buildConversationCapabilitySubjects returns empty when actor is not an active participant",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const actorId = await insertActor(db, workspaceId)
      const conversationId = await insertConversation(db, workspaceId)
      // intentionally NO conversation_participants row

      const subjects = await buildConversationCapabilitySubjects(db, {
        workspaceId,
        actorId,
        conversationId,
      })
      assert.deepEqual(subjects, [])
    })
  }
)

test(
  "buildConversationCapabilitySubjects adds actor (no CAC subject) for active participant",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const actorId = await insertActor(db, workspaceId)
      const conversationId = await insertConversation(db, workspaceId)
      await addActiveActorParticipant(db, conversationId, actorId)

      const subjects = await buildConversationCapabilitySubjects(db, {
        workspaceId,
        workspaceMemberId: memberId,
        actorId,
        conversationId,
      })
      // D2: previously also pushed a `conversation_actor_context` subject;
      // that kind is gone — the actor + conversation runtime context now
      // matches `actor + scope=conversation` grants instead.
      assert.deepEqual(subjects, [
        { type: "workspace", id: workspaceId },
        { type: "workspace_member", id: memberId },
        { type: "actor", id: actorId },
      ])
    })
  }
)

test(
  "buildConversationCapabilitySubjects dedupes when the same subject is reachable through multiple inputs",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const actorId = await insertActor(db, workspaceId)
      const conversationId = await insertConversation(db, workspaceId)
      await addActiveActorParticipant(db, conversationId, actorId)

      // D2: the conversationActorContextId param is gone; the function now
      // produces the workspace + actor subjects only — they should be unique.
      const subjects = await buildConversationCapabilitySubjects(db, {
        workspaceId,
        actorId,
        conversationId,
      })
      const keys = subjects.map((s) => `${s.type}:${s.id}`)
      assert.equal(new Set(keys).size, keys.length)
    })
  }
)
