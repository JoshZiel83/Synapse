import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  CONVERSATION_ITEM_ROLE,
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_MESSAGE_SUBTYPE,
  type ChatConversationItem,
} from "@synapse/shared"
import type { Executor } from "../../infrastructure/database/kysely.js"
import { isChatServiceError } from "./errors.js"
import {
  sendChatConversationMessageUseCase,
  type SendChatConversationMessageDeps,
} from "./send-message.js"

function chatItem(
  values: Partial<ChatConversationItem> = {}
): ChatConversationItem {
  return {
    id: randomUUID(),
    conversationId: randomUUID(),
    sequence: 1,
    itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
    subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
    role: CONVERSATION_ITEM_ROLE.USER,
    scope: CONVERSATION_ITEM_SCOPE.SHARED,
    surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
    content: "hello",
    contentBlocks: [{ id: randomUUID(), type: "text", text: "hello" }],
    metadata: {},
    createdAt: "2026-06-16T00:00:00.000Z",
    ...values,
  } as ChatConversationItem
}

function deps(params: {
  item: ChatConversationItem
  calls: string[]
  transactionClient: Executor
  participantId: string
}): SendChatConversationMessageDeps {
  return {
    withChatTransaction: async (callback) => {
      params.calls.push("tx:start")
      const result = await callback(params.transactionClient)
      params.calls.push("tx:commit")
      return result
    },
    requireConversationAccess: async (queryable, conversationId) => {
      params.calls.push(`access:${queryable === params.transactionClient}`)
      assert.equal(conversationId, params.item.conversationId)
      return { participant: { id: params.participantId } }
    },
    ensureClientInstance: async (queryable, input) => {
      params.calls.push(`client:${queryable === params.transactionClient}`)
      assert.equal(input.clientInstanceId.length > 0, true)
    },
    sendConversationMessageFromParticipant: async (input) => {
      params.calls.push(`send:${input.queryable === params.transactionClient}`)
      assert.equal(input.senderParticipantId, params.participantId)
      assert.equal(input.role, CONVERSATION_ITEM_ROLE.USER)
      return params.item
    },
    enqueueActorWakeupsForConversationMessage: async (input) => {
      params.calls.push("wakeup")
      assert.equal(input.itemId, params.item.id)
    },
    notifyRemoteAgentDeliveriesForConversation: async (conversationId) => {
      params.calls.push("remote-notify")
      assert.equal(conversationId, params.item.conversationId)
    },
  }
}

test("sendChatConversationMessageUseCase sends inside transaction and runs side effects after commit", async () => {
  const transactionClient = {} as Executor
  const conversationId = randomUUID()
  const item = chatItem({ conversationId })
  const participantId = randomUUID()
  const calls: string[] = []

  const result = await sendChatConversationMessageUseCase(
    {
      workspaceId: randomUUID(),
      workspaceMemberId: randomUUID(),
      conversationId,
      clientInstanceId: randomUUID(),
      clientMessageId: randomUUID(),
      contentBlocks: [{ id: randomUUID(), type: "text", text: "hello" }],
      metadata: { source: "test" },
    },
    deps({
      item,
      calls,
      transactionClient,
      participantId,
    })
  )

  assert.equal(result.item, item)
  assert.deepEqual(calls, [
    "tx:start",
    "access:true",
    "client:true",
    "send:true",
    "tx:commit",
    "wakeup",
    "remote-notify",
  ])
})

test("sendChatConversationMessageUseCase does not run side effects when transaction send fails", async () => {
  const transactionClient = {} as Executor
  const conversationId = randomUUID()
  const item = chatItem({ conversationId })
  const participantId = randomUUID()
  const calls: string[] = []
  const failingDeps = deps({
    item,
    calls,
    transactionClient,
    participantId,
  })
  failingDeps.sendConversationMessageFromParticipant = async (input) => {
    calls.push(`send:${input.queryable === transactionClient}`)
    throw new Error("send failed")
  }

  await assert.rejects(
    () =>
      sendChatConversationMessageUseCase(
        {
          workspaceId: randomUUID(),
          workspaceMemberId: randomUUID(),
          conversationId,
          clientInstanceId: randomUUID(),
          clientMessageId: randomUUID(),
          contentBlocks: [{ id: randomUUID(), type: "text", text: "hello" }],
          metadata: { source: "test" },
        },
        failingDeps
      ),
    /send failed/
  )

  assert.deepEqual(calls, [
    "tx:start",
    "access:true",
    "client:true",
    "send:true",
  ])
})

test("sendChatConversationMessageUseCase rejects empty content blocks", async () => {
  const item = chatItem()

  await assert.rejects(
    () =>
      sendChatConversationMessageUseCase(
        {
          workspaceId: randomUUID(),
          workspaceMemberId: randomUUID(),
          conversationId: item.conversationId,
          clientInstanceId: randomUUID(),
          clientMessageId: randomUUID(),
          contentBlocks: [],
        },
        deps({
          item,
          calls: [],
          transactionClient: {} as Executor,
          participantId: randomUUID(),
        })
      ),
    (error) =>
      isChatServiceError(error) &&
      error.statusCode === 400 &&
      error.code === "invalid_content_blocks"
  )
})
