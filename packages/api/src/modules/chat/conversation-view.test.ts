import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  CONVERSATION_ITEM_ROLE,
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_KIND,
  CONVERSATION_MESSAGE_SUBTYPE,
  CONVERSATION_PARTICIPANT_ROLE_KEY,
  CONVERSATION_PARTICIPANT_STATE,
  CONVERSATION_PARTICIPANT_TYPE,
  type ChatConversationItem,
  type ChatParticipantSummary,
} from "@synapse/shared"
import type { Executor } from "../../infrastructure/database/kysely.js"
import type {
  ChatConversationBaseRow,
  ChatConversationItemRow,
  ChatParticipantRow,
} from "./repo.js"
import {
  loadConversationViewUseCase,
  loadConversationViewsUseCase,
  type LoadConversationViewsDeps,
} from "./conversation-view.js"

const CREATED_AT = new Date("2026-06-16T00:00:00.000Z")
const UPDATED_AT = new Date("2026-06-16T00:01:00.000Z")

function baseRow(
  values: Pick<ChatConversationBaseRow, "conversationId"> &
    Partial<ChatConversationBaseRow>
): ChatConversationBaseRow {
  return {
    kind: CONVERSATION_KIND.GROUP,
    isIm: false,
    title: "Project room",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    unreadCount: 0,
    muted: false,
    archived: false,
    pinnedSortKey: null,
    lastVisibleItemId: null,
    lastVisibleSequence: 0,
    lastVisibleAt: null,
    ...values,
  }
}

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
    roleKey: CONVERSATION_PARTICIPANT_ROLE_KEY.MEMBER,
    state: CONVERSATION_PARTICIPANT_STATE.ACTIVE,
    metadata: {},
    joinedAt: CREATED_AT,
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
    sequence: 7,
    itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
    subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
    role: CONVERSATION_ITEM_ROLE.USER,
    scope: CONVERSATION_ITEM_SCOPE.SHARED,
    surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
    content: "Hello from item content",
    contentBlocks: [
      { id: randomUUID(), type: "text", text: "Hello from blocks" },
    ],
    metadata: {},
    createdAt: "2026-06-16T00:02:00.000Z",
    ...values,
  } as ChatConversationItem
}

function participantSummary(row: ChatParticipantRow): ChatParticipantSummary {
  return {
    participantId: row.id,
    conversationId: row.conversationId,
    participantType: row.participantType,
    workspaceMemberId: row.workspaceMemberId ?? undefined,
    actorId: row.actorId ?? undefined,
    remoteAgentId: row.remoteAgentId ?? undefined,
    name: row.displayName ?? row.participantName ?? "Participant",
    roleKey: row.roleKey,
    state: row.state,
    metadata: row.metadata,
    joinedAt: "2026-06-16T00:00:00.000Z",
    leftAt: row.leftAt?.toISOString(),
    sessionId: row.sessionId ?? undefined,
    sessionStatus: row.sessionStatus ?? undefined,
  }
}

