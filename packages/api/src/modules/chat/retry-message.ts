import {
  CONVERSATION_MESSAGE_SUBTYPE,
  CONVERSATION_PARTICIPANT_TYPE,
} from "@synapse/shared"
import type { ConversationFeedItem } from "@synapse/shared/types"
import { chatRootExecutor } from "./repo.js"
import { requireConversationAccess } from "./conversation-access.js"
import { createChatError } from "./errors.js"
import type { EnqueueSessionWakeupParams } from "../session/runtime.js"

export type RetryAssistantMessageInput = {
  workspaceId: string
  workspaceMemberId: string
  conversationId: string
  itemId: string
}

export type RetryAssistantMessageRecord = {
  retryEnqueued: boolean
  sessionId: string
  actorId: string
}

type RetryConversationAccess = {
  participant: {
    id: string
    userName?: string | null
  }
}

type RetryAssistantMessageDeps = {
  enqueueSessionWakeup: (params: EnqueueSessionWakeupParams) => Promise<unknown>
  getConversationFeedItemById: (
    itemId: string
  ) => Promise<ConversationFeedItem | null>
  requireConversationAccess?: (
    conversationId: string,
    workspaceMemberId: string
  ) => Promise<RetryConversationAccess>
}

async function defaultRequireConversationAccess(
  conversationId: string,
  workspaceMemberId: string
): Promise<RetryConversationAccess> {
  return requireConversationAccess(
    chatRootExecutor(),
    conversationId,
    workspaceMemberId
  )
}

export async function retryAssistantMessageUseCase(
  params: RetryAssistantMessageInput,
  deps: RetryAssistantMessageDeps
): Promise<RetryAssistantMessageRecord> {
  const access = await (
    deps.requireConversationAccess ?? defaultRequireConversationAccess
  )(params.conversationId, params.workspaceMemberId)

  const item = await deps.getConversationFeedItemById(params.itemId)
  if (!item || item.conversationId !== params.conversationId) {
    throw createChatError(404, "item_not_found", "Conversation item not found")
  }
  if (
    item.kind !== "message" ||
    item.messageType !== CONVERSATION_MESSAGE_SUBTYPE.MODEL_ERROR_NOTICE
  ) {
    throw createChatError(
      400,
      "item_not_retryable",
      "Only model error notices can be retried"
    )
  }

  const metadata = item.metadata ?? {}
  const retrySessionId =
    typeof metadata.retrySessionId === "string" ? metadata.retrySessionId : null
  if (!retrySessionId) {
    throw createChatError(
      400,
      "retry_metadata_missing",
      "model_error_notice is missing retrySessionId in metadata"
    )
  }

  const actorId =
    typeof item.author?.actorId === "string" ? item.author.actorId : null
  if (!actorId) {
    throw createChatError(
      400,
      "retry_actor_missing",
      "model_error_notice has no actor author"
    )
  }

  // The retry source is the user clicking retry, not the original actor author.
  // session-thinking expects workspace_members.id here so it can re-query the
  // user's current participant record.
  await deps.enqueueSessionWakeup({
    sessionId: retrySessionId,
    actorId,
    workspaceId: params.workspaceId,
    sourceType: "user_message",
    sourceItemId: params.itemId,
    sourceParticipantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
    sourceParticipantId: params.workspaceMemberId,
    sourceName: access.participant.userName ?? "user",
    summary: "user requested retry of failed assistant turn",
    metadata: {
      source: "chat.message_retry",
      retryItemId: params.itemId,
      conversationId: params.conversationId,
      retryByParticipantId: access.participant.id,
    },
    trigger: "user_message",
  })

  return {
    retryEnqueued: true,
    sessionId: retrySessionId,
    actorId,
  }
}
