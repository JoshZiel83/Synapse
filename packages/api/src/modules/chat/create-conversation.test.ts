import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  CONVERSATION_PARTICIPANT_ROLE_KEY,
  CONVERSATION_PARTICIPANT_TYPE,
} from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { createChatConversationUseCase } from "./create-conversation.js"
import type { ChatConversationRecord } from "./presenter.js"

type AnyDb = Kysely<any>

async function seedCreateFixture(db: AnyDb) {
  const ownerUser = await db
    .insertInto("users")
    .values({
      email: `${randomUUID()}@create-conversation-owner.test`,
      name: "owner user",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const memberUser = await db
    .insertInto("users")
    .values({
      email: `${randomUUID()}@create-conversation-member.test`,
      name: "member user",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const workspace = await db
    .insertInto("workspaces")
    .values({
      ownerId: ownerUser.id as string,
      slug: `cc-${randomUUID().slice(0, 8)}`,
      name: "create conversation workspace",
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
  const invitedMember = await db
    .insertInto("workspaceMembers")
    .values({
      workspaceId: workspace.id as string,
      userId: memberUser.id as string,
      trustLevel: "member",
    })
    .returning("id")
    .executeTakeFirstOrThrow()

  return {
    workspaceId: workspace.id as string,
    ownerMemberId: ownerMember.id as string,
    invitedMemberId: invitedMember.id as string,
  }
}

function conversationRecord(
  workspaceId: string,
  workspaceMemberId: string,
  conversationId: string
): ChatConversationRecord {
  return {
    conversationId,
    workspaceId,
    baseTitle: "Created",
    kind: "group",
    isIm: false,
    unreadCount: 0,
    muted: false,
    archived: false,
    updatedAt: new Date("2026-06-15T00:00:00.000Z"),
    createdAt: new Date("2026-06-15T00:00:00.000Z"),
    participants: [],
    viewerWorkspaceMemberId: workspaceMemberId,
    viewerConversationRole: CONVERSATION_PARTICIPANT_ROLE_KEY.OWNER,
  }
}

test("createChatConversationUseCase creates once and reuses the client request id", async () => {
  await withTestDb(async (db) => {
    const fixture = await seedCreateFixture(db as unknown as AnyDb)
    const participantCalls: Array<{
      conversationId: string
      participantType: string
      workspaceMemberId?: string
      roleKey: string
    }> = []
    const syncCalls: Array<{
      workspaceId: string
      workspaceMemberIds: string[]
      conversationId: string
    }> = []
    const loadCalls: Array<{
      workspaceId: string
      workspaceMemberId: string
      conversationId: string
    }> = []

    const requestId = randomUUID()
    const deps = {
      insertParticipant: async (
        _queryable: unknown,
        params: {
          conversationId: string
          participantType: string
          workspaceMemberId?: string
          roleKey: string
        }
      ) => {
        participantCalls.push(params)
      },
      loadConversationView: async (
        _queryable: unknown,
        workspaceId: string,
        workspaceMemberId: string,
        conversationId: string
      ) => {
        loadCalls.push({ workspaceId, workspaceMemberId, conversationId })
        return conversationRecord(
          workspaceId,
          workspaceMemberId,
          conversationId
        )
      },
      syncConversationUpsert: async (
        _queryable: unknown,
        workspaceId: string,
        workspaceMemberIds: string[],
        conversationId: string
      ) => {
        syncCalls.push({ workspaceId, workspaceMemberIds, conversationId })
      },
    }

    const first = await createChatConversationUseCase(
      {
        workspaceId: fixture.workspaceId,
        creatorWorkspaceMemberId: fixture.ownerMemberId,
        clientRequestId: requestId,
        kind: "group",
        title: "Created",
        workspaceMemberIds: [fixture.invitedMemberId, fixture.ownerMemberId],
        queryable: db as unknown as AnyDb,
      },
      deps
    )
    const second = await createChatConversationUseCase(
      {
        workspaceId: fixture.workspaceId,
        creatorWorkspaceMemberId: fixture.ownerMemberId,
        clientRequestId: requestId,
        kind: "group",
        title: "Ignored on idempotent replay",
        workspaceMemberIds: ["00000000-0000-0000-0000-000000000000"],
        queryable: db as unknown as AnyDb,
      },
      deps
    )

    assert.equal(
      second.conversation.conversationId,
      first.conversation.conversationId
    )
    assert.equal(participantCalls.length, 2)
    assert.deepEqual(
      participantCalls
        .map((call) => ({
          participantType: call.participantType,
          workspaceMemberId: call.workspaceMemberId,
          roleKey: call.roleKey,
        }))
        .sort((a, b) =>
          a.workspaceMemberId!.localeCompare(b.workspaceMemberId!)
        ),
      [
        {
          participantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
          workspaceMemberId: fixture.invitedMemberId,
          roleKey: CONVERSATION_PARTICIPANT_ROLE_KEY.MEMBER,
        },
        {
          participantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
          workspaceMemberId: fixture.ownerMemberId,
          roleKey: CONVERSATION_PARTICIPANT_ROLE_KEY.OWNER,
        },
      ].sort((a, b) => a.workspaceMemberId.localeCompare(b.workspaceMemberId))
    )
    assert.equal(syncCalls.length, 1)
    assert.deepEqual(
      [...syncCalls[0]!.workspaceMemberIds].sort(),
      [fixture.ownerMemberId, fixture.invitedMemberId].sort()
    )
    assert.equal(
      syncCalls[0]!.conversationId,
      first.conversation.conversationId
    )
    assert.deepEqual(
      loadCalls.map((call) => call.conversationId),
      [first.conversation.conversationId, first.conversation.conversationId]
    )

    const conversations = await (db as unknown as AnyDb)
      .selectFrom("conversations")
      .select(["id", "title", "createdByWorkspaceMemberId"])
      .where("workspaceId", "=", fixture.workspaceId)
      .execute()
    assert.equal(conversations.length, 1)
    assert.equal(conversations[0]!.id, first.conversation.conversationId)
    assert.equal(conversations[0]!.title, "Created")
    assert.equal(
      conversations[0]!.createdByWorkspaceMemberId,
      fixture.ownerMemberId
    )

    const createRequests = await (db as unknown as AnyDb)
      .selectFrom("chatConversationCreateRequests")
      .select(["workspaceMemberId", "clientRequestId", "conversationId"])
      .where("workspaceMemberId", "=", fixture.ownerMemberId)
      .where("clientRequestId", "=", requestId)
      .execute()
    assert.deepEqual(createRequests, [
      {
        workspaceMemberId: fixture.ownerMemberId,
        clientRequestId: requestId,
        conversationId: first.conversation.conversationId,
      },
    ])

    const views = await (db as unknown as AnyDb)
      .selectFrom("workspaceMemberConversationViews")
      .select(["workspaceMemberId", "conversationId", "unreadCount"])
      .where("conversationId", "=", first.conversation.conversationId)
      .execute()
    assert.deepEqual(
      views
        .map((view) => ({
          workspaceMemberId: view.workspaceMemberId as string,
          conversationId: view.conversationId as string,
          unreadCount: Number(view.unreadCount),
        }))
        .sort((a, b) => a.workspaceMemberId.localeCompare(b.workspaceMemberId)),
      [
        {
          workspaceMemberId: fixture.invitedMemberId,
          conversationId: first.conversation.conversationId,
          unreadCount: 0,
        },
        {
          workspaceMemberId: fixture.ownerMemberId,
          conversationId: first.conversation.conversationId,
          unreadCount: 0,
        },
      ].sort((a, b) => a.workspaceMemberId.localeCompare(b.workspaceMemberId))
    )
  })
})
