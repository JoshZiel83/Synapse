import {
  buildConversationMessageRef,
  parseConversationMessageRef,
  type ConversationParticipantType,
} from "@synapse/shared"
import { type Executor } from "../../infrastructure/database/kysely.js"
import { canonicalContentBlocksToDraftParts } from "./message-content.js"
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
import {
  chatRootExecutor,
  getConversationRecord,
  getVisibleConversationReplyRefRow,
  listNearbyVisibleConversationReplyRefRows,
} from "./repo.js"
// Re-exported for existing consumers that import the row DTO from chat/service.
export type { ChatPushTokenRow } from "./repo.js"
import { appendWorkspaceMemberSyncEvent } from "./sync-events.js"
export {
  appendWorkspaceMemberSyncEvent,
  appendWorkspaceMemberSyncEventInTransaction,
} from "./sync-events.js"
import { type ChatConversationRecord } from "./presenter.js"
import { createChatError } from "./errors.js"
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
import { type HydratedConversationItemRecord } from "./conversation-item-hydration.js"
import { participantDisplayName } from "./participant-projection.js"
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
import {
  ensureConversationParticipantUseCase,
  getConversationParticipantUseCase,
  listConversationParticipantsUseCase,
} from "./participant-roster.js"

type ParticipantKind = ConversationParticipantType

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return 0
}

function isUniqueViolation(error: unknown) {
  const candidate = error as { code?: string } | null
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    candidate.code === "23505"
  )
}

function rootQueryable(): Executor {
  return chatRootExecutor()
}

export async function resolveConversationReplyRef(params: {
  queryable?: Executor
  conversationId: string
  participantId?: string
  replyRef?: string
}) {
  if (!params.replyRef) {
    return null
  }

  const sequence = parseConversationMessageRef(params.replyRef)
  if (sequence === null || !Number.isFinite(sequence)) {
    throw createChatError(
      400,
      "invalid_reply_ref",
      'replyToRef must use the form "m_<sequence>"'
    )
  }

  const queryable = params.queryable ?? rootQueryable()
  const row = await getVisibleConversationReplyRefRow(queryable, {
    conversationId: params.conversationId,
    sequence,
    participantId: params.participantId,
  })
  if (row) {
    return {
      itemId: row.id,
      sequence: toNumber(row.sequence),
      ref: buildConversationMessageRef(toNumber(row.sequence)),
    }
  }

  const nearby = await listNearbyVisibleConversationReplyRefRows(queryable, {
    conversationId: params.conversationId,
    sequence,
    participantId: params.participantId,
  })
  const suggestions = nearby
    .map((candidate) =>
      buildConversationMessageRef(toNumber(candidate.sequence))
    )
    .filter((value, index, all) => all.indexOf(value) === index)
  const suggestionText =
    suggestions.length > 0 ? ` Did you mean ${suggestions.join(", ")}?` : ""

  throw createChatError(
    400,
    "invalid_reply_ref",
    `Unknown replyToRef "${params.replyRef}".${suggestionText}`
  )
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
