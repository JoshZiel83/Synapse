import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { Executor } from "../../infrastructure/database/kysely.js"
import {
  syncConversationUpsertForWorkspaceMembersUseCase,
  type LoadConversationViewForSync,
} from "./conversation-upsert-sync.js"
import type { ChatConversationRecord } from "./presenter.js"

function conversationRecord(params: {
  conversationId: string
  workspaceId: string
  workspaceMemberId: string
  title: string
}): ChatConversationRecord {
  return {
    conversationId: params.conversationId,
    workspaceId: params.workspaceId,
    baseTitle: params.title,
    kind: "group",
    isIm: false,
    unreadCount: 0,
    muted: false,
    archived: false,
    updatedAt: new Date("2026-06-16T00:00:00.000Z"),
    createdAt: new Date("2026-06-16T00:00:00.000Z"),
    participants: [],
    viewerWorkspaceMemberId: params.workspaceMemberId,
    viewerConversationRole: "member",
  }
}

test("syncConversationUpsertForWorkspaceMembersUseCase dedupes recipients and skips missing views", async () => {
  const queryable = {} as Executor
  const workspaceId = randomUUID()
  const conversationId = randomUUID()
  const firstMemberId = randomUUID()
  const missingMemberId = randomUUID()
  const loaded: string[] = []
  const appended: unknown[] = []
  const loadConversationView: LoadConversationViewForSync = async (
    _queryable,
    _workspaceId,
    workspaceMemberId
  ) => {
    loaded.push(workspaceMemberId)
    if (workspaceMemberId === missingMemberId) {
      return null
    }
    return conversationRecord({
      conversationId,
      workspaceId,
      workspaceMemberId,
      title: "Projected conversation",
    })
  }

  await syncConversationUpsertForWorkspaceMembersUseCase(
    queryable,
    workspaceId,
    [firstMemberId, firstMemberId, missingMemberId],
    conversationId,
    {
      loadConversationView,
      appendWorkspaceMemberSyncEvent: async (_queryable, params) => {
        appended.push(params)
        return {} as never
      },
    }
  )

  assert.deepEqual(loaded, [firstMemberId, missingMemberId])
  assert.equal(appended.length, 1)
  const appendedEvent = appended[0] as {
    workspaceId: string
    workspaceMemberId: string
    conversationId: string
    eventType: string
    payload: {
      conversation: {
        conversationId: string
        workspaceId: string
        title: string
        kind: string
        isIm: boolean
        status: string
        updatedAt: string
        createdAt: string
      }
    }
  }
  assert.equal(appendedEvent.workspaceId, workspaceId)
  assert.equal(appendedEvent.workspaceMemberId, firstMemberId)
  assert.equal(appendedEvent.conversationId, conversationId)
  assert.equal(appendedEvent.eventType, "conversation.upsert")
  assert.equal(
    appendedEvent.payload.conversation.conversationId,
    conversationId
  )
  assert.equal(appendedEvent.payload.conversation.workspaceId, workspaceId)
  assert.equal(
    appendedEvent.payload.conversation.title,
    "Projected conversation"
  )
  assert.equal(appendedEvent.payload.conversation.kind, "group")
  assert.equal(appendedEvent.payload.conversation.isIm, false)
  assert.equal(appendedEvent.payload.conversation.status, "completed")
  assert.equal(
    appendedEvent.payload.conversation.updatedAt,
    "2026-06-16T00:00:00.000Z"
  )
  assert.equal(
    appendedEvent.payload.conversation.createdAt,
    "2026-06-16T00:00:00.000Z"
  )
})
