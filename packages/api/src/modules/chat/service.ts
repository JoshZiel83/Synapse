import {
  buildConversationMessageRef,
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SCOPES,
  CONVERSATION_ITEM_ROLES,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_SURFACES,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_ITEM_TYPES,
  CONVERSATION_KINDS,
  CONVERSATION_MESSAGE_SUBTYPE,
  CONVERSATION_PARTICIPANT_STATE,
  CONVERSATION_PARTICIPANT_TYPE,
  normalizeCanonicalContentBlocks,
  parseConversationMessageRef,
  type CanonicalContentBlock,
  type ActorRuntimeTurnActivityDetail,
  type ChatConversationItem,
  type ChatDeviceState,
  type ChatSyncEvent,
  type ChatSyncEventPayloadMap,
  type ChatSyncEventType,
  type Timestamp,
  type ConversationMessageSubtype,
  type ConversationParticipantType,
  type SessionWakeupSourceParticipantType,
} from "@synapse/shared"
import type {
  ConversationEntityRef,
  ConversationEventContextPolicy,
  ConversationEventTimelinePolicy,
  ConversationFeedEventPayloadMap,
  ConversationFeedEventType,
  TaskSummary,
} from "@synapse/shared/types"
import { type Executor } from "../../infrastructure/database/kysely.js"
import { canonicalContentBlocksToDraftParts } from "./message-content.js"
import { requireConversationAccess } from "./conversation-access.js"
import { ensureClientInstance } from "./client-instances.js"
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
  conversationItemHasTargets,
  getChatConversationBaseRow,
  getConversationDeviceState,
  getConversationKind,
  getConversationRecord,
  getConversationParticipantReadState,
  getVisibleConversationReplyRefRow,
  getVisibleConversationReplyTargetRow,
  getWorkspaceMemberSyncCursor,
  listChatConversationBaseRows,
  listChatConversationParticipantRows,
  listConversationItemRowsByIds,
  listNearbyVisibleConversationReplyRefRows,
  listMentionedParticipantIdsForConversationItem,
  listVisibleConversationMessageRows,
  listWorkspaceMemberSyncEventRows,
  withChatRepeatableRead,
  withChatTransaction,
  type ChatConversationItemRow,
  type ChatParticipantRow,
} from "./repo.js"
// Re-exported for existing consumers that import the row DTO from chat/service.
export type { ChatPushTokenRow } from "./repo.js"
import { appendWorkspaceMemberSyncEvent } from "./sync-events.js"
export {
  appendWorkspaceMemberSyncEvent,
  appendWorkspaceMemberSyncEventInTransaction,
} from "./sync-events.js"
import {
  presentChatConversationRecord,
  presentInstant,
  presentOptionalInstant,
  type ChatBootstrapRecord,
  type ChatConversationCreateRecord,
  type ChatConversationEnvelopeRecord,
  type ChatConversationListRecord,
  type ChatConversationMessagesRecord,
  type ChatConversationRecord,
  type ChatConversationReadWatermarkRecord,
  type ChatConversationSendMessageRecord,
  type ChatSyncRecord,
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
import {
  createConversationItemUseCase,
  sendConversationMessageFromParticipantUseCase,
  type ConversationItemPartInput,
  type CreateConversationItemDeps,
  type PreparedConversationItemWrite,
  type SendConversationMessageDeps,
  type MentionedParticipantRef,
} from "./item-write.js"
export type { ConversationItemPartInput } from "./item-write.js"
import {
  createConversationEventUseCase,
  type CreateConversationEventDeps,
} from "./event-write.js"
import {
  enqueueActorWakeupsForConversationMessageUseCase,
  type ActorWakeupDeps,
} from "./actor-wakeup.js"
import { syncVisibleSharedItemUseCase } from "./visible-sync.js"
import { syncConversationUpsertForWorkspaceMembersUseCase } from "./conversation-upsert-sync.js"
import { listConversationRealtimeRecipientsUseCase } from "./realtime-recipients.js"
import {
  sendChatConversationMessageUseCase,
  type SendChatConversationMessageInput,
  type SendChatConversationMessageDeps,
} from "./send-message.js"
import {
  loadConversationViewUseCase,
  loadConversationViewsUseCase,
  type LoadConversationViewsDeps,
} from "./conversation-view.js"
import { type HydratedConversationItemRecord } from "./conversation-item-hydration.js"
import {
  participantDisplayName,
  participantRowToChatParticipantSummary,
  participantRowToEntityRef,
} from "./participant-projection.js"
export { isFeedItemVisibleToWorkspaceMember } from "./conversation-feed-visibility.js"
export { conversationItemDetailToFeedItem } from "./conversation-feed-mapper.js"
import {
  buildChatConversationItems,
  buildConversationItemDetails,
  getConversationFeedItemById,
  hydrateConversationItems,
} from "./conversation-item-read.js"
export {
  getContextConversationItemsForParticipant,
  getConversationFeedItemById,
  getLastVisibleConversationItem,
  listVisibleConversationItemsForParticipant,
} from "./conversation-item-read.js"
import {
  ensureConversationParticipantUseCase,
  getConversationParticipantUseCase,
  insertParticipant,
  listConversationParticipantsUseCase,
} from "./participant-roster.js"
import { enrichTaskForUser } from "../tasks/service.js"
import {
  getConversationRuntimeMap,
  getSessionRuntimeTurnActivityDetail,
} from "../session/runtime.js"

type ConversationKind = (typeof CONVERSATION_KINDS)[number]
type ParticipantKind = ConversationParticipantType
type ItemScope = (typeof CONVERSATION_ITEM_SCOPES)[number]
type ItemSurface = (typeof CONVERSATION_ITEM_SURFACES)[number]
type ItemType = (typeof CONVERSATION_ITEM_TYPES)[number]
type ItemRole = (typeof CONVERSATION_ITEM_ROLES)[number]

type ParticipantRow = ChatParticipantRow

type ItemRow = ChatConversationItemRow

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

function asConversationFeedEventPayload<T extends ConversationFeedEventType>(
  eventType: T,
  payload: Record<string, unknown>
): ConversationFeedEventPayloadMap[T] {
  return payload as unknown as ConversationFeedEventPayloadMap[T]
}

function asChatSyncEventPayload<T extends ChatSyncEventType>(
  eventType: T,
  payload: Record<string, unknown>
): ChatSyncEventPayloadMap[T] {
  return payload as unknown as ChatSyncEventPayloadMap[T]
}

async function enrichChatConversationItemForViewer(
  item: ChatConversationItem,
  userId: string
): Promise<ChatConversationItem> {
  if (item.itemType !== "event" || item.subtype !== "task_requested") {
    return item
  }

  const payload = item.eventPayload
  const task =
    payload && typeof payload === "object" && "task" in payload
      ? (payload as ConversationFeedEventPayloadMap["task_requested"]).task
      : undefined

  if (!task) {
    return item
  }

  return {
    ...item,
    eventPayload: {
      ...payload,
      task: await enrichTaskForUser(task as TaskSummary, userId),
    },
  } as ChatConversationItem
}

async function enrichChatConversationItemsForViewer(
  items: ChatConversationItem[],
  userId: string
) {
  const enriched = await Promise.all(
    items.map((item) => enrichChatConversationItemForViewer(item, userId))
  )
  return enriched
}

async function enrichChatSyncEventPayloadForViewer<T extends ChatSyncEventType>(
  eventType: T,
  payload: ChatSyncEventPayloadMap[T],
  userId: string
): Promise<ChatSyncEventPayloadMap[T]> {
  if (eventType === "conversation.item.created") {
    const eventPayload =
      payload as ChatSyncEventPayloadMap["conversation.item.created"]
    return {
      ...eventPayload,
      item: await enrichChatConversationItemForViewer(
        eventPayload.item,
        userId
      ),
    } as ChatSyncEventPayloadMap[T]
  }

  if (eventType === "task.updated") {
    const eventPayload = payload as ChatSyncEventPayloadMap["task.updated"]
    return {
      ...eventPayload,
      task: await enrichTaskForUser(eventPayload.task, userId),
    } as ChatSyncEventPayloadMap[T]
  }

  return payload
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

async function listConversationParticipantRows(
  queryable: Executor,
  conversationIds: string[],
  options?: { useProfileSnapshot?: boolean }
) {
  return listChatConversationParticipantRows(
    queryable,
    conversationIds,
    options
  )
}

async function getConversationBaseRow(
  queryable: Executor,
  workspaceMemberId: string,
  conversationId: string
) {
  return getChatConversationBaseRow(queryable, {
    workspaceMemberId,
    conversationId,
  })
}

async function listConversationBaseRows(
  queryable: Executor,
  workspaceMemberId: string
) {
  return listChatConversationBaseRows(queryable, workspaceMemberId)
}

async function listItemRowsByIds(queryable: Executor, itemIds: string[]) {
  return listConversationItemRowsByIds(queryable, itemIds)
}

async function getCurrentSyncCursor(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberId: string
) {
  // member_seq is the authoritative client cursor (see getChatSync).
  return toNumber(
    await getWorkspaceMemberSyncCursor(queryable, {
      workspaceId,
      workspaceMemberId,
    })
  )
}

function parseMentionBlockFromPart(part: ConversationItemPartInput) {
  if (part.type !== "json" || !part.json) {
    return null
  }
  const normalized = normalizeCanonicalContentBlocks([part.json as any])
  const block = normalized[0]
  return block?.type === "mention" ? block : null
}

function resolveMentionedConversationParticipant(
  participants: ParticipantRow[],
  mention: ConversationEntityRef
) {
  const activeParticipants = participants.filter(
    (participant) => participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE
  )
  if (mention.participantId) {
    return activeParticipants.find(
      (participant) => participant.id === mention.participantId
    )
  }
  if (mention.workspaceMemberId) {
    return activeParticipants.find(
      (participant) =>
        participant.workspaceMemberId === mention.workspaceMemberId
    )
  }
  if (mention.actorId) {
    return activeParticipants.find(
      (participant) => participant.actorId === mention.actorId
    )
  }
  if (mention.externalUserKey) {
    return activeParticipants.find(
      (participant) =>
        participantRowToEntityRef(participant)?.externalUserKey ===
        mention.externalUserKey
    )
  }
  return null
}

async function canonicalizeConversationItemParts(
  queryable: Executor,
  params: {
    conversationId: string
    parts?: ConversationItemPartInput[]
    activeParticipants?: ParticipantRow[]
  }
): Promise<{
  parts: ConversationItemPartInput[]
  mentionedParticipants: MentionedParticipantRef[]
}> {
  const originalParts = params.parts ?? []
  if (originalParts.length === 0) {
    return {
      parts: [],
      mentionedParticipants: [],
    }
  }
  const participants =
    params.activeParticipants ??
    (
      await listConversationParticipantRows(
        queryable,
        [params.conversationId],
        {
          useProfileSnapshot: true,
        }
      )
    ).filter(
      (participant) =>
        participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE
    )
  const parts: ConversationItemPartInput[] = []
  const mentionedParticipants: MentionedParticipantRef[] = []

  for (const [ordinal, part] of originalParts.entries()) {
    const mentionBlock = parseMentionBlockFromPart(part)
    if (!mentionBlock) {
      parts.push(part)
      continue
    }

    const participant = resolveMentionedConversationParticipant(
      participants,
      mentionBlock.mention
    )
    if (!participant) {
      throw createChatError(
        400,
        "invalid_mention",
        "One or more mentions are invalid for this conversation"
      )
    }
    const canonicalMention = {
      ...mentionBlock,
      mention: participantRowToEntityRef(participant)!,
    }
    mentionedParticipants.push({
      participantId: participant.id,
      ordinal,
    })
    parts.push({
      ...part,
      json: canonicalMention,
      metadata: {
        ...(part.metadata ?? {}),
        mention: canonicalMention.mention,
      },
    })
  }

  return {
    parts,
    mentionedParticipants,
  }
}

async function validateConversationReplyTarget(
  queryable: Executor,
  conversationId: string,
  replyToItemId?: string,
  authorParticipantId?: string
) {
  if (!replyToItemId) {
    return null
  }
  const row = await getVisibleConversationReplyTargetRow(queryable, {
    conversationId,
    replyToItemId,
    authorParticipantId,
  })
  if (!row) {
    throw createChatError(
      400,
      "invalid_reply_to_item",
      "replyToItemId must reference a visible item in the same conversation"
    )
  }
  return row
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

async function prepareConversationItemWrite(
  queryable: Executor,
  params: {
    conversationId: string
    scope: ItemScope
    surface: ItemSurface
    parts?: ConversationItemPartInput[]
    restrictedAudienceParticipantIds?: string[]
    contextTargetParticipantIds?: string[]
    replyToItemId?: string
    authorParticipantId?: string
  }
): Promise<PreparedConversationItemWrite> {
  const activeParticipants =
    params.scope === CONVERSATION_ITEM_SCOPE.SHARED &&
    params.surface === CONVERSATION_ITEM_SURFACE.VISIBLE
      ? await listConversationParticipantRows(
          queryable,
          [params.conversationId],
          {
            useProfileSnapshot: true,
          }
        ).then((participants) =>
          participants.filter(
            (participant) =>
              participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE
          )
        )
      : []
  const validParticipantIds = new Set(
    activeParticipants.map((participant) => participant.id)
  )

  for (const participantId of params.restrictedAudienceParticipantIds ?? []) {
    if (!validParticipantIds.has(participantId)) {
      throw new Error(
        `Invalid restricted audience participant ${participantId}`
      )
    }
  }
  for (const participantId of params.contextTargetParticipantIds ?? []) {
    if (!validParticipantIds.has(participantId)) {
      throw new Error(`Invalid context target participant ${participantId}`)
    }
  }

  const normalizedParts = await canonicalizeConversationItemParts(queryable, {
    conversationId: params.conversationId,
    parts: params.parts,
    activeParticipants,
  })

  return {
    activeParticipants,
    parts: normalizedParts.parts,
    mentionedParticipants: normalizedParts.mentionedParticipants,
    replyToItem: await validateConversationReplyTarget(
      queryable,
      params.conversationId,
      params.replyToItemId,
      params.authorParticipantId
    ),
  }
}

async function listMentionedParticipantIdsForItem(
  queryable: Executor,
  itemId: string
) {
  return listMentionedParticipantIdsForConversationItem(queryable, itemId)
}

export async function enqueueActorWakeupsForConversationMessage(params: {
  workspaceId?: string
  conversationId: string
  itemId: string
  // sourceParticipantType mixes a real participant author kind with the
  // "system" wakeup source (automation / tool-call completion), so it is typed
  // as the wakeup-source enum (which retains 'system') rather than
  // ParticipantKind. The DB participant kind never equals 'system'.
  sourceParticipantType?: SessionWakeupSourceParticipantType
  sourceParticipantId?: string
  sourceName?: string
  summary?: string
  queryable?: Executor
}) {
  if (!params.workspaceId) {
    return []
  }
  return enqueueActorWakeupsForConversationMessageUseCase(
    {
      ...params,
      workspaceId: params.workspaceId,
      queryable: params.queryable ?? rootQueryable(),
    },
    chatActorWakeupDeps()
  )
}

async function syncConversationUpsertForWorkspaceMembers(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberIds: string[],
  conversationId: string
) {
  await syncConversationUpsertForWorkspaceMembersUseCase(
    queryable,
    workspaceId,
    workspaceMemberIds,
    conversationId,
    { loadConversationView }
  )
}

function chatAddParticipantsDeps(): AddChatConversationParticipantsDeps {
  return {
    ensureConversationParticipant,
    listConversationParticipants,
    loadConversationView,
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

function chatConversationViewDeps(): LoadConversationViewsDeps {
  return {
    getConversationBaseRow,
    listConversationBaseRows,
    listConversationParticipants: listConversationParticipantRows,
    listItemRowsByIds,
    buildChatConversationItems,
    participantToSummary: participantRowToChatParticipantSummary,
  }
}

async function loadConversationViews(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberId: string,
  conversationIds?: string[]
) {
  return loadConversationViewsUseCase(
    queryable,
    workspaceId,
    workspaceMemberId,
    conversationIds,
    chatConversationViewDeps()
  )
}

async function loadConversationView(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberId: string,
  conversationId: string
) {
  return loadConversationViewUseCase(
    queryable,
    workspaceId,
    workspaceMemberId,
    conversationId,
    chatConversationViewDeps()
  )
}

function chatCreateConversationDeps(): CreateChatConversationDeps {
  return {
    insertParticipant,
    loadConversationView,
    syncConversationUpsert: syncConversationUpsertForWorkspaceMembers,
  }
}

function chatCreateConversationItemDeps(): CreateConversationItemDeps {
  return {
    prepareConversationItemWrite,
    buildChatConversationItems,
    syncVisibleSharedItem: (params) =>
      syncVisibleSharedItemUseCase(params, {
        syncConversationUpsert: syncConversationUpsertForWorkspaceMembers,
      }),
    createRemoteAgentDeliveriesForItem: async (params) => {
      const { createRemoteAgentDeliveriesForItem } =
        await import("../remote-agents/service.js")
      await createRemoteAgentDeliveriesForItem(params)
    },
  }
}

function chatSendConversationMessageDeps(): SendConversationMessageDeps {
  return {
    createConversationItem,
    enqueueActorWakeupsForConversationMessage,
    notifyRemoteAgentDeliveriesForConversation: async (conversationId) => {
      const { notifyRemoteAgentDeliveriesForConversation } =
        await import("../remote-agents/service.js")
      await notifyRemoteAgentDeliveriesForConversation(conversationId)
    },
  }
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

function chatCreateConversationEventDeps(): CreateConversationEventDeps {
  return {
    listConversationParticipants: listConversationParticipantRows,
    createConversationItem,
  }
}

function chatActorWakeupDeps(): ActorWakeupDeps {
  return {
    listItemRowsByIds,
    conversationItemHasTargets,
    getConversationKind,
    listConversationParticipants: listConversationParticipantRows,
    listMentionedParticipantIdsForItem,
    hydrateConversationItems,
    ensureConversationActorSessionContext: async (params, queryable) => {
      const { ensureConversationActorSessionContext } =
        await import("../session/service.js")
      return ensureConversationActorSessionContext(params, queryable)
    },
    enqueueSessionWakeup: async (params) => {
      const { enqueueSessionWakeup } = await import("../session/runtime.js")
      await enqueueSessionWakeup(params)
    },
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

export async function createConversationItem(params: {
  workspaceId?: string
  conversationId: string
  sessionId?: string
  turnId?: string
  clientMessageId?: string
  scope: ItemScope
  surface: ItemSurface
  itemType: ItemType
  subtype: string
  role: ItemRole
  authorParticipantId?: string
  bundleId?: string
  replyToItemId?: string
  causedByItemId?: string
  eventPayload?: unknown
  eventTimelinePolicy?: ConversationEventTimelinePolicy
  eventContextPolicy?: ConversationEventContextPolicy
  metadata?: Record<string, unknown>
  parts?: ConversationItemPartInput[]
  restrictedAudienceParticipantIds?: string[]
  contextTargetParticipantIds?: string[]
  queryable?: Executor
}) {
  return createConversationItemUseCase(params, chatCreateConversationItemDeps())
}

export async function sendConversationMessageFromParticipant(params: {
  workspaceId?: string
  conversationId: string
  senderParticipantId: string
  sessionId?: string
  clientMessageId?: string
  role?: "user" | "assistant" | "system"
  contentBlocks: CanonicalContentBlock[]
  replyToItemId?: string
  metadata?: Record<string, unknown>
  queryable?: Executor
}) {
  return sendConversationMessageFromParticipantUseCase(
    params,
    chatSendConversationMessageDeps()
  )
}

export async function createConversationEvent<
  T extends ConversationFeedEventType,
>(params: {
  workspaceId?: string
  conversationId: string
  sessionId?: string
  turnId?: string
  eventType: T
  authorParticipantId?: string
  metadata?: Record<string, unknown>
  eventPayload: ConversationFeedEventPayloadMap[T]
  timelinePolicy?: ConversationEventTimelinePolicy
  contextPolicy?: ConversationEventContextPolicy
  restrictedAudienceParticipantIds?: string[]
  contextTargetParticipantIds?: string[]
  queryable?: Executor
}) {
  return createConversationEventUseCase(
    params,
    chatCreateConversationEventDeps()
  )
}

export async function listWorkspaceConversationViews(params: {
  workspaceId: string
  workspaceMemberId: string
  queryable?: Executor
}) {
  const conversations = await loadConversationViews(
    params.queryable ?? rootQueryable(),
    params.workspaceId,
    params.workspaceMemberId
  )
  return conversations.map(presentChatConversationRecord)
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

export async function getChatBootstrap(params: {
  workspaceId: string
  userId: string
}): Promise<ChatBootstrapRecord> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  // Read the conversation projection AND the cursor in ONE repeatable-read
  // snapshot. Otherwise an event committing between the two reads could push
  // the cursor past a state the projection didn't include (e.g. a removal at
  // member_seq=N+1 commits after we read conversations but before we read the
  // cursor) — the client would then tombstone at a boundary that resurrects a
  // stale higher-seq upsert. A single snapshot makes the projection strictly
  // consistent with nextInboxCursor.
  const { conversations, nextInboxCursor } = await withChatRepeatableRead(
    async (trx) => {
      const conversations = await loadConversationViews(
        trx,
        params.workspaceId,
        identity.workspaceMemberId
      )
      const nextInboxCursor = await getCurrentSyncCursor(
        trx,
        params.workspaceId,
        identity.workspaceMemberId
      )
      return { conversations, nextInboxCursor }
    }
  )

  return {
    workspaceMemberId: identity.workspaceMemberId,
    clientInstanceRequired: true,
    conversations,
    nextInboxCursor,
  }
}

export async function getChatSync(params: {
  workspaceId: string
  userId: string
  cursor?: number
  limit?: number
}): Promise<ChatSyncRecord> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 500)
  const result = await listWorkspaceMemberSyncEventRows(rootQueryable(), {
    workspaceId: params.workspaceId,
    workspaceMemberId: identity.workspaceMemberId,
    cursor: params.cursor ?? 0,
    limit: limit + 1,
  })

  const hasMore = result.length > limit
  const rows = hasMore ? result.slice(0, limit) : result
  const events: ChatSyncEvent[] = await Promise.all(
    rows.map(async (row) => {
      const eventType = row.eventType
      const payload = asChatSyncEventPayload(eventType, row.payload)
      const enrichedPayload = await enrichChatSyncEventPayloadForViewer(
        eventType,
        payload,
        identity.userId
      )
      return {
        syncSeq: toNumber(row.syncSeq),
        memberSeq: toNumber(row.memberSeq),
        workspaceId: row.workspaceId,
        workspaceMemberId: row.workspaceMemberId,
        conversationId: row.conversationId ?? undefined,
        itemId: row.itemId ?? undefined,
        eventType,
        payload: enrichedPayload,
        occurredAt: presentInstant(row.occurredAt),
      }
    })
  )

  return {
    events,
    nextCursor:
      events.length > 0
        ? events[events.length - 1]!.memberSeq
        : (params.cursor ?? 0),
    hasMore,
  }
}

export async function getChatConversationMessages(params: {
  workspaceId: string
  userId: string
  conversationId: string
  afterSequence?: number
  beforeSequence?: number
  limit?: number
  clientInstanceId: string
}): Promise<ChatConversationMessagesRecord> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const access = await requireConversationAccess(
    rootQueryable(),
    params.conversationId,
    identity.workspaceMemberId
  )

  await ensureClientInstance(rootQueryable(), {
    workspaceId: params.workspaceId,
    workspaceMemberId: identity.workspaceMemberId,
    clientInstanceId: params.clientInstanceId,
  })

  const limit = Math.min(Math.max(params.limit ?? 100, 1), 200)
  let rows: ItemRow[] = []
  let hasMoreBefore = false
  let hasMoreAfter = false
  if (typeof params.afterSequence === "number") {
    const result = await listVisibleConversationMessageRows(rootQueryable(), {
      conversationId: params.conversationId,
      participantId: access.participant.id,
      afterSequence: params.afterSequence,
      limit: limit + 1,
    })
    hasMoreAfter = result.length > limit
    hasMoreBefore = params.afterSequence > 0
    rows = hasMoreAfter ? result.slice(0, limit) : result
  } else if (typeof params.beforeSequence === "number") {
    const result = await listVisibleConversationMessageRows(rootQueryable(), {
      conversationId: params.conversationId,
      participantId: access.participant.id,
      beforeSequence: params.beforeSequence,
      limit: limit + 1,
    })
    hasMoreBefore = result.length > limit
    hasMoreAfter = true
    rows = (hasMoreBefore ? result.slice(0, limit) : result).reverse()
  } else {
    const result = await listVisibleConversationMessageRows(rootQueryable(), {
      conversationId: params.conversationId,
      participantId: access.participant.id,
      limit: limit + 1,
    })
    hasMoreBefore = result.length > limit
    rows = (hasMoreBefore ? result.slice(0, limit) : result).reverse()
  }

  const items = await buildChatConversationItems(rootQueryable(), rows, {
    includeTransportDeliveries: true,
  })
  const enrichedItems = await enrichChatConversationItemsForViewer(
    items,
    identity.userId
  )

  const conversation = await loadConversationView(
    rootQueryable(),
    params.workspaceId,
    identity.workspaceMemberId,
    params.conversationId
  )
  if (!conversation) {
    throw createChatError(
      404,
      "conversation_not_found",
      "Conversation not found"
    )
  }

  const readState = await getConversationParticipantReadState(rootQueryable(), {
    conversationId: params.conversationId,
    participantId: access.participant.id,
  })

  const row = await getConversationDeviceState(rootQueryable(), {
    conversationId: params.conversationId,
    clientInstanceId: params.clientInstanceId,
  })
  const deviceState: ChatDeviceState = row
    ? {
        clientInstanceId: row.clientInstanceId,
        conversationId: row.conversationId,
        lastVisibleSequence: toNumber(row.lastVisibleSequence),
        lastInboxSeq: toNumber(row.lastInboxSeq),
        lastOpenedAt: presentOptionalInstant(row.lastOpenedAt),
        draftPayload: row.draftPayload,
      }
    : {
        clientInstanceId: params.clientInstanceId,
        conversationId: params.conversationId,
        lastVisibleSequence: 0,
        lastInboxSeq: 0,
        draftPayload: {},
      }

  const runtimeMap = await getConversationRuntimeMap([params.conversationId])
  const remoteAgentIds = conversation.participants
    .filter(
      (participant) =>
        participant.participantType ===
        CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
    )
    .map((participant) => participant.remoteAgentId)
    .filter((value): value is string => Boolean(value))
  const runtimeByRemoteAgent: Record<string, any> = {}
  if (remoteAgentIds.length > 0) {
    const { loadRemoteAgentRuntimeSnapshot } =
      await import("../remote-agents/service.js")
    for (const remoteAgentId of remoteAgentIds) {
      // Pass the chat's conversationId so the snapshot reflects this
      // conversation's runtime state, not whichever sibling conversation
      // happened to win the global LATERAL pick in the snapshot SQL.
      // Core execution is already per-conversation; this completes the
      // user-visible isolation.
      const snapshot = await loadRemoteAgentRuntimeSnapshot(remoteAgentId, {
        conversationId: params.conversationId,
      })
      if (snapshot) {
        runtimeByRemoteAgent[remoteAgentId] = snapshot
      }
    }
  }

  return {
    conversation,
    items: enrichedItems,
    runtimeByActor: runtimeMap[params.conversationId] || {},
    runtimeByRemoteAgent,
    participantReadWatermarkSequence: toNumber(
      readState?.readWatermarkSequence
    ),
    deviceState,
    hasMoreBefore,
    hasMoreAfter,
  }
}

export async function getChatConversationActorRuntimeTurnDetail(params: {
  workspaceId: string
  userId: string
  conversationId: string
  actorId: string
  turnId: string
}): Promise<ActorRuntimeTurnActivityDetail> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  await requireConversationAccess(
    rootQueryable(),
    params.conversationId,
    identity.workspaceMemberId
  )

  const detail = await getSessionRuntimeTurnActivityDetail({
    conversationId: params.conversationId,
    actorId: params.actorId,
    turnId: params.turnId,
  })
  if (!detail) {
    throw createChatError(
      404,
      "runtime_turn_not_found",
      "Current turn activity not found"
    )
  }

  return detail
}

export async function sendChatConversationMessage(
  params: SendChatConversationMessageInput
): Promise<ChatConversationSendMessageRecord> {
  return sendChatConversationMessageUseCase(params, chatRouteSendMessageDeps())
}

export async function updateChatConversationReadWatermark(
  params: ReadWatermarkInput
): Promise<ChatConversationReadWatermarkRecord> {
  return updateChatConversationReadWatermarkUseCase(params, {
    syncConversationUpsert: syncConversationUpsertForWorkspaceMembers,
  })
}

// ============ Stage 3: conversation CRUD ============

export async function listChatConversations(params: {
  workspaceId: string
  userId: string
}): Promise<ChatConversationListRecord> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const conversations = await loadConversationViews(
    rootQueryable(),
    params.workspaceId,
    identity.workspaceMemberId
  )
  return {
    workspaceMemberId: identity.workspaceMemberId,
    conversations,
  }
}

export async function getChatConversationDetail(params: {
  workspaceId: string
  userId: string
  conversationId: string
}): Promise<ChatConversationEnvelopeRecord> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const queryable = rootQueryable()
  await requireConversationAccess(
    queryable,
    params.conversationId,
    identity.workspaceMemberId
  )
  const conversation = await loadConversationView(
    queryable,
    params.workspaceId,
    identity.workspaceMemberId,
    params.conversationId
  )
  if (!conversation) {
    throw createChatError(
      404,
      "conversation_not_found",
      "Conversation not found"
    )
  }
  return { conversation }
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
      loadConversationView,
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
