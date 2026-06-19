import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  CHAT_MEMBERSHIP_UPDATE_REASON,
  CONVERSATION_PARTICIPANT_STATE,
  CONVERSATION_PARTICIPANT_TYPE,
  SUBJECT_KIND,
  type ChatParticipantSummary,
} from "@synapse/shared"
import { assertIsoInstantString } from "@synapse/shared/datetime"
import type { Kysely } from "kysely"
import { withTestDb, withTestDbAndClient } from "../../test/helpers/db.js"
import { upsertAccessSubjectOn } from "../access/subject-registry.js"
import { addConversationParticipantsUseCase } from "./add-participants.js"
import {
  ensureConversationParticipantUseCase,
  listConversationParticipantsUseCase,
} from "./participant-roster.js"
import type { ChatParticipantRow } from "./repo.js"

type AnyDb = Kysely<any>

async function seedReaddFixture(db: AnyDb) {
  const ownerUser = await db
    .insertInto("users")
    .values({
      email: `${randomUUID()}@add-participants-owner.test`,
      name: "owner user",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const readdUser = await db
    .insertInto("users")
    .values({
      email: `${randomUUID()}@add-participants-readd.test`,
      name: "readd user",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const workspace = await db
    .insertInto("workspaces")
    .values({
      ownerId: ownerUser.id as string,
      slug: `ap-${randomUUID().slice(0, 8)}`,
      name: "add participants workspace",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ownerMember = await db
    .insertInto("workspaceMembers")
    .values({
      workspaceId: workspace.id as string,
      userId: ownerUser.id as string,
      trustLevel: "member",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const readdMember = await db
    .insertInto("workspaceMembers")
    .values({
      workspaceId: workspace.id as string,
      userId: readdUser.id as string,
      trustLevel: "member",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const conversation = await db
    .insertInto("conversations")
    .values({
      workspaceId: workspace.id as string,
      kind: "group",
      title: "add participants conversation",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ownerSubjectId = await upsertAccessSubjectOn(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId: ownerMember.id as string,
  })
  const readdSubjectId = await upsertAccessSubjectOn(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId: readdMember.id as string,
  })
  await db
    .insertInto("conversationParticipants")
    .values({
      conversationId: conversation.id as string,
      subjectId: ownerSubjectId,
      roleKey: "owner",
      state: CONVERSATION_PARTICIPANT_STATE.ACTIVE,
      metadata: {},
    } as never)
    .execute()
  const readdParticipant = await db
    .insertInto("conversationParticipants")
    .values({
      conversationId: conversation.id as string,
      subjectId: readdSubjectId,
      roleKey: "member",
      state: CONVERSATION_PARTICIPANT_STATE.REMOVED,
      metadata: {},
    } as never)
    .returning("id")
    .executeTakeFirstOrThrow()
  await db
    .insertInto("workspaceMemberConversationViews")
    .values({
      workspaceMemberId: ownerMember.id as string,
      conversationId: conversation.id as string,
      unreadCount: 0,
    })
    .execute()

  return {
    workspaceId: workspace.id as string,
    ownerMemberId: ownerMember.id as string,
    readdMemberId: readdMember.id as string,
    conversationId: conversation.id as string,
    readdParticipantId: readdParticipant.id as string,
  }
}

async function insertActor(db: AnyDb, workspaceId: string): Promise<string> {
  const actorId = randomUUID()
  const createdBySubjectId = await upsertAccessSubjectOn(db, {
    kind: SUBJECT_KIND.PLATFORM,
  })
  await db
    .insertInto("workspaceResources")
    .values({
      id: actorId,
      workspaceId,
      kind: "actor",
      displayName: "add participant actor",
      createdBySubjectId,
      status: "active",
    } as never)
    .execute()
  const row = await db
    .insertInto("actors")
    .values({
      id: actorId,
      role: "assistant",
      title: "add participant actor",
      currentVersion: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertRemoteAgent(
  db: AnyDb,
  workspaceId: string
): Promise<string> {
  const remoteAgentId = randomUUID()
  const createdBySubjectId = await upsertAccessSubjectOn(db, {
    kind: SUBJECT_KIND.PLATFORM,
  })
  await db
    .insertInto("workspaceResources")
    .values({
      id: remoteAgentId,
      workspaceId,
      kind: "remote_agent",
      displayName: "add participant remote agent",
      createdBySubjectId,
      status: "active",
    } as never)
    .execute()
  const row = await db
    .insertInto("remoteAgents")
    .values({
      id: remoteAgentId,
      title: "add participant remote agent",
      runtimeKind: "codex",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test("addConversationParticipantsUseCase re-adds removed member and emits active membership event", async () => {
  await withTestDb(async (db) => {
    const fixture = await seedReaddFixture(db as unknown as AnyDb)
    const syncCalls: Array<{
      workspaceId: string
      workspaceMemberIds: string[]
      conversationId: string
    }> = []
    const participantSummary: ChatParticipantSummary = {
      participantId: fixture.readdParticipantId,
      conversationId: fixture.conversationId,
      participantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
      workspaceMemberId: fixture.readdMemberId,
      name: "readd user",
      roleKey: "member",
      state: CONVERSATION_PARTICIPANT_STATE.ACTIVE,
      metadata: {},
      joinedAt: assertIsoInstantString("2026-06-15T00:00:00.000Z"),
    }

    await addConversationParticipantsUseCase(
      {
        workspaceId: fixture.workspaceId,
        conversationId: fixture.conversationId,
        workspaceMemberIds: [fixture.readdMemberId],
        queryable: db as unknown as AnyDb,
      },
      {
        ensureConversationParticipant: async ({ queryable }) => {
          await (queryable as unknown as AnyDb)
            .updateTable("conversationParticipants")
            .set({
              state: CONVERSATION_PARTICIPANT_STATE.ACTIVE,
              leftAt: null,
            })
            .where("id", "=", fixture.readdParticipantId)
            .execute()
        },
        listConversationParticipants: async () => [
          {
            id: fixture.readdParticipantId,
            conversationId: fixture.conversationId,
            state: CONVERSATION_PARTICIPANT_STATE.ACTIVE,
          } as ChatParticipantRow,
        ],
        participantToSummary: () => participantSummary,
        syncConversationUpsert: async (
          _queryable,
          workspaceId,
          workspaceMemberIds,
          conversationId
        ) => {
          syncCalls.push({ workspaceId, workspaceMemberIds, conversationId })
        },
      }
    )

    const participant = await (db as unknown as AnyDb)
      .selectFrom("conversationParticipants")
      .select("state")
      .where("id", "=", fixture.readdParticipantId)
      .executeTakeFirstOrThrow()
    assert.equal(participant.state, CONVERSATION_PARTICIPANT_STATE.ACTIVE)

    const view = await (db as unknown as AnyDb)
      .selectFrom("workspaceMemberConversationViews")
      .select(["workspaceMemberId", "unreadCount"])
      .where("workspaceMemberId", "=", fixture.readdMemberId)
      .where("conversationId", "=", fixture.conversationId)
      .executeTakeFirstOrThrow()
    assert.equal(view.workspaceMemberId, fixture.readdMemberId)
    assert.equal(Number(view.unreadCount), 0)

    assert.deepEqual(syncCalls, [
      {
        workspaceId: fixture.workspaceId,
        workspaceMemberIds: [fixture.ownerMemberId, fixture.readdMemberId],
        conversationId: fixture.conversationId,
      },
    ])

    const events = await (db as unknown as AnyDb)
      .selectFrom("workspaceMemberSyncEvents")
      .select(["eventType", "payload"])
      .where("workspaceMemberId", "=", fixture.readdMemberId)
      .execute()
    assert.equal(events.length, 1)
    assert.equal(events[0]!.eventType, "conversation.membership.updated")
    const payload = events[0]!.payload as {
      selfState?: string
      reason?: string
      participants?: unknown[]
    }
    assert.equal(payload.selfState, CONVERSATION_PARTICIPANT_STATE.ACTIVE)
    assert.equal(payload.reason, CHAT_MEMBERSHIP_UPDATE_REASON.ADDED)
    assert.deepEqual(payload.participants, [participantSummary])
  })
})

test(
  "addConversationParticipantsUseCase rolls back re-add side effects when sync fails",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const fixture = await seedReaddFixture(db as unknown as AnyDb)

      await assert.rejects(async () => {
        await client.query("SAVEPOINT add_participants_rollback")
        try {
          await addConversationParticipantsUseCase(
            {
              workspaceId: fixture.workspaceId,
              conversationId: fixture.conversationId,
              workspaceMemberIds: [fixture.readdMemberId],
              queryable: db as unknown as AnyDb,
            },
            {
              ensureConversationParticipant: async ({ queryable }) => {
                await (queryable as unknown as AnyDb)
                  .updateTable("conversationParticipants")
                  .set({
                    state: CONVERSATION_PARTICIPANT_STATE.ACTIVE,
                    leftAt: null,
                  })
                  .where("id", "=", fixture.readdParticipantId)
                  .execute()
              },
              listConversationParticipants: async () => {
                throw new Error("membership event should not run")
              },
              participantToSummary: () => {
                throw new Error("unexpected participant summary mapping")
              },
              syncConversationUpsert: async () => {
                throw new Error("sync failed")
              },
            }
          )
          await client.query("RELEASE SAVEPOINT add_participants_rollback")
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT add_participants_rollback")
          throw error
        }
      }, /sync failed/)

      const participant = await (db as unknown as AnyDb)
        .selectFrom("conversationParticipants")
        .select("state")
        .where("id", "=", fixture.readdParticipantId)
        .executeTakeFirstOrThrow()
      assert.equal(participant.state, CONVERSATION_PARTICIPANT_STATE.REMOVED)

      const views = await (db as unknown as AnyDb)
        .selectFrom("workspaceMemberConversationViews")
        .select("workspaceMemberId")
        .where("workspaceMemberId", "=", fixture.readdMemberId)
        .where("conversationId", "=", fixture.conversationId)
        .execute()
      assert.deepEqual(views, [])

      const events = await (db as unknown as AnyDb)
        .selectFrom("workspaceMemberSyncEvents")
        .select("eventType")
        .where("workspaceMemberId", "=", fixture.readdMemberId)
        .execute()
      assert.deepEqual(events, [])
    })
  }
)

test("addConversationParticipantsUseCase actor-only add avoids member sync side effects", async () => {
  await withTestDb(async (db) => {
    const fixture = await seedReaddFixture(db as unknown as AnyDb)
    const actorId = await insertActor(
      db as unknown as AnyDb,
      fixture.workspaceId
    )
    let syncCalls = 0

    const participants = await addConversationParticipantsUseCase(
      {
        workspaceId: fixture.workspaceId,
        conversationId: fixture.conversationId,
        actorIds: [actorId],
        queryable: db as unknown as AnyDb,
      },
      {
        ensureConversationParticipant: ensureConversationParticipantUseCase,
        listConversationParticipants: listConversationParticipantsUseCase,
        participantToSummary: () => {
          throw new Error("membership summary should not run")
        },
        syncConversationUpsert: async () => {
          syncCalls += 1
          throw new Error("member sync should not run")
        },
      }
    )

    assert.equal(syncCalls, 0)
    const actorParticipant = participants.find(
      (participant) => participant.actorId === actorId
    )
    assert.equal(
      actorParticipant?.participantType,
      CONVERSATION_PARTICIPANT_TYPE.ACTOR
    )
    assert.equal(actorParticipant?.state, CONVERSATION_PARTICIPANT_STATE.ACTIVE)

    const views = await (db as unknown as AnyDb)
      .selectFrom("workspaceMemberConversationViews")
      .select("workspaceMemberId")
      .where("conversationId", "=", fixture.conversationId)
      .execute()
    assert.deepEqual(
      views.map((view) => view.workspaceMemberId),
      [fixture.ownerMemberId]
    )

    const events = await (db as unknown as AnyDb)
      .selectFrom("workspaceMemberSyncEvents")
      .select("eventType")
      .where("conversationId", "=", fixture.conversationId)
      .execute()
    assert.deepEqual(events, [])
  })
})

test("addConversationParticipantsUseCase remote-agent-only add avoids member sync side effects", async () => {
  await withTestDb(async (db) => {
    const fixture = await seedReaddFixture(db as unknown as AnyDb)
    const remoteAgentId = await insertRemoteAgent(
      db as unknown as AnyDb,
      fixture.workspaceId
    )
    let syncCalls = 0

    const participants = await addConversationParticipantsUseCase(
      {
        workspaceId: fixture.workspaceId,
        conversationId: fixture.conversationId,
        remoteAgentIds: [remoteAgentId],
        queryable: db as unknown as AnyDb,
      },
      {
        ensureConversationParticipant: ensureConversationParticipantUseCase,
        listConversationParticipants: listConversationParticipantsUseCase,
        participantToSummary: () => {
          throw new Error("membership summary should not run")
        },
        syncConversationUpsert: async () => {
          syncCalls += 1
          throw new Error("member sync should not run")
        },
      }
    )

    assert.equal(syncCalls, 0)
    const remoteAgentParticipant = participants.find(
      (participant) => participant.remoteAgentId === remoteAgentId
    )
    assert.equal(
      remoteAgentParticipant?.participantType,
      CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
    )
    assert.equal(
      remoteAgentParticipant?.state,
      CONVERSATION_PARTICIPANT_STATE.ACTIVE
    )

    const views = await (db as unknown as AnyDb)
      .selectFrom("workspaceMemberConversationViews")
      .select("workspaceMemberId")
      .where("conversationId", "=", fixture.conversationId)
      .execute()
    assert.deepEqual(
      views.map((view) => view.workspaceMemberId),
      [fixture.ownerMemberId]
    )

    const events = await (db as unknown as AnyDb)
      .selectFrom("workspaceMemberSyncEvents")
      .select("eventType")
      .where("conversationId", "=", fixture.conversationId)
      .execute()
    assert.deepEqual(events, [])
  })
})