test("loadConversationViewsUseCase builds conversation records from listed rows", async () => {
  const queryable = {} as Executor
  const workspaceId = randomUUID()
  const workspaceMemberId = randomUUID()
  const firstConversationId = randomUUID()
  const secondConversationId = randomUUID()
  const lastItemId = randomUUID()
  const calls: {
    listedBaseRows: Array<{ queryable: Executor; workspaceMemberId: string }>
    participantIds: string[][]
    itemIds: string[][]
    itemRows: ChatConversationItemRow[][]
  } = {
    listedBaseRows: [],
    participantIds: [],
    itemIds: [],
    itemRows: [],
  }
  const itemRow = { id: lastItemId } as ChatConversationItemRow
  const hydratedItem = messageItem({
    id: lastItemId,
    conversationId: firstConversationId,
    authorParticipantId: randomUUID(),
  })
  const deps: LoadConversationViewsDeps = {
    getConversationBaseRow: async () => {
      throw new Error("detail loader should not be called")
    },
    listConversationBaseRows: async (
      receivedQueryable,
      receivedWorkspaceMemberId
    ) => {
      calls.listedBaseRows.push({
        queryable: receivedQueryable,
        workspaceMemberId: receivedWorkspaceMemberId,
      })
      return [
        baseRow({
          conversationId: firstConversationId,
          unreadCount: "3",
          pinnedSortKey: UPDATED_AT,
          lastVisibleItemId: lastItemId,
        }),
        baseRow({
          conversationId: secondConversationId,
          title: "No item",
          lastVisibleItemId: lastItemId,
        }),
      ]
    },
    listConversationParticipants: async (_queryable, conversationIds) => {
      calls.participantIds.push(conversationIds)
      return [
        participant({
          id: randomUUID(),
          conversationId: firstConversationId,
          workspaceMemberId,
          roleKey: CONVERSATION_PARTICIPANT_ROLE_KEY.OWNER,
          displayName: "Viewer",
        }),
        participant({
          id: randomUUID(),
          conversationId: firstConversationId,
          workspaceMemberId: randomUUID(),
          displayName: "Other",
        }),
        participant({
          id: randomUUID(),
          conversationId: secondConversationId,
          workspaceMemberId: randomUUID(),
          displayName: "Second",
        }),
      ]
    },
    listItemRowsByIds: async (_queryable, itemIds) => {
      calls.itemIds.push(itemIds)
      return [itemRow]
    },
    buildChatConversationItems: async (_queryable, itemRows) => {
      calls.itemRows.push(itemRows)
      return [hydratedItem]
    },
    participantToSummary: participantSummary,
  }

  const result = await loadConversationViewsUseCase(
    queryable,
    workspaceId,
    workspaceMemberId,
    undefined,
    deps
  )

  assert.deepEqual(calls.listedBaseRows, [{ queryable, workspaceMemberId }])
  assert.deepEqual(calls.participantIds, [
    [firstConversationId, secondConversationId],
  ])
  assert.deepEqual(calls.itemIds, [[lastItemId]])
  assert.deepEqual(calls.itemRows, [[itemRow]])
  assert.equal(result.length, 2)
  assert.equal(result[0]?.conversationId, firstConversationId)
  assert.equal(result[0]?.workspaceId, workspaceId)
  assert.equal(result[0]?.unreadCount, 3)
  assert.equal(result[0]?.pinnedSortKey, UPDATED_AT)
  assert.equal(
    result[0]?.viewerConversationRole,
    CONVERSATION_PARTICIPANT_ROLE_KEY.OWNER
  )
  assert.equal(result[0]?.participants.length, 2)
  assert.equal(result[0]?.lastItem?.itemId, lastItemId)
  assert.equal(result[0]?.lastItem?.previewText, "Hello from item content")
  assert.equal(result[1]?.participants.length, 1)
  assert.equal(result[1]?.lastItem?.itemId, lastItemId)
})

test("loadConversationViewUseCase returns one filtered record or null", async () => {
  const queryable = {} as Executor
  const workspaceId = randomUUID()
  const workspaceMemberId = randomUUID()
  const conversationId = randomUUID()
  const missingConversationId = randomUUID()
  const requestedIds: string[] = []
  const deps: LoadConversationViewsDeps = {
    getConversationBaseRow: async (
      _queryable,
      _workspaceMemberId,
      requestedConversationId
    ) => {
      requestedIds.push(requestedConversationId)
      if (requestedConversationId === missingConversationId) {
        return null
      }
      return baseRow({ conversationId })
    },
    listConversationBaseRows: async () => {
      throw new Error("list loader should not be called")
    },
    listConversationParticipants: async () => [
      participant({
        id: randomUUID(),
        conversationId,
        workspaceMemberId,
      }),
    ],
    listItemRowsByIds: async (_queryable, itemIds) => {
      assert.deepEqual(itemIds, [])
      return []
    },
    buildChatConversationItems: async (_queryable, itemRows) => {
      assert.deepEqual(itemRows, [])
      return []
    },
    participantToSummary: participantSummary,
  }

  const result = await loadConversationViewUseCase(
    queryable,
    workspaceId,
    workspaceMemberId,
    conversationId,
    deps
  )
  const missing = await loadConversationViewUseCase(
    queryable,
    workspaceId,
    workspaceMemberId,
    missingConversationId,
    deps
  )

  assert.equal(result?.conversationId, conversationId)
  assert.equal(missing, null)
  assert.deepEqual(requestedIds, [conversationId, missingConversationId])
})
