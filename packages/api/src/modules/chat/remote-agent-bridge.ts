import {
  CONVERSATION_ITEM_ROLE,
  CONVERSATION_PARTICIPANT_STATE,
  type ChatConversationItem,
} from "@synapse/shared"
import type { Executor } from "../../infrastructure/database/kysely.js"
import { createChatError } from "./errors.js"
import {
  chatRootExecutor,
  listChatConversationParticipantRows,
  type ChatParticipantRow,
} from "./repo.js"

export type RemoteAgentConversationAccess = {
  participant: ChatParticipantRow
}

export async function requireRemoteAgentConversationAccess(
  queryable: Executor,
  conversationId: string,
  remoteAgentId: string
): Promise<RemoteAgentConversationAccess> {
  const participants = await listChatConversationParticipantRows(queryable, [
    conversationId,
  ])
  const participant =
    participants.find((row) => row.remoteAgentId === remoteAgentId) ?? null
  if (
    !participant ||
    participant.state !== CONVERSATION_PARTICIPANT_STATE.ACTIVE
  ) {
    throw createChatError(
      403,
      "conversation_access_denied",
      "Remote agent is not an active participant in this conversation"
    )
  }
  return { participant }
}

export async function requireRemoteAgentConversationAccessOnDefaultDb(
  conversationId: string,
  remoteAgentId: string
): Promise<RemoteAgentConversationAccess> {
  return requireRemoteAgentConversationAccess(
    chatRootExecutor(),
    conversationId,
    remoteAgentId
  )
}

export type SendRemoteAgentConversationMessageInput = {
  remoteAgentId: string
  conversationId: string
  clientMessageId: string
  contentBlocks: any[]
  replyToItemId?: string
  metadata?: Record<string, unknown>
}

export type SendRemoteAgentConversationMessageDeps = {
  withTransaction: <T>(
    callback: (queryable: Executor) => Promise<T>
  ) => Promise<T>
  requireRemoteAgentConversationAccess: (
    queryable: Executor,
    conversationId: string,
    remoteAgentId: string
  ) => Promise<RemoteAgentConversationAccess>
  loadConversationHostWorkspaceId: (
    conversationId: string,
    queryable: Executor
  ) => Promise<string | null>
  sendConversationMessageFromParticipant: (params: {
    workspaceId?: string
    conversationId: string
    senderParticipantId: string
    clientMessageId: string
    role: typeof CONVERSATION_ITEM_ROLE.ASSISTANT
    contentBlocks: any[]
    replyToItemId?: string
    metadata?: Record<string, unknown>
    queryable: Executor
  }) => Promise<ChatConversationItem>
}

export async function sendRemoteAgentConversationMessageUseCase(
  params: SendRemoteAgentConversationMessageInput,
  deps: SendRemoteAgentConversationMessageDeps
): Promise<ChatConversationItem> {
  return deps.withTransaction(async (client) => {
    const access = await deps.requireRemoteAgentConversationAccess(
      client,
      params.conversationId,
      params.remoteAgentId
    )
    const hostWorkspaceId = await deps.loadConversationHostWorkspaceId(
      params.conversationId,
      client
    )
    return deps.sendConversationMessageFromParticipant({
      workspaceId: hostWorkspaceId ?? undefined,
      conversationId: params.conversationId,
      senderParticipantId: access.participant.id,
      clientMessageId: params.clientMessageId,
      role: CONVERSATION_ITEM_ROLE.ASSISTANT,
      contentBlocks: params.contentBlocks,
      replyToItemId: params.replyToItemId,
      metadata: params.metadata,
      queryable: client,
    })
  })
}
