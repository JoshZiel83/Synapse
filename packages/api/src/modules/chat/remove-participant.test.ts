import test from "node:test"
import assert from "node:assert/strict"
import {
  CHAT_MEMBERSHIP_UPDATE_REASON,
  CHAT_PARTICIPANT_REMOVAL_STATE,
  CONVERSATION_FEED_EVENT_TYPE,
  SUBJECT_KIND,
} from "@synapse/shared"
import { withTestDbAndClient } from "../../test/helpers/db.js"
import type { DatabaseTransaction } from "../../infrastructure/database/kysely.js"
import { upsertAccessSubjectOn } from "../access/subject-registry.js"
import {
  leaveChatConversationUseCase,
  loadParticipantById,
  removeChatConversationParticipantUseCase,
} from "./remove-participant.js"

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
  // workspace_resources.created_by_subject_id is NOT NULL; mint a workspace-kind creator subject.
  const createdBySubjectId = (
    await db
      .insertInto("access_subjects")
      .values({ kind: "workspace", workspace_id: workspaceId } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id as string
  await db
    .insertInto("workspace_resources")
    .values({
      id: actorId,
      workspace_id: workspaceId,
      kind: "actor",
      display_name: "test actor",
      status: "active",
      created_by_subject_id: createdBySubjectId,
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
  // workspace_resources.created_by_subject_id is NOT NULL; mint a workspace-kind creator subject.
  const createdBySubjectId = (
    await db
      .insertInto("access_subjects")
      .values({ kind: "workspace", workspace_id: workspaceId } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id as string
  await db
    .insertInto("workspace_resources")
    .values({
      id: remoteAgentId,
      workspace_id: workspaceId,
      kind: "remote_agent",
      display_name: "test remote agent",
      status: "active",
      created_by_subject_id: createdBySubjectId,
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
  state: "active" | "left" | "removed" = "active",
  roleKey = "member"
): Promise<string> {
  function resolveKind() {
    switch (participantType) {
      case "workspace_member":
        return SUBJECT_KIND.WORKSPACE_MEMBER
      case "actor":
        return SUBJECT_KIND.ACTOR
      default:
        return SUBJECT_KIND.REMOTE_AGENT
    }
  }
  function resolveEntityRef() {
    switch (participantType) {
      case "workspace_member":
        return { workspaceMemberId: entityId }
      case "actor":
        return { actorId: entityId }
      default:
        return { remoteAgentId: entityId }
    }
  }
  const subjectId = await upsertAccessSubjectOn(db, {
    kind: resolveKind(),
    ...resolveEntityRef(),
  } as Parameters<typeof upsertAccessSubjectOn>[1])

  const row = await db
    .insertInto("conversation_participants")
    .values({
      conversation_id: conversationId,
      subject_id: subjectId,
      role_key: roleKey,
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
      assert.equal(row.conversationId, conversationId)
      assert.equal(row.participantType, "workspace_member")
      assert.equal(row.workspaceMemberId, memberId)
      assert.equal(row.actorId, null)
      assert.equal(row.remoteAgentId, null)
      assert.equal(row.state, "active")
    })
  }
)

test(
  "removeChatConversationParticipantUseCase updates state and emits membership removal event",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const ownerUserId = await insertUser(db)
      const targetUserId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, ownerUserId)
      const ownerMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        ownerUserId
      )
      const targetMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        targetUserId
      )
      const conversationId = await insertConversation(db, workspaceId)
      await insertConversationParticipant(
        db,
        conversationId,
        "workspace_member",
        ownerMemberId,
        "active",
        "owner"
      )
      const targetParticipantId = await insertConversationParticipant(
        db,
        conversationId,
        "workspace_member",
        targetMemberId
      )
      await db
        .insertInto("workspaceMemberConversationViews")
        .values({
          workspaceMemberId: ownerMemberId,
          conversationId,
          unreadCount: 0,
        })
        .execute()

      const removalEvents: unknown[] = []
      const syncCalls: Array<{
        workspaceId: string
        workspaceMemberIds: string[]
        conversationId: string
      }> = []
      const withTransaction = <T>(
        fn: (trx: DatabaseTransaction) => Promise<T>
      ) => fn(db as unknown as DatabaseTransaction)

      const result = await removeChatConversationParticipantUseCase(
        {
          workspaceId,
          workspaceMemberId: ownerMemberId,
          conversationId,
          participantId: targetParticipantId,
        },
        {
          createRemovalConversationEvent: async (event) => {
            removalEvents.push(event)
          },
          listConversationParticipants: async () => [],
          listConversationRealtimeRecipients: async () => [
            { workspaceMemberId: ownerMemberId },
          ],
          participantToSummary: () => {
            throw new Error("unexpected participant summary mapping")
          },
          syncConversationUpsert: async (
            _queryable,
            workspaceId,
            workspaceMemberIds,
            conversationId
          ) => {
            syncCalls.push({ workspaceId, workspaceMemberIds, conversationId })
          },
          withTransaction,
        }
      )

      assert.deepEqual(result, {
        conversationId,
        participantId: targetParticipantId,
        state: CHAT_PARTICIPANT_REMOVAL_STATE.REMOVED,
      })
      const targetAfter = await loadParticipantById(
        db,
        conversationId,
        targetParticipantId
      )
      assert.equal(targetAfter?.state, CHAT_PARTICIPANT_REMOVAL_STATE.REMOVED)
      assert.equal(removalEvents.length, 1)
      assert.equal(
        (removalEvents[0] as { eventType: string }).eventType,
        CONVERSATION_FEED_EVENT_TYPE.PARTICIPANT_KICKED
      )
      assert.deepEqual(syncCalls, [
        { workspaceId, workspaceMemberIds: [ownerMemberId], conversationId },
      ])

      const events = await db
        .selectFrom("workspaceMemberSyncEvents")
        .select(["eventType", "memberSeq", "payload"])
        .where("workspaceMemberId", "=", targetMemberId)
        .execute()
      assert.equal(events.length, 1)
      assert.equal(events[0]!.eventType, "conversation.membership.updated")
      assert.equal(Number(events[0]!.memberSeq), 1)
      const payload = events[0]!.payload as {
        selfState?: string
        reason?: string
      }
      assert.equal(payload.selfState, CHAT_PARTICIPANT_REMOVAL_STATE.REMOVED)
      assert.equal(payload.reason, CHAT_MEMBERSHIP_UPDATE_REASON.KICKED)
    })
  }
)

