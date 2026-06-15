import { type ConversationParticipantType } from "@synapse/shared"
import { type Executor } from "../../infrastructure/database/kysely.js"
export {
  createChatClientInstance,
  touchChatClientInstance,
} from "./client-instances.js"
export {
  deleteChatPushToken,
  listChatPushTokens,
  registerChatPushToken,
} from "./push-tokens.js"
export { broadcastTypingState } from "./typing.js"
import { chatRootExecutor, getConversationRecord } from "./repo.js"
// Re-exported for existing consumers that import the row DTO from chat/service.
export type { ChatPushTokenRow } from "./repo.js"
export {
  appendWorkspaceMemberSyncEvent,
  appendWorkspaceMemberSyncEventInTransaction,
} from "./sync-events.js"
export { isChatServiceError, type ChatServiceError } from "./errors.js"
export { updateChatConversationReadWatermark } from "./read-watermark.js"
export {
  leaveChatConversation,
  loadParticipantById,
  removeChatConversationParticipant,
} from "./remove-participant.js"
export { patchChatConversation } from "./patch-conversation.js"
export { retryAssistantMessage } from "./retry-message.js"
import {
  addChatConversationParticipants,
  addConversationParticipants,
} from "./add-participants.js"
export { addChatConversationParticipants, addConversationParticipants }
import {
  createChatConversation,
  createConversation,
  createConversationForWorkspaceMember,
} from "./create-conversation.js"
export {
  createChatConversation,
  createConversation,
  createConversationForWorkspaceMember,
}
export {
  createConversationItem,
  sendConversationMessageFromParticipant,
  type ConversationItemPartInput,
} from "./item-write.js"
export { createConversationEvent } from "./event-write.js"
export { enqueueActorWakeupsForConversationMessage } from "./actor-wakeup.js"
import { listConversationRealtimeRecipientsUseCase } from "./realtime-recipients.js"
export { sendChatConversationMessage } from "./send-message.js"
export { isFeedItemVisibleToWorkspaceMember } from "./conversation-feed-visibility.js"
export { conversationItemDetailToFeedItem } from "./conversation-feed-mapper.js"
export {
  getContextConversationItemsForParticipant,
  getConversationFeedItemById,
  getLastVisibleConversationItem,
  listVisibleConversationItemsForParticipant,
} from "./conversation-item-read.js"
export {
  getChatBootstrap,
  getChatConversationActorRuntimeTurnDetail,
  getChatConversationDetail,
  getChatConversationMessages,
  getChatSync,
  listChatConversations,
  listWorkspaceConversationViews,
} from "./app-read.js"
export { resolveConversationReplyRef } from "./conversation-reply-ref.js"
import {
  ensureConversationParticipantUseCase,
  getConversationParticipantUseCase,
  listConversationParticipantsUseCase,
} from "./participant-roster.js"

type ParticipantKind = ConversationParticipantType

function rootQueryable(): Executor {
  return chatRootExecutor()
}

export async function getConversation(
  conversationId: string,
  queryable: Executor = rootQueryable()
) {
  return getConversationRecord(queryable, conversationId)
}

export async function listConversationParticipants(
  conversationId: string,
  options?: { useProfileSnapshot?: boolean; queryable?: Executor }
) {
  return listConversationParticipantsUseCase(conversationId, options)
}

export async function getConversationParticipant(params: {
  conversationId: string
  participantId?: string
  actorId?: string
  remoteAgentId?: string
  workspaceMemberId?: string
  transportAddressId?: string
  queryable?: Executor
}) {
  return getConversationParticipantUseCase(params)
}

export async function ensureConversationParticipant(params: {
  conversationId: string
  participantType: ParticipantKind
  workspaceMemberId?: string
  actorId?: string
  remoteAgentId?: string
  displayName?: string
  actorJoinVersionId?: string
  roleKey?: string
  metadata?: Record<string, unknown>
  transportAddressId?: string
  queryable?: Executor
}) {
  return ensureConversationParticipantUseCase(params)
}

export async function listConversationRealtimeRecipients(
  conversationId: string,
  queryable: Executor = rootQueryable()
) {
  return listConversationRealtimeRecipientsUseCase(conversationId, queryable)
}
