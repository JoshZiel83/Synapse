import {
  buildConversationMessageRef,
  CONVERSATION_KINDS,
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
import {
  type ChatConversationCreateRecord,
  type ChatConversationEnvelopeRecord,
  type ChatConversationRecord,
  type ChatConversationReadWatermarkRecord,
} from "./presenter.js"
import { createChatError } from "./errors.js"
export { isChatServiceError, type ChatServiceError } from "./errors.js"
import { getWorkspaceMemberIdentityOrThrow } from "./identity.js"
import {
  updateChatConversationReadWatermarkUseCase,
  type ReadWatermarkInput,
} from "./read-watermark.js"
import {
  leaveChatConversationUseCase,
  removeChatConversationParticipantUseCase,
  type RemoveParticipantDeps,
} from "./remove-participant.js"
export { loadParticipantById } from "./remove-participant.js"
import { patchChatConversationUseCase } from "./patch-conversation.js"
import { retryAssistantMessageUseCase } from "./retry-message.js"
import {
  addChatConversationParticipantsUseCase,
  addConversationParticipantsUseCase,
  type AddChatConversationParticipantsDeps,
} from "./add-participants.js"
import {
  createConversationForWorkspaceMemberUseCase,
  createConversationRecordUseCase,
  createChatConversationUseCase,
  type CreateChatConversationDeps,
  type CreateConversationForWorkspaceMemberDeps,
} from "./create-conversation.js"
export {
  createConversationItem,
  sendConversationMessageFromParticipant,
  type ConversationItemPartInput,
} from "./item-write.js"
import { createConversationEvent } from "./event-write.js"
export { createConversationEvent } from "./event-write.js"
export { enqueueActorWakeupsForConversationMessage } from "./actor-wakeup.js"
import { syncConversationUpsertForWorkspaceMembers } from "./conversation-upsert-sync.js"
import { listConversationRealtimeRecipientsUseCase } from "./realtime-recipients.js"
export { sendChatConversationMessage } from "./send-message.js"
import { loadChatConversationView } from "./conversation-view-read.js"
import { type HydratedConversationItemRecord } from "./conversation-item-hydration.js"
import {
  participantDisplayName,
  participantRowToChatParticipantSummary,
} from "./participant-projection.js"
export { isFeedItemVisibleToWorkspaceMember } from "./conversation-feed-visibility.js"
export { conversationItemDetailToFeedItem } from "./conversation-feed-mapper.js"
import { getConversationFeedItemById } from "./conversation-item-read.js"
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
  insertParticipant,
  listConversationParticipantsUseCase,
} from "./participant-roster.js"

type ConversationKind = (typeof CONVERSATION_KINDS)[number]
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

function chatAddParticipantsDeps(): AddChatConversationParticipantsDeps {
  return {
    ensureConversationParticipant,
    listConversationParticipants,
    loadConversationView: loadChatConversationView,
    participantToSummary: participantRowToChatParticipantSummary,
    syncConversationUpsert: syncConversationUpsertForWorkspaceMembers,
  }
}

function chatConversationForWorkspaceMemberDeps(): CreateConversationForWorkspaceMemberDeps {
  return {
    ensureConversationParticipant,
    syncConversationUpsert: syncConversationUpsertForWorkspaceMembers,
  }
}

function chatCreateConversationDeps(): CreateChatConversationDeps {
  return {
    insertParticipant,
    loadConversationView: loadChatConversationView,
    syncConversationUpsert: syncConversationUpsertForWorkspaceMembers,
  }
}

export async function getConversation(
  conversationId: string,
  queryable: Executor = rootQueryable()
) {
  return getConversationRecord(queryable, conversationId)
}

export async function createConversation(params: {
  kind: ConversationKind
  workspaceId: string
  title?: string
  createdByWorkspaceMemberId?: string
  metadata?: Record<string, unknown>
  queryable?: Executor
}) {
  return createConversationRecordUseCase(params)
}

