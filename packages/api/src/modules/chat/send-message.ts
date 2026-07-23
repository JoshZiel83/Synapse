import {
  type ChatConversationItem,
  type ChatConversationSendMessageRequest,
} from "@synapse/shared"
import { trace } from "@opentelemetry/api"
import type { Executor } from "../../infrastructure/database/kysely.js"
import { enqueueActorWakeupsForConversationMessage } from "./actor-wakeup.js"
import { ensureClientInstance } from "./client-instances.js"
import { requireConversationAccess } from "./conversation-access.js"
import { createChatError } from "./errors.js"
import { sendConversationMessageFromParticipant } from "./item-write.js"
import type { ChatConversationSendMessageRecord } from "./presenter.js"
import { withChatTransaction } from "./repo.js"

export type SendChatConversationMessageInput = {
  workspaceId: string
  workspaceMemberId: string
  conversationId: string
} & ChatConversationSendMessageRequest

export type SendChatConversationMessageDeps = {
  withChatTransaction: <T>(
    callback: (queryable: Executor) => Promise<T>
  ) => Promise<T>
  requireConversationAccess: (
    queryable: Executor,
    conversationId: string,
    workspaceMemberId: string
  ) => Promise<{ participant: { id: string } }>
  ensureClientInstance: (
    queryable: Executor,
    params: {
      workspaceId: string
      workspaceMemberId: string
      clientInstanceId: string
    }
  ) => Promise<unknown>
  sendConversationMessageFromParticipant: (params: {
    workspaceId: string
    conversationId: string
    senderParticipantId: string
    clientMessageId?: string
    role: "user"
    contentBlocks: SendChatConversationMessageInput["contentBlocks"]
    replyToItemId?: string
    metadata?: Record<string, unknown>
    queryable: Executor
  }) => Promise<ChatConversationItem>
  enqueueActorWakeupsForConversationMessage: (params: {
    workspaceId: string
    conversationId: string
    itemId: string
  }) => Promise<unknown>
  notifyRemoteAgentDeliveriesForConversation: (
    conversationId: string
  ) => Promise<unknown>
}

function chatRouteSendMessageDeps(): SendChatConversationMessageDeps {
  return {
    withChatTransaction,
    requireConversationAccess,
    ensureClientInstance,
    sendConversationMessageFromParticipant,
    enqueueActorWakeupsForConversationMessage,
    notifyRemoteAgentDeliveriesForConversation: async (conversationId) => {
      const { notifyRemoteAgentDeliveriesForConversation } =
        await import("../remote-agents/service.js")
      await notifyRemoteAgentDeliveriesForConversation(conversationId)
    },
  }
}

export async function sendChatConversationMessageUseCase(
  params: SendChatConversationMessageInput,
  deps: SendChatConversationMessageDeps
): Promise<ChatConversationSendMessageRecord> {
  // The join key that keeps a send correlatable even when the client's replayed
  // trace carrier is deliberately dropped (>24h stale) and this span roots a
  // fresh trace. Stamped on the ambient http SERVER span (the api's remote
  // parent when a fresh carrier IS present, or the root when it is not).
  if (params.clientMessageId) {
    trace
      .getActiveSpan()
      ?.setAttribute("synapse.chat.client_message_id", params.clientMessageId)
  }

  const contentBlocks = params.contentBlocks
  if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) {
    throw createChatError(
      400,
      "invalid_content_blocks",
      "contentBlocks is required"
    )
  }

  const item = await deps.withChatTransaction(async (client) => {
    const access = await deps.requireConversationAccess(
      client,
      params.conversationId,
      params.workspaceMemberId
    )

    await deps.ensureClientInstance(client, {
      workspaceId: params.workspaceId,
      workspaceMemberId: params.workspaceMemberId,
      clientInstanceId: params.clientInstanceId,
    })

    return deps.sendConversationMessageFromParticipant({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      senderParticipantId: access.participant.id,
      clientMessageId: params.clientMessageId,
      role: "user",
      contentBlocks,
      replyToItemId: params.replyToItemId,
      metadata: params.metadata,
      queryable: client,
    })
  })

  await deps.enqueueActorWakeupsForConversationMessage({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    itemId: item.id,
  })
  await deps.notifyRemoteAgentDeliveriesForConversation(params.conversationId)

  return { item }
}

export async function sendChatConversationMessage(
  params: SendChatConversationMessageInput
): Promise<ChatConversationSendMessageRecord> {
  return sendChatConversationMessageUseCase(params, chatRouteSendMessageDeps())
}
