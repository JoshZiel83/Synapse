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
import {
  sendRemoteAgentConversationMessageUseCase,
  type RemoteAgentConversationAccess,
  type SendRemoteAgentConversationMessageDeps,
} from "./remote-agent-bridge.js"

function chatItem(
  values: Partial<ChatConversationItem> = {}
): ChatConversationItem {
  return {
    id: randomUUID(),
    conversationId: randomUUID(),
    sequence: 1,
    itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
    subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
    role: CONVERSATION_ITEM_ROLE.ASSISTANT,
    scope: CONVERSATION_ITEM_SCOPE.SHARED,
    surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
    content: "remote reply",
    contentBlocks: [{ id: randomUUID(), type: "text", text: "remote reply" }],
    metadata: {},
    createdAt: "2026-06-16T00:00:00.000Z",
    ...values,
  } as ChatConversationItem
}

function deps(params: {
  calls: string[]
  transactionClient: Executor
  participantId: string
  hostWorkspaceId: string | null
  item: ChatConversationItem
}): SendRemoteAgentConversationMessageDeps {
  return {
    withTransaction: async (callback) => {
      params.calls.push("tx:start")
      const result = await callback(params.transactionClient)
      params.calls.push("tx:commit")
      return result
    },
    requireRemoteAgentConversationAccess: async (
      queryable,
      conversationId
    ): Promise<RemoteAgentConversationAccess> => {
      params.calls.push(`access:${queryable === params.transactionClient}`)
      assert.equal(conversationId, params.item.conversationId)
      return {
        participant: {
          id: params.participantId,
          conversationId,
          remoteAgentId: randomUUID(),
          state: "active",
        } as RemoteAgentConversationAccess["participant"],
      }
    },
    loadConversationHostWorkspaceId: async (conversationId, queryable) => {
      params.calls.push(`workspace:${queryable === params.transactionClient}`)
      assert.equal(conversationId, params.item.conversationId)
      return params.hostWorkspaceId
    },
    sendConversationMessageFromParticipant: async (input) => {
      params.calls.push(`send:${input.queryable === params.transactionClient}`)
      assert.equal(input.senderParticipantId, params.participantId)
      assert.equal(input.workspaceId, params.hostWorkspaceId ?? undefined)
      assert.equal(input.role, CONVERSATION_ITEM_ROLE.ASSISTANT)
      return params.item
    },
  }
}

test("sendRemoteAgentConversationMessageUseCase sends as assistant inside one transaction", async () => {
  const transactionClient = {} as Executor
  const conversationId = randomUUID()
  const item = chatItem({ conversationId })
  const calls: string[] = []

  const result = await sendRemoteAgentConversationMessageUseCase(
    {
      remoteAgentId: randomUUID(),
      conversationId,
      clientMessageId: randomUUID(),
      contentBlocks: [{ id: randomUUID(), type: "text", text: "hello" }],
      metadata: { source: "remote-agent" },
    },
    deps({
      calls,
      transactionClient,
      participantId: randomUUID(),
      hostWorkspaceId: randomUUID(),
      item,
    })
  )

  assert.equal(result, item)
  assert.deepEqual(calls, [
    "tx:start",
    "access:true",
    "workspace:true",
    "send:true",
    "tx:commit",
  ])
})
