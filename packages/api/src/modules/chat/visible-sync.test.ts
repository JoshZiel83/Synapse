import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  CONVERSATION_ITEM_ROLE,
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_MESSAGE_SUBTYPE,
  CONVERSATION_PARTICIPANT_TYPE,
  type ChatConversationItem,
} from "@synapse/shared"
import type { Executor } from "../../infrastructure/database/kysely.js"
import type { ChatParticipantRow } from "./repo.js"
import {
  syncVisibleSharedItemUseCase,
  type SyncVisibleSharedItemDeps,
} from "./visible-sync.js"

function participant(
  values: Pick<ChatParticipantRow, "id" | "conversationId"> &
    Partial<ChatParticipantRow>
): ChatParticipantRow {
  return {
    participantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
    workspaceMemberId: null,
    actorId: null,
    remoteAgentId: null,
    actorJoinVersionId: null,
    displayName: null,
    roleKey: "member",
    state: "active",
    metadata: {},
    joinedAt: new Date("2026-06-16T00:00:00.000Z"),
    leftAt: null,
    userId: null,
    userName: null,
    participantName: null,
    participantTitle: null,
    participantRole: null,
    actorDocs: null,
    actorCanRepresentUser: null,
    actorSpecialties: null,
    actorConfig: null,
    actorCurrentVersion: null,
    participantAvatarEmoji: null,
    participantAvatarFileId: null,
    userAvatarFileId: null,
    transportAddressId: null,
    transportKind: null,
    transportExternalId: null,
    transportDisplayName: null,
    linkedUserId: null,
    linkedUserName: null,
    linkedUserAvatarFileId: null,
    sessionId: null,
    sessionStatus: null,
    ...values,
  }
}

function messageItem(values: Partial<ChatConversationItem> = {}) {
  return {
    id: randomUUID(),
    conversationId: randomUUID(),
    sequence: 42,
    itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
    subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
    role: CONVERSATION_ITEM_ROLE.USER,
    scope: CONVERSATION_ITEM_SCOPE.SHARED,
    surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
    content: "Visible message",
    contentBlocks: [
      { id: randomUUID(), type: "text", text: "Visible message" },
    ],
    metadata: {},
    createdAt: "2026-06-16T00:00:00.000Z",
    ...values,
  } as ChatConversationItem
}

function deps(calls: {
  unread: string[]
  upserts: unknown[]
  syncEvents: unknown[]
  conversationUpserts: unknown[]
}): SyncVisibleSharedItemDeps {
  return {
    countUnreadVisibleMessages: async (_queryable, _conversationId, id) => {
      calls.unread.push(id)
      return calls.unread.length
    },
    upsertConversationView: async (_queryable, params) => {
      calls.upserts.push(params)
    },
    appendWorkspaceMemberSyncEvent: async (_queryable, params) => {
      calls.syncEvents.push(params)
      return {} as never
    },
    syncConversationUpsert: async (
      _queryable,
      workspaceId,
      workspaceMemberIds,
      conversationId
    ) => {
      calls.conversationUpserts.push({
        workspaceId,
        workspaceMemberIds,
        conversationId,
      })
    },
  }
}

test("syncVisibleSharedItemUseCase updates targeted human participants and syncs recipients", async () => {
  const queryable = {} as Executor
  const workspaceId = randomUUID()
  const conversationId = randomUUID()
  const authorParticipantId = randomUUID()
  const authorWorkspaceMemberId = randomUUID()
  const targetParticipantId = randomUUID()
  const targetWorkspaceMemberId = randomUUID()
  const calls = {
    unread: [] as string[],
    upserts: [] as unknown[],
    syncEvents: [] as unknown[],
    conversationUpserts: [] as unknown[],
  }
  const item = messageItem({ conversationId })

  await syncVisibleSharedItemUseCase(
    {
      queryable,
      workspaceId,
      conversationId,
      item,
      authorParticipantId,
      restrictedAudienceParticipantIds: [targetParticipantId],
      activeParticipants: [
        participant({
          id: authorParticipantId,
          conversationId,
          workspaceMemberId: authorWorkspaceMemberId,
        }),
        participant({
          id: targetParticipantId,
          conversationId,
          workspaceMemberId: targetWorkspaceMemberId,
        }),
        participant({
          id: randomUUID(),
          conversationId,
          workspaceMemberId: randomUUID(),
        }),
        participant({
          id: randomUUID(),
          conversationId,
          participantType: CONVERSATION_PARTICIPANT_TYPE.ACTOR,
          actorId: randomUUID(),
        }),
      ],
    },
    deps(calls)
  )

  assert.deepEqual(calls.unread, [authorParticipantId, targetParticipantId])
  assert.deepEqual(
    calls.upserts.map(
      (entry) => (entry as { workspaceMemberId: string }).workspaceMemberId
    ),
    [authorWorkspaceMemberId, targetWorkspaceMemberId]
  )
  assert.deepEqual(
    calls.upserts.map(
      (entry) =>
        (entry as { summary: { previewText: string } }).summary.previewText
    ),
    ["Visible message", "Visible message"]
  )
  assert.deepEqual(
    calls.syncEvents.map(
      (entry) => (entry as { workspaceMemberId: string }).workspaceMemberId
    ),
    [authorWorkspaceMemberId, targetWorkspaceMemberId]
  )
  assert.deepEqual(calls.conversationUpserts, [
    {
      workspaceId,
      workspaceMemberIds: [authorWorkspaceMemberId, targetWorkspaceMemberId],
      conversationId,
    },
  ])
})

test("syncVisibleSharedItemUseCase without workspace only updates visible views", async () => {
  const conversationId = randomUUID()
  const firstParticipantId = randomUUID()
  const firstWorkspaceMemberId = randomUUID()
  const secondParticipantId = randomUUID()
  const secondWorkspaceMemberId = randomUUID()
  const calls = {
    unread: [] as string[],
    upserts: [] as unknown[],
    syncEvents: [] as unknown[],
    conversationUpserts: [] as unknown[],
  }

  await syncVisibleSharedItemUseCase(
    {
      queryable: {} as Executor,
      conversationId,
      item: messageItem({ conversationId }),
      activeParticipants: [
        participant({
          id: firstParticipantId,
          conversationId,
          workspaceMemberId: firstWorkspaceMemberId,
        }),
        participant({
          id: secondParticipantId,
          conversationId,
          workspaceMemberId: secondWorkspaceMemberId,
        }),
      ],
    },
    deps(calls)
  )

  assert.deepEqual(calls.unread, [firstParticipantId, secondParticipantId])
  assert.equal(calls.upserts.length, 2)
  assert.deepEqual(calls.syncEvents, [])
  assert.deepEqual(calls.conversationUpserts, [])
})