export async function createConversationForWorkspaceMember(params: {
  workspaceId: string
  creatorWorkspaceMemberId?: string
  kind: ConversationKind
  title?: string
  workspaceMemberIds?: string[]
  actorIds?: string[]
  remoteAgentIds?: string[]
  metadata?: Record<string, unknown>
  queryable?: Executor
}) {
  return createConversationForWorkspaceMemberUseCase(
    params,
    chatConversationForWorkspaceMemberDeps()
  )
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

export async function addConversationParticipants(params: {
  workspaceId: string
  conversationId: string
  workspaceMemberIds?: string[]
  actorIds?: string[]
  remoteAgentIds?: string[]
  queryable?: Executor
}) {
  return addConversationParticipantsUseCase(params, chatAddParticipantsDeps())
}

export async function listConversationRealtimeRecipients(
  conversationId: string,
  queryable: Executor = rootQueryable()
) {
  return listConversationRealtimeRecipientsUseCase(conversationId, queryable)
}

export async function createChatConversation(params: {
  workspaceId: string
  userId: string
  clientRequestId: string
  kind: ConversationKind
  title?: string
  workspaceMemberIds?: string[]
  actorIds?: string[]
  remoteAgentIds?: string[]
  metadata?: Record<string, unknown>
}): Promise<ChatConversationCreateRecord> {
  const creator = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  return createChatConversationUseCase(
    {
      workspaceId: params.workspaceId,
      creatorWorkspaceMemberId: creator.workspaceMemberId,
      clientRequestId: params.clientRequestId,
      kind: params.kind,
      title: params.title,
      workspaceMemberIds: params.workspaceMemberIds,
      actorIds: params.actorIds,
      remoteAgentIds: params.remoteAgentIds,
      metadata: params.metadata,
    },
    chatCreateConversationDeps()
  )
}

export async function updateChatConversationReadWatermark(
  params: ReadWatermarkInput
): Promise<ChatConversationReadWatermarkRecord> {
  return updateChatConversationReadWatermarkUseCase(params, {
    syncConversationUpsert: syncConversationUpsertForWorkspaceMembers,
  })
}

export async function patchChatConversation(params: {
  workspaceId: string
  userId: string
  conversationId: string
  title?: string | null
  metadata?: Record<string, unknown>
}): Promise<ChatConversationEnvelopeRecord | undefined> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  return patchChatConversationUseCase(
    {
      workspaceId: params.workspaceId,
      workspaceMemberId: identity.workspaceMemberId,
      conversationId: params.conversationId,
      title: params.title,
      metadata: params.metadata,
    },
    {
      listConversationRealtimeRecipients,
      loadConversationView: loadChatConversationView,
      syncConversationUpsert: syncConversationUpsertForWorkspaceMembers,
    }
  )
}

export async function addChatConversationParticipants(params: {
  workspaceId: string
  userId: string
  conversationId: string
  workspaceMemberIds?: string[]
  actorIds?: string[]
  remoteAgentIds?: string[]
}): Promise<ChatConversationEnvelopeRecord> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  return addChatConversationParticipantsUseCase(
    {
      workspaceId: params.workspaceId,
      workspaceMemberId: identity.workspaceMemberId,
      conversationId: params.conversationId,
      workspaceMemberIds: params.workspaceMemberIds,
      actorIds: params.actorIds,
      remoteAgentIds: params.remoteAgentIds,
    },
    chatAddParticipantsDeps()
  )
}

function chatParticipantRemovalDeps(): RemoveParticipantDeps {
  return {
    createRemovalConversationEvent: async (eventParams) => {
      await createConversationEvent({
        ...eventParams,
        eventPayload: eventParams.eventPayload as never,
      })
    },
    listConversationParticipants,
    listConversationRealtimeRecipients,
    participantToSummary: participantRowToChatParticipantSummary,
    syncConversationUpsert: syncConversationUpsertForWorkspaceMembers,
  }
}

export async function removeChatConversationParticipant(params: {
  workspaceId: string
  userId: string
  conversationId: string
  participantId: string
}) {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  return removeChatConversationParticipantUseCase(
    {
      workspaceId: params.workspaceId,
      workspaceMemberId: identity.workspaceMemberId,
      conversationId: params.conversationId,
      participantId: params.participantId,
    },
    chatParticipantRemovalDeps()
  )
}

export async function leaveChatConversation(params: {
  workspaceId: string
  userId: string
  conversationId: string
}) {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  return leaveChatConversationUseCase(
    {
      workspaceId: params.workspaceId,
      workspaceMemberId: identity.workspaceMemberId,
      conversationId: params.conversationId,
    },
    chatParticipantRemovalDeps()
  )
}

// ============ Stage 16: assistant message retry ============

/**
 * Re-trigger an actor turn after a model_error_notice item. Looks up the
 * conversation item by id, verifies it's a retry-able error notice owned
 * by an accessible conversation, then enqueues a session wakeup that will
 * run another turn. UI calls this when the user taps "retry" on a failed
 * assistant message.
 */
export async function retryAssistantMessage(params: {
  workspaceId: string
  userId: string
  conversationId: string
  itemId: string
}): Promise<{
  retryEnqueued: boolean
  sessionId: string
  actorId: string
}> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const { enqueueSessionWakeup } = await import("../session/runtime.js")
  return retryAssistantMessageUseCase(
    {
      workspaceId: params.workspaceId,
      workspaceMemberId: identity.workspaceMemberId,
      conversationId: params.conversationId,
      itemId: params.itemId,
    },
    { enqueueSessionWakeup, getConversationFeedItemById }
  )
}