test(
  "removeChatConversationParticipantUseCase rolls back participant state when remaining-member sync fails",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const ownerUserId = await insertUser(db)
      const targetUserId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, ownerUserId)
      const ownerMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        ownerUserId
      )
      const targetMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        targetUserId
      )
      const conversationId = await insertConversation(db, workspaceId)
      const ownerParticipantId = await insertConversationParticipant(
        db,
        conversationId,
        "workspace_member",
        ownerMemberId,
        "active",
        "owner"
      )
      await insertConversationParticipant(
        db,
        conversationId,
        "workspace_member",
        targetMemberId
      )
      const ownerParticipant = await loadParticipantById(
        db,
        conversationId,
        ownerParticipantId
      )
      assert.ok(ownerParticipant)

      await assert.rejects(
        () =>
          removeChatConversationParticipantUseCase(
            {
              workspaceId,
              workspaceMemberId: ownerMemberId,
              conversationId,
              participantId: ownerParticipantId,
            },
            {
              createRemovalConversationEvent: async () => {},
              listConversationParticipants: async () => {
                throw new Error("tombstone should not run after sync failure")
              },
              listConversationRealtimeRecipients: async () => [
                { workspaceMemberId: targetMemberId },
              ],
              participantToSummary: () => {
                throw new Error("unexpected participant summary mapping")
              },
              syncConversationUpsert: async () => {
                throw new Error("sync failed")
              },
              requireConversationAccess: async () => ({
                participant: ownerParticipant,
              }),
              withTransaction: async (fn) => {
                await client.query("SAVEPOINT remove_participant_rollback")
                try {
                  const result = await fn(db as unknown as DatabaseTransaction)
                  await client.query(
                    "RELEASE SAVEPOINT remove_participant_rollback"
                  )
                  return result
                } catch (error) {
                  await client.query(
                    "ROLLBACK TO SAVEPOINT remove_participant_rollback"
                  )
                  throw error
                }
              },
            }
          ),
        /sync failed/
      )

      const targetAfter = await loadParticipantById(
        db,
        conversationId,
        ownerParticipantId
      )
      assert.equal(targetAfter?.state, "active")

      const events = await db
        .selectFrom("workspaceMemberSyncEvents")
        .select(["eventType"])
        .where("workspaceMemberId", "=", ownerMemberId)
        .execute()
      assert.deepEqual(events, [])
    })
  }
)

test(
  "leaveChatConversationUseCase resolves the caller participant before removal",
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
        memberId,
        "active",
        "owner"
      )
      await db
        .insertInto("workspaceMemberConversationViews")
        .values({
          workspaceMemberId: memberId,
          conversationId,
          unreadCount: 0,
        })
        .execute()
      const participant = await loadParticipantById(
        db,
        conversationId,
        participantId
      )
      assert.ok(participant)

      const removalEvents: unknown[] = []
      const withTransaction = <T>(
        fn: (trx: DatabaseTransaction) => Promise<T>
      ) => fn(db as unknown as DatabaseTransaction)

      const result = await leaveChatConversationUseCase(
        {
          workspaceId,
          workspaceMemberId: memberId,
          conversationId,
        },
        {
          createRemovalConversationEvent: async (event) => {
            removalEvents.push(event)
          },
          listConversationParticipants: async () => [],
          listConversationRealtimeRecipients: async () => [],
          participantToSummary: () => {
            throw new Error("unexpected participant summary mapping")
          },
          requireConversationAccess: async () => ({ participant }),
          syncConversationUpsert: async () => {},
          withTransaction,
        }
      )

      assert.deepEqual(result, {
        conversationId,
        participantId,
        state: CHAT_PARTICIPANT_REMOVAL_STATE.LEFT,
      })
      const participantAfter = await loadParticipantById(
        db,
        conversationId,
        participantId
      )
      assert.equal(participantAfter?.state, CHAT_PARTICIPANT_REMOVAL_STATE.LEFT)
      assert.equal(removalEvents.length, 1)
      assert.equal(
        (removalEvents[0] as { eventType: string }).eventType,
        CONVERSATION_FEED_EVENT_TYPE.PARTICIPANT_LEFT
      )
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
      assert.equal(row.participantType, "actor")
      assert.equal(row.actorId, actorId)
      assert.equal(row.workspaceMemberId, null)
      assert.equal(row.remoteAgentId, null)
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
      assert.equal(row.participantType, "remote_agent")
      assert.equal(row.remoteAgentId, remoteAgentId)
      assert.equal(row.workspaceMemberId, null)
      assert.equal(row.actorId, null)
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
