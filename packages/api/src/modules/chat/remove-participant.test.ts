import test from "node:test"
import assert from "node:assert/strict"
import { SUBJECT_KIND } from "@synapse/shared"
import { withTestDbAndClient } from "../../test/helpers/db.js"
import { upsertAccessSubjectOn } from "../access/subject-registry.js"

type AnyDb = import("kysely").Kysely<any>

async function insertUser(db: AnyDb): Promise<string> {
  const row = await db
    .insertInto("users")
    .values({
      email: `u-${Math.random().toString(36).slice(2, 10)}@example.test`,
      name: "test user",
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
  const actorId = crypto.randomUUID()
  await db
    .insertInto("workspace_apps")
    .values({
      id: actorId,
      workspace_id: workspaceId,
      kind: "actor",
      display_name: "test actor",
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("actors")
    .values({
      id: actorId,
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
  const remoteAgentId = crypto.randomUUID()
  await db
    .insertInto("workspace_apps")
    .values({
      id: remoteAgentId,
      workspace_id: workspaceId,
      kind: "remote_agent",
      display_name: "test remote agent",
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("remote_agents")
    .values({
      id: remoteAgentId,
      title: "test",
      runtime_kind: "claude_code",
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
      workspace_id: workspaceId,
      title: "test conversation",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertConversationParticipant(
  db: AnyDb,
  conversationId: string,
  participantType: "workspace_member" | "actor" | "remote_agent",
  entityId: string,
  state: "active" | "left" | "removed" = "active"
): Promise<string> {
  const subjectId = await upsertAccessSubjectOn(db, {
    kind:
      participantType === "workspace_member"
        ? SUBJECT_KIND.WORKSPACE_MEMBER
        : participantType === "actor"
          ? SUBJECT_KIND.ACTOR
          : SUBJECT_KIND.REMOTE_AGENT,
    ...(participantType === "workspace_member"
      ? { memberId: entityId }
      : participantType === "actor"
        ? { actorId: entityId }
        : { remoteAgentId: entityId }),
  } as Parameters<typeof upsertAccessSubjectOn>[1])

  const row = await db
    .insertInto("conversation_participants")
    .values({
      conversation_id: conversationId,
      subject_id: subjectId,
      role_key: "member",
      state,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test(
  "loadParticipantById projects entity IDs from access_subjects (workspace_member)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const conversationId = await insertConversation(db, workspaceId)
      const participantId = await insertConversationParticipant(
        db,
        conversationId,
        "workspace_member",
        memberId
      )

      const { loadParticipantById } = await import("./service.js")
      const row = await loadParticipantById(db, conversationId, participantId)
      assert.ok(row, "expected a participant row")
      assert.equal(row.id, participantId)
      assert.equal(row.conversation_id, conversationId)
      assert.equal(row.participant_type, "workspace_member")
      assert.equal(row.workspace_member_id, memberId)
      assert.equal(row.actor_id, null)
      assert.equal(row.remote_agent_id, null)
      assert.equal(row.state, "active")
    })
  }
)

test(
  "loadParticipantById projects actor_id from access_subjects (actor)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const actorId = await insertActor(db, workspaceId)
      const conversationId = await insertConversation(db, workspaceId)
      const participantId = await insertConversationParticipant(
        db,
        conversationId,
        "actor",
        actorId
      )

      const { loadParticipantById } = await import("./service.js")
      const row = await loadParticipantById(db, conversationId, participantId)
      assert.ok(row)
      assert.equal(row.participant_type, "actor")
      assert.equal(row.actor_id, actorId)
      assert.equal(row.workspace_member_id, null)
      assert.equal(row.remote_agent_id, null)
    })
  }
)

test(
  "loadParticipantById projects remote_agent_id from access_subjects (remote_agent)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const remoteAgentId = await insertRemoteAgent(db, workspaceId)
      const conversationId = await insertConversation(db, workspaceId)
      const participantId = await insertConversationParticipant(
        db,
        conversationId,
        "remote_agent",
        remoteAgentId
      )

      const { loadParticipantById } = await import("./service.js")
      const row = await loadParticipantById(db, conversationId, participantId)
      assert.ok(row)
      assert.equal(row.participant_type, "remote_agent")
      assert.equal(row.remote_agent_id, remoteAgentId)
      assert.equal(row.workspace_member_id, null)
      assert.equal(row.actor_id, null)
    })
  }
)

test(
  "loadParticipantById returns null when participant does not exist in conversation",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const conversationId = await insertConversation(db, workspaceId)

      const { loadParticipantById } = await import("./service.js")
      const row = await loadParticipantById(
        db,
        conversationId,
        "00000000-0000-0000-0000-000000000000"
      )
      assert.equal(row, null)
    })
  }
)

test(
  "loadParticipantById is scoped by conversation (will not return a participant from a different conversation with the same id space)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const conversationA = await insertConversation(db, workspaceId)
      const conversationB = await insertConversation(db, workspaceId)
      const participantA = await insertConversationParticipant(
        db,
        conversationA,
        "workspace_member",
        memberId
      )

      const { loadParticipantById } = await import("./service.js")
      const sameConv = await loadParticipantById(
        db,
        conversationA,
        participantA
      )
      const wrongConv = await loadParticipantById(
        db,
        conversationB,
        participantA
      )
      assert.ok(sameConv)
      assert.equal(wrongConv, null)
    })
  }
)
