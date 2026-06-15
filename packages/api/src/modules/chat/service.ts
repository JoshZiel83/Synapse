import {
  buildConversationMessageRef,
  CHAT_MEMBERSHIP_UPDATE_REASON,
  CHAT_PARTICIPANT_REMOVAL_STATE,
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SCOPES,
  CONVERSATION_ITEM_ROLE,
  CONVERSATION_ITEM_ROLES,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_SURFACES,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_ITEM_TYPES,
  CONVERSATION_FEED_MESSAGE_TYPE,
  CONVERSATION_KINDS,
  CONVERSATION_MESSAGE_TRANSPORT_DIRECTION,
  CONVERSATION_MESSAGE_SUBTYPE,
  CONVERSATION_MESSAGE_SUBTYPES,
  CONVERSATION_PARTICIPANT_ROLE_KEY,
  CONVERSATION_PARTICIPANT_STATE,
  CONVERSATION_PARTICIPANT_TYPE,
  CONVERSATION_REPLY_REF_SPECIAL_SUBTYPE,
  normalizeCanonicalContentBlocks,
  parseConversationMessageRef,
  extractText,
  type CanonicalContentBlock,
  type ActorRuntimeTurnActivityDetail,
  type ChatConversationEventItem,
  type ChatConversationItem,
  type ChatConversationSendMessageRequest,
  type ChatDeviceState,
  type ChatParticipantSummary,
  type ChatParticipantRemovalState,
  type ChatSyncEvent,
  type ChatSyncEventPayloadMap,
  type ChatSyncEventType,
  type Timestamp,
  type ConversationMessageSubtype,
  type ConversationParticipantType,
  type ConversationReplyRef,
  type SessionWakeupSourceParticipantType,
  isTransportKind,
} from "@synapse/shared"
import { assertIsoInstant } from "@synapse/shared/datetime"
import type {
  ConversationEntityRef,
  ConversationEventContextPolicy,
  ConversationEventTimelinePolicy,
  ConversationFeedEventItem,
  ConversationFeedItemSubtype,
  ConversationFeedEventPayloadMap,
  ConversationFeedEventType,
  ConversationFeedItem,
  ConversationFeedMessageItem,
  ConversationMessageTransportContext,
  ConversationMessageTransportDelivery,
  TaskSummary,
} from "@synapse/shared/types"
import { type Executor } from "../../infrastructure/database/kysely.js"
import { SUBJECT_KIND } from "@synapse/shared"
import {
  subjectKindToParticipantType,
  upsertAccessSubject,
  upsertAccessSubjectOn,
} from "../access/subject-registry.js"
import { getFileUrlById } from "../files/service.js"
import {
  buildNormalizedMessageContent,
  canonicalContentBlocksToDraftParts,
  itemPartsToCanonicalContentBlocks,
} from "./message-content.js"
import {
  requireConversationAccess,
  requireConversationManagement,
} from "./conversation-access.js"
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
  parseInstantString,
  serializeNowInstant,
} from "../../infrastructure/datetime.js"
import {
  chatRootExecutor,
  conversationItemHasTargets,
  conversationParticipantExists,
  countUnreadVisibleConversationMessages,
  getChatConversationCreateRequestConversationId,
  getChatConversationBaseRow,
  getConversationMaxSequence,
  getConversationDeviceState,
  getConversationParticipantById,
  getConversationKind,
  getConversationRecord,
  getLastConversationItemIdAtOrBeforeSequence,
  getLastVisibleConversationItemRow,
  getConversationParticipantReadState,
  getConversationParticipantStateBySubject,
  getConversationItemRowById,
  getTransportAddressSubjectRow,
  getVisibleConversationReplyRefRow,
  getVisibleConversationReplyTargetRow,
  getWorkspaceMemberSyncCursor,
  insertChatConversationCreateRequest,
  insertConversationRecord,
  insertConversationRecordReturning,
  insertConversationItemDetailRows,
  insertConversationItemRecord,
  insertConversationParticipantRecord,
  listActorDisplayNameRows,
  listChatConversationBaseRows,
  listChatConversationParticipantRows,
  listContextConversationItemRowsForParticipant,
  listConversationItemPartRows,
  listConversationItemRowsByIds,
  listConversationItemTargetRows,
  listConversationParticipantStatesByWorkspaceMember,
  listConversationRealtimeRecipientRows,
  listConversationItemContextTargetRows,
  listTransportDeliveryRowsForItems,
  listNearbyVisibleConversationReplyRefRows,
  listMentionedParticipantIdsForConversationItem,
  listRemoteAgentDisplayNameRows,
  listVisibleConversationMessageRows,
  listWorkspaceMemberSyncEventRows,
  listWorkspaceMemberNameRows,
  reactivateConversationParticipant,
  updateConversationItemEventPayload as updateConversationItemEventPayloadRow,
  updateConversationMutableFields,
  updateConversationParticipantState,
  upsertConversationDeviceState,
  upsertConversationParticipantReadState,
  upsertWorkspaceMemberConversationView,
  upsertConversationParticipantAddress,
  touchConversationUpdatedAt,
  withChatRepeatableRead,
  withChatTransaction,
  type ChatConversationBaseRow,
  type ChatConversationItemRow,
  type ChatConversationItemPartRow,
  type ChatParticipantRow,
} from "./repo.js"
// Re-exported for existing consumers that import the row DTO from chat/service.
export type { ChatPushTokenRow } from "./repo.js"
import {
  appendWorkspaceMemberSyncEvent,
  appendWorkspaceMemberSyncEventInTransaction,
} from "./sync-events.js"
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
import {
  getConversationEventSpec,
  isConversationEventType,
  renderConversationEventTimelineBlocks,
} from "./event-registry.js"
import { createChatError } from "./errors.js"
export { isChatServiceError, type ChatServiceError } from "./errors.js"
import {
  recordDuplicateClientMessageIdSend,
  recordDuplicateWatermarkPost,
} from "./observability.js"
import { getWorkspaceMemberIdentityOrThrow } from "./identity.js"
import { normalizeConversationParticipantRoleKey } from "./roles.js"
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
type NonEventItemType = Exclude<ItemType, "event">
type MessageLikeItemType = Exclude<NonEventItemType, "summary">

export interface ConversationItemPartInput {
  type: "text" | "file_ref" | "json"
  text?: string
  refPath?: string | null
  refSha256?: string | null
  json?: unknown
  mimeType?: string
  name?: string
  metadata?: Record<string, unknown>
}

type ConversationBaseRow = ChatConversationBaseRow

type ParticipantRow = ChatParticipantRow

type ItemRow = ChatConversationItemRow

type ItemPartRow = ChatConversationItemPartRow

interface ConversationItemDetailBase {
  id: string
  conversationId: string
  sessionId?: string
  turnId?: string
  sequence: number
  scope: ItemScope
  surface: ItemSurface
  role: ItemRole
  authorParticipantId?: string
  authorParticipant?: ParticipantRow
  restrictedAudienceParticipants: ParticipantRow[]
  contextTargets: ParticipantRow[]
  contentBlocks: CanonicalContentBlock[]
  metadata: Record<string, unknown>
  replyToItemId?: string
  replyTo?: ConversationReplyRef
  causedByItemId?: string
  createdAt: Timestamp
  clientMessageId?: string
}

export type ConversationNonEventItemDetail =
  | (ConversationItemDetailBase & {
      itemType: MessageLikeItemType
      subtype: ConversationMessageSubtype
    })
  | (ConversationItemDetailBase & {
      itemType: typeof CONVERSATION_ITEM_TYPE.SUMMARY
      subtype: typeof CONVERSATION_FEED_MESSAGE_TYPE.SUMMARY
    })

export interface ConversationEventItemDetail<
  T extends ConversationFeedEventType = ConversationFeedEventType,
> extends ConversationItemDetailBase {
  itemType: "event"
  subtype: T
  eventPayload: ConversationFeedEventPayloadMap[T]
  eventTimelinePolicy?: ConversationEventTimelinePolicy
  eventContextPolicy?: ConversationEventContextPolicy
}

export type ConversationItemDetail =
  | ConversationNonEventItemDetail
  | ConversationEventItemDetail

type HydratedConversationItemRecord = {
  id: string
  conversationId: string
  sequence: number
  clientMessageId?: string
  itemType: ItemType
  role: ItemRole
  subtype: string
  scope: ItemScope
  surface: ItemSurface
  authorParticipantId?: string
  replyToItemId?: string
  causedByItemId?: string
  content: string
  contentBlocks: CanonicalContentBlock[]
  metadata: Record<string, unknown>
  restrictedAudienceParticipantIds: string[]
  createdAt: Timestamp
}

type SendMessageInput = {
  workspaceId: string
  workspaceMemberId: string
  conversationId: string
} & ChatConversationSendMessageRequest

type ReadWatermarkInput = {
  workspaceId: string
  workspaceMemberId: string
  conversationId: string
  clientInstanceId: string
  readUpToSequence: number
  lastVisibleSequence?: number
}

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

const CONVERSATION_MESSAGE_SUBTYPE_SET = new Set<ConversationMessageSubtype>(
  CONVERSATION_MESSAGE_SUBTYPES
)

function isConversationMessageSubtype(
  value: string
): value is ConversationMessageSubtype {
  return CONVERSATION_MESSAGE_SUBTYPE_SET.has(
    value as ConversationMessageSubtype
  )
}

function assertConversationMessageSubtype(
  value: string
): asserts value is ConversationMessageSubtype {
  if (!isConversationMessageSubtype(value)) {
    throw new Error(`Unsupported conversation message subtype: ${value}`)
  }
}

function normalizeConversationItemSubtype(
  itemType: ItemType,
  subtype: string,
  itemId: string
): ConversationFeedItemSubtype {
  if (itemType === CONVERSATION_ITEM_TYPE.EVENT) {
    if (!isConversationEventType(subtype)) {
      throw new Error(
        `Unsupported conversation event subtype ${subtype} for item ${itemId}`
      )
    }
    return subtype
  }

  if (itemType === CONVERSATION_ITEM_TYPE.SUMMARY) {
    if (subtype !== CONVERSATION_FEED_MESSAGE_TYPE.SUMMARY) {
      throw new Error(
        `Unsupported conversation summary subtype ${subtype} for item ${itemId}`
      )
    }
    return subtype
  }

  assertConversationMessageSubtype(subtype)
  return subtype
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

function asParticipantTransportKind(
  value: string | null | undefined
): ConversationEntityRef["transportKind"] {
  return isTransportKind(value) ? value : undefined
}

function participantDisplayName(row: ParticipantRow): string {
  if (row.participantType === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER) {
    if (typeof row.userName === "string" && row.userName.trim()) {
      return row.userName.trim()
    }
  }
  if (row.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR) {
    if (typeof row.participantName === "string" && row.participantName.trim()) {
      return row.participantName.trim()
    }
  }
  if (row.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT) {
    if (typeof row.participantName === "string" && row.participantName.trim()) {
      return row.participantName.trim()
    }
  }
  if (
    row.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL &&
    typeof row.transportDisplayName === "string" &&
    row.transportDisplayName.trim()
  ) {
    return row.transportDisplayName.trim()
  }
  if (
    row.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL &&
    typeof row.displayName === "string" &&
    row.displayName.trim()
  ) {
    return row.displayName.trim()
  }
  if (typeof row.linkedUserName === "string" && row.linkedUserName.trim()) {
    return row.linkedUserName.trim()
  }
  if (typeof row.userName === "string" && row.userName.trim()) {
    return row.userName.trim()
  }
  if (typeof row.participantName === "string" && row.participantName.trim()) {
    return row.participantName.trim()
  }
  if (typeof row.displayName === "string" && row.displayName.trim()) {
    return row.displayName.trim()
  }
  return "Unknown"
}

function participantAvatarUrl(row: ParticipantRow): string | undefined {
  const fileId =
    row.participantAvatarFileId ??
    row.userAvatarFileId ??
    row.linkedUserAvatarFileId
  return fileId ? getFileUrlById(fileId) : undefined
}

function participantAvatarEmoji(row: ParticipantRow): string | undefined {
  return row.participantAvatarEmoji ?? undefined
}

function previewTextFromItem(item: ChatConversationItem | undefined): string {
  if (!item) return ""
  const text = item.content.trim() || extractText(item.contentBlocks).trim()
  if (text) return text
  return item.itemType === "message" ? "Attachment" : `[${item.subtype}]`
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

async function hydrateConversationItems(
  queryable: Executor,
  itemRows: ItemRow[]
) {
  if (itemRows.length === 0) {
    return [] as HydratedConversationItemRecord[]
  }

  const itemIds = itemRows.map((row) => row.id)
  const [parts, restrictedAudience] = await Promise.all([
    listConversationItemPartRows(queryable, itemIds),
    listConversationItemTargetRows(queryable, itemIds),
  ])

  const partsByItem = new Map<string, ItemPartRow[]>()
  for (const row of parts) {
    const current = partsByItem.get(row.itemId) ?? []
    current.push(row)
    partsByItem.set(row.itemId, current)
  }

  const restrictedAudienceByItem = new Map<string, string[]>()
  for (const row of restrictedAudience) {
    const current = restrictedAudienceByItem.get(row.itemId) ?? []
    current.push(row.targetParticipantId)
    restrictedAudienceByItem.set(row.itemId, current)
  }

  const itemMap = new Map<string, HydratedConversationItemRecord>()
  for (const row of itemRows) {
    const contentBlocks = itemPartsToCanonicalContentBlocks(
      (partsByItem.get(row.id) ?? []) as Parameters<
        typeof itemPartsToCanonicalContentBlocks
      >[0]
    )
    itemMap.set(row.id, {
      id: row.id,
      conversationId: row.conversationId,
      sequence: toNumber(row.sequence),
      clientMessageId: row.clientMessageId ?? undefined,
      itemType: row.itemType,
      role: row.role,
      subtype: row.subtype,
      scope: row.scope,
      surface: row.surface,
      authorParticipantId: row.authorParticipantId ?? undefined,
      replyToItemId: row.replyToItemId ?? undefined,
      causedByItemId: row.causedByItemId ?? undefined,
      content: extractText(contentBlocks),
      contentBlocks,
      metadata: row.metadata,
      restrictedAudienceParticipantIds:
        restrictedAudienceByItem.get(row.id) ?? [],
      createdAt: presentInstant(row.createdAt),
    })
  }

  return itemRows.map((row) => itemMap.get(row.id)!).filter(Boolean)
}

async function loadConversationViews(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberId: string,
  conversationIds?: string[]
) {
  const baseRows = conversationIds
    ? await Promise.all(
        conversationIds.map((conversationId) =>
          getConversationBaseRow(queryable, workspaceMemberId, conversationId)
        )
      ).then((rows) => rows.filter(Boolean) as ConversationBaseRow[])
    : await listConversationBaseRows(queryable, workspaceMemberId)

  if (baseRows.length === 0) {
    return [] as ChatConversationRecord[]
  }

  const ids = baseRows.map((row) => row.conversationId)
  const participants = await listConversationParticipantRows(queryable, ids)
  const participantsByConversation = new Map<string, ParticipantRow[]>()
  for (const row of participants) {
    const current = participantsByConversation.get(row.conversationId) ?? []
    current.push(row)
    participantsByConversation.set(row.conversationId, current)
  }

  const lastItemIds = baseRows
    .map((row) => row.lastVisibleItemId)
    .filter((value): value is string => Boolean(value))
  const lastItemRows = await listItemRowsByIds(queryable, [
    ...new Set(lastItemIds),
  ])
  const lastItems = await buildChatConversationItems(queryable, lastItemRows)
  const lastItemById = new Map(lastItems.map((item) => [item.id, item]))

  return baseRows.map((row) => {
    const conversationParticipants =
      participantsByConversation.get(row.conversationId) ?? []
    const mappedParticipants = conversationParticipants.map(
      participantRowToChatParticipantSummary
    )
    const viewerMembership = conversationParticipants.find(
      (participant) =>
        participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE &&
        participant.participantType ===
          CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
        participant.workspaceMemberId === workspaceMemberId
    )
    const viewerConversationRole = normalizeConversationParticipantRoleKey(
      viewerMembership?.roleKey
    )
    const lastItem = row.lastVisibleItemId
      ? lastItemById.get(row.lastVisibleItemId)
      : undefined
    return {
      conversationId: row.conversationId,
      workspaceId,
      baseTitle: row.title,
      kind: row.kind,
      isIm: row.isIm,
      unreadCount: toNumber(row.unreadCount),
      muted: Boolean(row.muted),
      archived: Boolean(row.archived),
      pinnedSortKey: row.pinnedSortKey ?? undefined,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
      participants: mappedParticipants,
      viewerWorkspaceMemberId: workspaceMemberId,
      viewerParticipantId: viewerMembership?.id,
      viewerConversationRole,
      lastItem: lastItem
        ? {
            itemId: lastItem.id,
            sequence: lastItem.sequence,
            itemType: lastItem.itemType,
            subtype: lastItem.subtype,
            previewText: previewTextFromItem(lastItem),
            authorParticipantId: lastItem.authorParticipantId,
            author: lastItem.author,
            createdAt: lastItem.createdAt,
          }
        : undefined,
    } satisfies ChatConversationRecord
  })
}

async function loadConversationView(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberId: string,
  conversationId: string
) {
  const views = await loadConversationViews(
    queryable,
    workspaceId,
    workspaceMemberId,
    [conversationId]
  )
  return views[0] ?? null
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

async function countUnreadVisibleMessages(
  queryable: Executor,
  conversationId: string,
  participantId: string
) {
  return toNumber(
    await countUnreadVisibleConversationMessages(queryable, {
      conversationId,
      participantId,
    })
  )
}

async function syncVisibleSharedItem(params: {
  queryable: Executor
  workspaceId?: string
  conversationId: string
  item: ChatConversationItem
  activeParticipants: ParticipantRow[]
  authorParticipantId?: string
  restrictedAudienceParticipantIds?: string[]
}) {
  const effectiveVisibleParticipantIds =
    params.restrictedAudienceParticipantIds &&
    params.restrictedAudienceParticipantIds.length > 0
      ? [
          ...new Set([
            ...params.restrictedAudienceParticipantIds,
            ...(params.authorParticipantId ? [params.authorParticipantId] : []),
          ]),
        ]
      : params.activeParticipants.map((participant) => participant.id)

  const visibleHumanParticipants = params.activeParticipants.filter(
    (participant) =>
      participant.workspaceMemberId &&
      effectiveVisibleParticipantIds.includes(participant.id)
  )

  for (const participant of visibleHumanParticipants) {
    const unreadCount = await countUnreadVisibleMessages(
      params.queryable,
      params.conversationId,
      participant.id
    )
    await upsertConversationView(params.queryable, {
      workspaceMemberId: participant.workspaceMemberId!,
      conversationId: params.conversationId,
      lastVisibleItemId: params.item.id,
      lastVisibleSequence: params.item.sequence,
      lastVisibleAt: params.item.createdAt,
      unreadCount,
      summary: {
        previewText: previewTextFromItem(params.item),
      },
    })
  }

  if (params.workspaceId) {
    for (const participant of visibleHumanParticipants) {
      await appendWorkspaceMemberSyncEvent(params.queryable, {
        workspaceId: params.workspaceId,
        workspaceMemberId: participant.workspaceMemberId!,
        conversationId: params.conversationId,
        itemId: params.item.id,
        eventType: "conversation.item.created",
        payload: {
          conversationId: params.conversationId,
          item: params.item,
        },
      })
    }

    await syncConversationUpsertForWorkspaceMembers(
      params.queryable,
      params.workspaceId,
      visibleHumanParticipants
        .map((participant) => participant.workspaceMemberId)
        .filter((value): value is string => Boolean(value)),
      params.conversationId
    )
  }
}

async function upsertConversationView(
  queryable: Executor,
  params: {
    workspaceMemberId: string
    conversationId: string
    lastVisibleItemId?: string | null
    lastVisibleSequence?: number
    lastVisibleAt?: string
    unreadCount: number
    summary?: Record<string, unknown>
  }
) {
  await upsertWorkspaceMemberConversationView(queryable, {
    ...params,
    lastVisibleAt: params.lastVisibleAt
      ? parseInstantString(params.lastVisibleAt)
      : null,
  })
}

async function getConversationSequenceMax(
  queryable: Executor,
  conversationId: string
) {
  return toNumber(await getConversationMaxSequence(queryable, conversationId))
}

async function getLastItemAtOrBeforeSequence(
  queryable: Executor,
  conversationId: string,
  sequence: number
) {
  return getLastConversationItemIdAtOrBeforeSequence(
    queryable,
    conversationId,
    sequence
  )
}

type PendingActorWakeup = {
  actorId: string
  sessionId: string
  sourceType: "user_message" | "actor_message"
}

type MentionedParticipantRef = {
  participantId: string
  ordinal: number
}

type PreparedConversationItemWrite = {
  activeParticipants: ParticipantRow[]
  parts: ConversationItemPartInput[]
  mentionedParticipants: MentionedParticipantRef[]
  replyToItem: ItemRow | null
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

function resolveActorWakeParticipants(params: {
  conversationKind: ConversationKind
  activeParticipants: ParticipantRow[]
  authorParticipantId?: string
  mentionedParticipantIds: string[]
  replyAuthorParticipantId?: string | null
}) {
  const actorParticipants = params.activeParticipants.filter(
    (participant) =>
      participant.id !== params.authorParticipantId &&
      participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE &&
      typeof participant.actorId === "string" &&
      participant.actorId.length > 0
  )
  if (actorParticipants.length === 0) {
    return []
  }
  if (params.conversationKind !== "group") {
    return actorParticipants
  }

  const mentionedSet = new Set(params.mentionedParticipantIds)
  const explicitWakeTargets = new Map<string, ParticipantRow>()
  for (const participant of actorParticipants) {
    if (mentionedSet.has(participant.id)) {
      explicitWakeTargets.set(participant.id, participant)
    }
  }
  if (params.replyAuthorParticipantId) {
    const replyActor = actorParticipants.find(
      (participant) => participant.id === params.replyAuthorParticipantId
    )
    if (replyActor) {
      explicitWakeTargets.set(replyActor.id, replyActor)
    }
  }
  if (explicitWakeTargets.size > 0) {
    return Array.from(explicitWakeTargets.values())
  }
  if (params.mentionedParticipantIds.length > 0) {
    return []
  }
  return actorParticipants
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
    return [] as PendingActorWakeup[]
  }
  const queryable = params.queryable ?? rootQueryable()
  const itemRows = await listItemRowsByIds(queryable, [params.itemId])
  const itemRow = itemRows[0]
  if (!itemRow) {
    return [] as PendingActorWakeup[]
  }
  if (
    itemRow.itemType !== "message" ||
    itemRow.scope !== "shared" ||
    itemRow.surface !== "visible"
  ) {
    return [] as PendingActorWakeup[]
  }

  if (await conversationItemHasTargets(queryable, params.itemId)) {
    return [] as PendingActorWakeup[]
  }

  const conversationKind = await getConversationKind(
    queryable,
    params.conversationId
  )
  if (!conversationKind) {
    return [] as PendingActorWakeup[]
  }

  const activeParticipants = await listConversationParticipantRows(
    queryable,
    [params.conversationId],
    { useProfileSnapshot: true }
  ).then((participants) =>
    participants.filter(
      (participant) =>
        participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE
    )
  )
  const authorParticipant = itemRow.authorParticipantId
    ? activeParticipants.find(
        (participant) => participant.id === itemRow.authorParticipantId
      )
    : undefined
  const sourceParticipantType =
    params.sourceParticipantType ?? authorParticipant?.participantType
  if (!sourceParticipantType || sourceParticipantType === "system") {
    return [] as PendingActorWakeup[]
  }

  const mentionedParticipantIds = await listMentionedParticipantIdsForItem(
    queryable,
    params.itemId
  )
  const replyAuthorParticipantId = itemRow.replyToItemId
    ? ((await listItemRowsByIds(queryable, [itemRow.replyToItemId]))[0]
        ?.authorParticipantId ?? null)
    : null
  const wakeParticipants = resolveActorWakeParticipants({
    conversationKind,
    activeParticipants,
    authorParticipantId: itemRow.authorParticipantId ?? undefined,
    mentionedParticipantIds,
    replyAuthorParticipantId,
  })
  if (wakeParticipants.length === 0) {
    return [] as PendingActorWakeup[]
  }

  const sourceType =
    sourceParticipantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
      ? "actor_message"
      : "user_message"
  const sourceParticipantId =
    params.sourceParticipantId ??
    (sourceParticipantType === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER
      ? (authorParticipant?.workspaceMemberId ?? undefined)
      : sourceParticipantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
        ? (authorParticipant?.actorId ?? undefined)
        : (itemRow.authorParticipantId ?? undefined))
  const sourceName =
    params.sourceName ??
    (authorParticipant ? participantDisplayName(authorParticipant) : undefined)
  const itemSummary =
    params.summary ??
    (await hydrateConversationItems(queryable, [itemRow]))
      .map((item) => item.content.trim())
      .find(Boolean) ??
    "New message"

  const { ensureConversationActorSessionContext } =
    await import("../session/service.js")
  const { enqueueSessionWakeup } = await import("../session/runtime.js")
  const pendingWakeups: PendingActorWakeup[] = []

  for (const participant of wakeParticipants) {
    if (!participant.actorId) {
      continue
    }
    const ensuredContext = await ensureConversationActorSessionContext(
      {
        workspaceId: params.workspaceId,
        actorId: participant.actorId,
        conversationId: params.conversationId,
        trigger: sourceType,
      },
      queryable
    )
    await enqueueSessionWakeup({
      sessionId: ensuredContext.sessionId,
      actorId: participant.actorId,
      workspaceId: params.workspaceId,
      sourceType,
      sourceItemId: params.itemId,
      sourceParticipantType,
      sourceParticipantId,
      sourceName,
      summary:
        itemSummary.replace(/\s+/g, " ").trim().slice(0, 96) || "New message",
      metadata: {
        source: "chat.message_wakeup",
        conversationId: params.conversationId,
      },
      trigger: sourceType,
    })
    pendingWakeups.push({
      actorId: participant.actorId,
      sessionId: ensuredContext.sessionId,
      sourceType,
    })
  }

  return pendingWakeups
}

async function loadHumanParticipantsForConversation(
  queryable: Executor,
  conversationId: string
) {
  const participants = await listConversationParticipantRows(queryable, [
    conversationId,
  ])
  return participants.filter(
    (participant) =>
      participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE &&
      typeof participant.workspaceMemberId === "string" &&
      participant.workspaceMemberId.length > 0
  )
}

async function syncConversationUpsertForWorkspaceMembers(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberIds: string[],
  conversationId: string
) {
  for (const workspaceMemberId of [...new Set(workspaceMemberIds)]) {
    const conversationRecord = await loadConversationView(
      queryable,
      workspaceId,
      workspaceMemberId,
      conversationId
    )
    if (!conversationRecord) {
      continue
    }
    await appendWorkspaceMemberSyncEvent(queryable, {
      workspaceId,
      workspaceMemberId,
      conversationId,
      eventType: "conversation.upsert",
      payload: {
        conversation: presentChatConversationRecord(conversationRecord),
      },
    })
  }
}

/**
 * Resolve the access_subjects.id for a participant of the given kind, minting
 * the subject if needed. Shared by `insertParticipant` (write) and
 * `ensureConversationParticipant` (dedup lookup) so both agree on the subject
 * identity — dedup is keyed on (conversation_id, subject_id), not display_name.
 */
async function resolveParticipantSubjectId(
  queryable: Executor,
  params: {
    participantType: ParticipantKind
    workspaceMemberId?: string
    actorId?: string
    remoteAgentId?: string
    transportAddressId?: string
  }
): Promise<string> {
  if (
    params.participantType === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
    params.workspaceMemberId
  ) {
    return upsertAccessSubjectOn(queryable, {
      kind: SUBJECT_KIND.WORKSPACE_MEMBER,
      memberId: params.workspaceMemberId,
    })
  }
  if (
    params.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR &&
    params.actorId
  ) {
    return upsertAccessSubjectOn(queryable, {
      kind: SUBJECT_KIND.ACTOR,
      actorId: params.actorId,
    })
  }
  if (
    params.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT &&
    params.remoteAgentId
  ) {
    return upsertAccessSubjectOn(queryable, {
      kind: SUBJECT_KIND.REMOTE_AGENT,
      remoteAgentId: params.remoteAgentId,
    })
  }
  // external participant. Require a transport identity (no throwaway).
  if (!params.transportAddressId) {
    throw new Error(
      "resolveParticipantSubjectId: external participant requires transportAddressId"
    )
  }
  const addr = await getTransportAddressSubjectRow(
    queryable,
    params.transportAddressId
  )
  if (!addr) {
    throw new Error(
      `resolveParticipantSubjectId: transport_addresses(${params.transportAddressId}) not found`
    )
  }
  if (addr.addressType !== "user") {
    throw new Error(
      `resolveParticipantSubjectId: address ${params.transportAddressId} is not a user address`
    )
  }
  if (addr.workspaceMemberId) {
    throw new Error(
      `resolveParticipantSubjectId: address ${params.transportAddressId} is linked to a workspace member; add it as a member, not an external participant`
    )
  }
  return upsertAccessSubjectOn(queryable, {
    kind: SUBJECT_KIND.EXTERNAL,
    workspaceId: addr.workspaceId,
    transportAddressId: params.transportAddressId,
  })
}

async function insertParticipant(
  queryable: Executor,
  params: {
    conversationId: string
    participantType: ParticipantKind
    workspaceMemberId?: string
    actorId?: string
    remoteAgentId?: string
    actorJoinVersionId?: string
    displayName?: string
    roleKey: string
    metadata?: Record<string, unknown>
    // The transport identity for an external participant: mints the first-class
    // subject AND is bound to the participant via conversation_participant_addresses.
    transportAddressId?: string
    // Optional pre-resolved subject id (from resolveParticipantSubjectId) so
    // the dedup lookup and the insert agree on the same subject without
    // resolving twice.
    subjectId?: string
  }
) {
  const participantId = crypto.randomUUID()
  // Every participant gets a real subject_id. Workspace_member / actor /
  // remote_agent map to their canonical access_subjects rows; external maps to
  // a first-class, workspace-rooted subject keyed by its transport_address
  // (deduped across conversations). There is no throwaway/anonymous escape
  // hatch — an external participant must carry a transport identity.
  const participantSubjectId =
    params.subjectId ?? (await resolveParticipantSubjectId(queryable, params))
  await insertConversationParticipantRecord(queryable, {
    participantId,
    conversationId: params.conversationId,
    subjectId: participantSubjectId,
    actorJoinVersionId: params.actorJoinVersionId,
    displayName: params.displayName,
    roleKey: params.roleKey,
    metadata: params.metadata,
    transportAddressId: params.transportAddressId,
  })

  return {
    id: participantId,
  }
}

async function loadWorkspaceMembersByIds(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberIds: string[]
) {
  return listWorkspaceMemberNameRows(queryable, workspaceId, workspaceMemberIds)
}

async function loadActorsByIds(
  queryable: Executor,
  workspaceId: string,
  actorIds: string[]
) {
  return listActorDisplayNameRows(queryable, workspaceId, actorIds)
}

async function loadRemoteAgentsByIds(
  queryable: Executor,
  workspaceId: string,
  remoteAgentIds: string[]
) {
  return listRemoteAgentDisplayNameRows(queryable, workspaceId, remoteAgentIds)
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
  const queryable = params.queryable ?? rootQueryable()
  if (!params.workspaceId) {
    // Every conversation is workspace-scoped (conversations.workspace_id is
    // NOT NULL). Assert here so a missing id fails loudly instead of writing a
    // null and tripping the DB constraint deep in a transaction.
    throw new Error("createConversation: workspaceId is required")
  }
  const id = crypto.randomUUID()
  return insertConversationRecordReturning(queryable, {
    conversationId: id,
    kind: params.kind,
    workspaceId: params.workspaceId,
    title: params.title,
    createdByWorkspaceMemberId: params.createdByWorkspaceMemberId,
    metadata: params.metadata,
  })
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
  const executeCreate = async (queryable: Executor) => {
    const workspaceMemberIds = [
      ...new Set(
        [
          ...(params.creatorWorkspaceMemberId
            ? [params.creatorWorkspaceMemberId]
            : []),
          ...(params.workspaceMemberIds ?? []),
        ].filter(Boolean)
      ),
    ]
    const actorIds = [...new Set(params.actorIds ?? [])]
    const remoteAgentIds = [...new Set(params.remoteAgentIds ?? [])]

    // Validate EVERY participant before creating the conversation, so a rejected
    // request never leaves an orphan conversation behind (the caller may pass a
    // non-transactional queryable). External participants are NOT created here:
    // they are minted only by the IM ingest path
    // (syncTransportAddressConversationParticipant).
    const memberRows =
      workspaceMemberIds.length > 0
        ? await loadWorkspaceMembersByIds(
            queryable,
            params.workspaceId,
            workspaceMemberIds
          )
        : []
    if (memberRows.length !== workspaceMemberIds.length) {
      throw createChatError(
        400,
        "invalid_workspace_member",
        "One or more workspace members are invalid"
      )
    }
    const actorRows =
      actorIds.length > 0
        ? await loadActorsByIds(queryable, params.workspaceId, actorIds)
        : []
    if (actorRows.length !== actorIds.length) {
      throw createChatError(
        400,
        "invalid_actor",
        "One or more actors are invalid"
      )
    }
    const remoteAgentRows =
      remoteAgentIds.length > 0
        ? await loadRemoteAgentsByIds(
            queryable,
            params.workspaceId,
            remoteAgentIds
          )
        : []
    if (remoteAgentRows.length !== remoteAgentIds.length) {
      throw createChatError(
        400,
        "invalid_remote_agent",
        "One or more remote agents are invalid"
      )
    }

    const conversation = await createConversation({
      kind: params.kind,
      workspaceId: params.workspaceId,
      title: params.title,
      createdByWorkspaceMemberId: params.creatorWorkspaceMemberId,
      metadata: params.metadata,
      queryable,
    })

    for (const member of memberRows) {
      await ensureConversationParticipant({
        conversationId: conversation.id as string,
        participantType: "workspace_member",
        workspaceMemberId: member.id,
        displayName: member.userName,
        roleKey:
          member.id === params.creatorWorkspaceMemberId
            ? CONVERSATION_PARTICIPANT_ROLE_KEY.OWNER
            : CONVERSATION_PARTICIPANT_ROLE_KEY.MEMBER,
        queryable,
      })
      await upsertConversationView(queryable, {
        workspaceMemberId: member.id,
        conversationId: conversation.id as string,
        unreadCount: 0,
      })
    }

    for (const actor of actorRows) {
      await ensureConversationParticipant({
        conversationId: conversation.id as string,
        participantType: "actor",
        actorId: actor.id,
        displayName: actor.displayName ?? undefined,
        queryable,
      })
    }

    for (const remoteAgent of remoteAgentRows) {
      await ensureConversationParticipant({
        conversationId: conversation.id as string,
        participantType: "remote_agent",
        remoteAgentId: remoteAgent.id,
        displayName: remoteAgent.displayName ?? undefined,
        queryable,
      })
    }

    if (workspaceMemberIds.length > 0) {
      await syncConversationUpsertForWorkspaceMembers(
        queryable,
        params.workspaceId,
        workspaceMemberIds,
        conversation.id as string
      )
    }

    return conversation
  }

  if (params.queryable) {
    return executeCreate(params.queryable)
  }
  return withChatTransaction((client) => executeCreate(client))
}

export async function listConversationParticipants(
  conversationId: string,
  options?: { useProfileSnapshot?: boolean; queryable?: Executor }
) {
  return listConversationParticipantRows(
    options?.queryable ?? rootQueryable(),
    [conversationId],
    { useProfileSnapshot: options?.useProfileSnapshot }
  )
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
  if (params.participantId) {
    const exists = await conversationParticipantExists(
      params.queryable ?? rootQueryable(),
      {
        conversationId: params.conversationId,
        participantId: params.participantId,
      }
    )
    if (!exists) {
      return null
    }
  }

  const participants = await listConversationParticipants(
    params.conversationId,
    {
      queryable: params.queryable,
    }
  )
  return (
    participants.find((participant) =>
      params.participantId
        ? participant.id === params.participantId
        : params.actorId
          ? participant.actorId === params.actorId
          : params.remoteAgentId
            ? participant.remoteAgentId === params.remoteAgentId
            : params.workspaceMemberId
              ? participant.workspaceMemberId === params.workspaceMemberId
              : params.transportAddressId
                ? participant.transportAddressId === params.transportAddressId
                : false
    ) ?? null
  )
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
  const queryable = params.queryable ?? rootQueryable()
  const conversation = await getConversation(params.conversationId, queryable)
  if (!conversation) {
    throw new Error("Conversation not found")
  }

  if (
    params.participantType === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
    !params.workspaceMemberId
  ) {
    throw new Error("workspaceMemberId is required for workspace participants")
  }
  if (
    params.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR &&
    !params.actorId
  ) {
    throw new Error("actorId is required for actor participants")
  }
  if (
    params.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT &&
    !params.remoteAgentId
  ) {
    throw new Error("remoteAgentId is required for remote agent participants")
  }

  // F3: resolve the target subject_id up front and dedup by
  // (conversation_id, subject_id) — the canonical identity — instead of by
  // display_name (which let a renamed external participant insert a duplicate
  // and let two different externals with the same name collide).
  const targetSubjectId = await resolveParticipantSubjectId(queryable, {
    participantType: params.participantType,
    workspaceMemberId: params.workspaceMemberId,
    actorId: params.actorId,
    remoteAgentId: params.remoteAgentId,
    transportAddressId: params.transportAddressId,
  })

  const existing = await getConversationParticipantStateBySubject(queryable, {
    conversationId: params.conversationId,
    subjectId: targetSubjectId,
  })

  const existingId = existing?.id
  if (existingId) {
    // P1b: subject_id is fixed at insert time. The existing-participant path
    // only refreshes presentation/state fields; the workspace_member_id /
    // actor_id / remote_agent_id columns no longer exist on this table.
    await reactivateConversationParticipant(queryable, {
      participantId: existingId,
      actorJoinVersionId: params.actorJoinVersionId,
      displayName: params.displayName,
      roleKey: params.roleKey ?? CONVERSATION_PARTICIPANT_ROLE_KEY.MEMBER,
      metadata: params.metadata,
    })

    if (params.transportAddressId) {
      await upsertConversationParticipantAddress(
        queryable,
        existingId,
        params.transportAddressId
      )
    }

    return getConversationParticipant({
      conversationId: params.conversationId,
      participantId: existingId,
      queryable,
    })
  }

  const inserted = await insertParticipant(queryable, {
    conversationId: params.conversationId,
    participantType: params.participantType,
    workspaceMemberId: params.workspaceMemberId,
    actorId: params.actorId,
    remoteAgentId: params.remoteAgentId,
    actorJoinVersionId: params.actorJoinVersionId,
    displayName: params.displayName,
    roleKey: params.roleKey ?? CONVERSATION_PARTICIPANT_ROLE_KEY.MEMBER,
    metadata: params.metadata,
    transportAddressId: params.transportAddressId,
    subjectId: targetSubjectId,
  })

  return getConversationParticipant({
    conversationId: params.conversationId,
    participantId: inserted.id,
    queryable,
  })
}

/**
 * Map each requested workspace_member_id to its CURRENT participant state in the
 * conversation ('active' | 'left' | 'removed'), or undefined if never a
 * participant. Used by addConversationParticipants to distinguish a true re-add
 * (prior 'removed'/'left' → emit membership.updated{active} to clear the client
 * tombstone) from a no-op (already 'active') or a first-time add.
 */
async function loadParticipantStatesByMember(
  queryable: Executor,
  conversationId: string,
  workspaceMemberIds: string[]
): Promise<Map<string, string>> {
  const rows = await listConversationParticipantStatesByWorkspaceMember(
    queryable,
    { conversationId, workspaceMemberIds }
  )
  const map = new Map<string, string>()
  for (const row of rows) {
    map.set(row.workspaceMemberId, row.state)
  }
  return map
}

export async function addConversationParticipants(params: {
  workspaceId: string
  conversationId: string
  workspaceMemberIds?: string[]
  actorIds?: string[]
  remoteAgentIds?: string[]
  queryable?: Executor
}) {
  const executeAdd = async (queryable: Executor) => {
    const workspaceMemberIds = [...new Set(params.workspaceMemberIds ?? [])]
    const actorIds = [...new Set(params.actorIds ?? [])]
    const remoteAgentIds = [...new Set(params.remoteAgentIds ?? [])]
    // External participants are not addable through this public path; they are
    // minted only by the IM ingest path
    // (syncTransportAddressConversationParticipant).

    if (workspaceMemberIds.length > 0) {
      const memberRows = await loadWorkspaceMembersByIds(
        queryable,
        params.workspaceId,
        workspaceMemberIds
      )
      if (memberRows.length !== workspaceMemberIds.length) {
        throw createChatError(
          400,
          "invalid_workspace_member",
          "One or more workspace members are invalid"
        )
      }

      // Capture each requested member's PRIOR participation state (before the
      // ensure reactivates them) so we can distinguish a true re-add (was
      // removed/left) from a no-op (already active) or a brand-new add. A
      // re-add must emit conversation.membership.updated{active} so the client
      // clears its tombstone — a plain conversation.upsert would be rejected by
      // the tombstone guard until then.
      const priorStateByMember = await loadParticipantStatesByMember(
        queryable,
        params.conversationId,
        workspaceMemberIds
      )
      // Pre-existing active members (before this add) — they need a roster
      // refresh too, not just the newly-added members.
      const preExistingRecipients = await listConversationRealtimeRecipients(
        params.conversationId,
        queryable
      )

      for (const member of memberRows) {
        await ensureConversationParticipant({
          conversationId: params.conversationId,
          participantType: "workspace_member",
          workspaceMemberId: member.id,
          displayName: member.userName,
          queryable,
        })
        await upsertConversationView(queryable, {
          workspaceMemberId: member.id,
          conversationId: params.conversationId,
          unreadCount: 0,
        })
      }

      // Refresh the roster for everyone now active (pre-existing ∪ added).
      const upsertTargets = [
        ...new Set([
          ...preExistingRecipients.map((r) => r.workspaceMemberId),
          ...workspaceMemberIds,
        ]),
      ]
      await syncConversationUpsertForWorkspaceMembers(
        queryable,
        params.workspaceId,
        upsertTargets,
        params.conversationId
      )

      // Re-added members (prior state removed/left): clear their tombstone.
      for (const memberId of workspaceMemberIds) {
        const prior = priorStateByMember.get(memberId)
        if (
          prior === CONVERSATION_PARTICIPANT_STATE.REMOVED ||
          prior === CONVERSATION_PARTICIPANT_STATE.LEFT
        ) {
          const activeParticipants = await listConversationParticipants(
            params.conversationId,
            { queryable }
          )
          await appendWorkspaceMemberSyncEvent(queryable, {
            workspaceId: params.workspaceId,
            workspaceMemberId: memberId,
            conversationId: params.conversationId,
            eventType: "conversation.membership.updated",
            payload: {
              conversationId: params.conversationId,
              selfState: CONVERSATION_PARTICIPANT_STATE.ACTIVE,
              reason: CHAT_MEMBERSHIP_UPDATE_REASON.ADDED,
              participants: activeParticipants
                .filter(
                  (p) => p.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE
                )
                .map(participantRowToChatParticipantSummary),
            },
          })
        }
      }
    }

    if (actorIds.length > 0) {
      const actorRows = await loadActorsByIds(
        queryable,
        params.workspaceId,
        actorIds
      )
      if (actorRows.length !== actorIds.length) {
        throw createChatError(
          400,
          "invalid_actor",
          "One or more actors are invalid"
        )
      }
      for (const actor of actorRows) {
        await ensureConversationParticipant({
          conversationId: params.conversationId,
          participantType: "actor",
          actorId: actor.id,
          displayName: actor.displayName ?? undefined,
          queryable,
        })
      }
    }

    if (remoteAgentIds.length > 0) {
      const remoteAgentRows = await loadRemoteAgentsByIds(
        queryable,
        params.workspaceId,
        remoteAgentIds
      )
      if (remoteAgentRows.length !== remoteAgentIds.length) {
        throw createChatError(
          400,
          "invalid_remote_agent",
          "One or more remote agents are invalid"
        )
      }
      for (const remoteAgent of remoteAgentRows) {
        await ensureConversationParticipant({
          conversationId: params.conversationId,
          participantType: "remote_agent",
          remoteAgentId: remoteAgent.id,
          displayName: remoteAgent.displayName ?? undefined,
          queryable,
        })
      }
    }

    // Note: the conversation.upsert roster refresh for member adds is emitted
    // inside the workspaceMemberIds block above (union of pre-existing + added),
    // so it is intentionally NOT repeated here.

    return listConversationParticipants(params.conversationId, { queryable })
  }

  if (params.queryable) {
    return executeAdd(params.queryable)
  }
  return withChatTransaction((client) => executeAdd(client))
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
  const executeInsert = async (queryable: Executor) => {
    const prepared = await prepareConversationItemWrite(queryable, {
      conversationId: params.conversationId,
      scope: params.scope,
      surface: params.surface,
      parts: params.parts,
      restrictedAudienceParticipantIds: params.restrictedAudienceParticipantIds,
      contextTargetParticipantIds: params.contextTargetParticipantIds,
      replyToItemId: params.replyToItemId,
      authorParticipantId: params.authorParticipantId,
    })

    const itemId = crypto.randomUUID()

    const insertResult = await insertConversationItemRecord(queryable, {
      itemId,
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      turnId: params.turnId,
      clientMessageId: params.clientMessageId,
      scope: params.scope,
      surface: params.surface,
      itemType: params.itemType,
      subtype: params.subtype,
      role: params.role,
      authorParticipantId: params.authorParticipantId,
      bundleId: params.bundleId,
      replyToItemId: prepared.replyToItem?.id,
      causedByItemId: params.causedByItemId,
      eventPayload: params.eventPayload,
      eventTimelinePolicy: params.eventTimelinePolicy,
      eventContextPolicy: params.eventContextPolicy,
      metadata: params.metadata,
    })
    const insertedItem = insertResult.item

    if (!insertedItem) {
      throw new Error("Failed to create conversation item")
    }

    const isDuplicate =
      !insertResult.inserted &&
      !!params.clientMessageId &&
      !!params.authorParticipantId
    if (isDuplicate) {
      // S6 dedup observability: a duplicate clientMessageId reaching the
      // server means main thread + SW both flushed the same outbox
      // entry. Counter is exposed via getChatDedupCountersSnapshot().
      recordDuplicateClientMessageIdSend()
      const duplicateItems = await buildChatConversationItems(queryable, [
        insertedItem,
      ])
      return duplicateItems[0]!
    }

    await insertConversationItemDetailRows(queryable, {
      itemId: insertedItem.id,
      parts: prepared.parts,
      mentionedParticipants: prepared.mentionedParticipants,
      restrictedAudienceParticipantIds: params.restrictedAudienceParticipantIds,
      contextTargetParticipantIds: params.contextTargetParticipantIds,
    })

    // Conversation items are appended in child tables; touching the parent
    // conversation preserves "last activity" semantics for list ordering.
    await touchConversationUpdatedAt(queryable, params.conversationId)

    const hydrated = await buildChatConversationItems(queryable, [insertedItem])
    const item = hydrated[0]
    if (!item) {
      throw new Error("Failed to hydrate conversation item")
    }

    if (
      params.scope === CONVERSATION_ITEM_SCOPE.SHARED &&
      params.surface === CONVERSATION_ITEM_SURFACE.VISIBLE
    ) {
      await syncVisibleSharedItem({
        queryable,
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        item,
        activeParticipants: prepared.activeParticipants,
        authorParticipantId: params.authorParticipantId,
        restrictedAudienceParticipantIds:
          params.restrictedAudienceParticipantIds,
      })

      const { createRemoteAgentDeliveriesForItem } =
        await import("../remote-agents/service.js")
      await createRemoteAgentDeliveriesForItem({
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        itemId: item.id,
        authorParticipantId: params.authorParticipantId,
        queryable,
      })
    }

    return item
  }

  if (params.queryable) {
    return executeInsert(params.queryable)
  }
  return withChatTransaction((client) => executeInsert(client))
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
  if (
    !Array.isArray(params.contentBlocks) ||
    params.contentBlocks.length === 0
  ) {
    throw new Error("contentBlocks is required")
  }
  const normalized = await buildNormalizedMessageContent({
    content: "",
    contentBlocks: params.contentBlocks,
    metadata: params.metadata ?? {},
  })

  const item = await createConversationItem({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    sessionId: params.sessionId,
    clientMessageId: params.clientMessageId,
    scope: "shared",
    surface: "visible",
    itemType: "message",
    subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
    role: params.role ?? "user",
    authorParticipantId: params.senderParticipantId,
    replyToItemId: params.replyToItemId,
    metadata: normalized.normalizedMetadata,
    parts: normalized.parts,
    queryable: params.queryable,
  })
  if (params.queryable || !params.workspaceId) {
    return item
  }
  await enqueueActorWakeupsForConversationMessage({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    itemId: item.id,
  })
  const { notifyRemoteAgentDeliveriesForConversation } =
    await import("../remote-agents/service.js")
  await notifyRemoteAgentDeliveriesForConversation(params.conversationId)
  return item
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
  const executeCreate = async (queryable: Executor) => {
    const spec = getConversationEventSpec(params.eventType)
    const timelinePolicy = params.timelinePolicy ?? spec.timelinePolicy
    const contextPolicy = params.contextPolicy ?? spec.contextPolicy
    const eventPayload = params.eventPayload
    const participants = await listConversationParticipantRows(queryable, [
      params.conversationId,
    ])
    const activeParticipants = participants.filter(
      (participant) =>
        participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE
    )

    const timelineTargetParticipantIds =
      timelinePolicy === "targeted_members"
        ? [...new Set(params.restrictedAudienceParticipantIds ?? [])]
        : timelinePolicy === "users_only"
          ? activeParticipants
              .filter((participant) => participant.workspaceMemberId)
              .map((participant) => participant.id)
          : timelinePolicy === "actors_only"
            ? activeParticipants
                .filter((participant) => participant.actorId)
                .map((participant) => participant.id)
            : []

    const contextTargetParticipantIds =
      contextPolicy === "targeted_members"
        ? [...new Set(params.contextTargetParticipantIds ?? [])]
        : contextPolicy === "shared"
          ? activeParticipants
              .filter((participant) => participant.actorId)
              .map((participant) => participant.id)
          : contextPolicy === "actor_private"
            ? [...new Set(params.contextTargetParticipantIds ?? [])]
            : []

    const normalizedTimeline = await buildNormalizedMessageContent({
      content: "",
      contentBlocks: renderConversationEventTimelineBlocks(
        params.eventType,
        eventPayload
      ),
      metadata: params.metadata ?? {},
    })

    const item = await createConversationItem({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      turnId: params.turnId,
      scope: "shared",
      surface: timelinePolicy === "none" ? "internal" : "visible",
      itemType: "event",
      subtype: params.eventType,
      role: "system",
      authorParticipantId: params.authorParticipantId,
      eventPayload,
      eventTimelinePolicy: timelinePolicy,
      eventContextPolicy: contextPolicy,
      metadata: params.metadata ?? {},
      parts: normalizedTimeline.parts,
      restrictedAudienceParticipantIds: timelineTargetParticipantIds,
      contextTargetParticipantIds,
      queryable,
    })

    if (item.itemType !== "event") {
      throw new Error(
        `Expected event item for conversation event ${params.eventType}`
      )
    }

    return {
      item: item as ChatConversationEventItem<T>,
      timelinePolicy,
      contextPolicy,
      timelineTargetParticipantIds,
      contextTargetParticipantIds,
      timelineContent: normalizedTimeline.normalizedContent,
      timelineContentBlocks: normalizedTimeline.contentBlocks,
      metadata: normalizedTimeline.normalizedMetadata,
      eventPayload,
    }
  }

  if (params.queryable) {
    return executeCreate(params.queryable)
  }
  return withChatTransaction((client) => executeCreate(client))
}

export async function updateConversationItemEventPayload<
  T extends ConversationFeedEventType,
>(
  itemId: string,
  payload: ConversationFeedEventPayloadMap[T],
  queryable: Executor = rootQueryable()
) {
  await updateConversationItemEventPayloadRow(queryable, itemId, payload)
}

async function buildConversationItemDetails(
  queryable: Executor,
  itemRows: ItemRow[]
): Promise<ConversationItemDetail[]> {
  if (itemRows.length === 0) {
    return []
  }

  const hydratedItems = await hydrateConversationItems(queryable, itemRows)
  const hydratedById = new Map(hydratedItems.map((item) => [item.id, item]))
  const conversationIds = [
    ...new Set(itemRows.map((row) => row.conversationId)),
  ]
  const participants = await listConversationParticipantRows(
    queryable,
    conversationIds,
    {
      useProfileSnapshot: true,
    }
  )
  const participantById = new Map(
    participants.map((participant) => [participant.id, participant])
  )
  const itemIds = itemRows.map((row) => row.id)
  const contextTargetRows = await listConversationItemContextTargetRows(
    queryable,
    itemIds
  )
  const contextTargetIdsByItem = new Map<string, string[]>()
  for (const row of contextTargetRows) {
    const current = contextTargetIdsByItem.get(row.itemId) ?? []
    current.push(row.targetParticipantId)
    contextTargetIdsByItem.set(row.itemId, current)
  }
  const replyToIds = [
    ...new Set(
      itemRows
        .map((row) => row.replyToItemId)
        .filter((replyToItemId): replyToItemId is string =>
          Boolean(replyToItemId)
        )
    ),
  ]
  const replyRows = await listItemRowsByIds(queryable, replyToIds)
  const replyHydrated = await hydrateConversationItems(queryable, replyRows)
  const replyRowById = new Map(replyRows.map((row) => [row.id, row]))
  const replyHydratedById = new Map(
    replyHydrated.map((item) => [item.id, item])
  )
  const replyRefById = new Map<string, ConversationReplyRef>()
  for (const replyToItemId of replyToIds) {
    const replyRow = replyRowById.get(replyToItemId)
    const replyItem = replyHydratedById.get(replyToItemId)
    if (
      !replyRow ||
      !replyItem ||
      replyRow.scope !== "shared" ||
      replyRow.surface !== "visible"
    ) {
      continue
    }
    const replySubtype = normalizeConversationItemSubtype(
      replyRow.itemType,
      replyRow.subtype,
      replyRow.id
    )
    replyRefById.set(replyToItemId, {
      itemId: replyToItemId,
      ref: buildConversationMessageRef(toNumber(replyRow.sequence)),
      sequence: toNumber(replyRow.sequence),
      itemType: replyItem.itemType,
      subtype: replySubtype,
      author: replyRow.authorParticipantId
        ? participantRowToEntityRef(
            participantById.get(replyRow.authorParticipantId)
          )
        : undefined,
      previewText: replyItem.content.trim(),
      previewBlocks: replyItem.contentBlocks,
      createdAt: presentInstant(replyRow.createdAt),
    })
  }

  return itemRows.map((row) => {
    const hydrated = hydratedById.get(row.id)
    if (!hydrated) {
      throw new Error(`Failed to hydrate conversation item ${row.id}`)
    }
    const restrictedAudienceParticipants =
      hydrated.restrictedAudienceParticipantIds
        .map((participantId) => participantById.get(participantId))
        .filter((participant): participant is ParticipantRow =>
          Boolean(participant)
        )
    const contextTargets = (contextTargetIdsByItem.get(row.id) ?? [])
      .map((participantId) => participantById.get(participantId))
      .filter((participant): participant is ParticipantRow =>
        Boolean(participant)
      )
    const baseItem = {
      id: row.id,
      conversationId: row.conversationId,
      sessionId: row.sessionId ?? undefined,
      turnId: row.turnId ?? undefined,
      sequence: toNumber(row.sequence),
      scope: row.scope,
      surface: row.surface,
      role: row.role,
      authorParticipantId: row.authorParticipantId ?? undefined,
      authorParticipant: row.authorParticipantId
        ? participantById.get(row.authorParticipantId)
        : undefined,
      restrictedAudienceParticipants,
      contextTargets,
      contentBlocks: hydrated.contentBlocks,
      metadata: row.metadata,
      replyToItemId: row.replyToItemId ?? undefined,
      replyTo: row.replyToItemId
        ? (replyRefById.get(row.replyToItemId) ?? {
            itemId: row.replyToItemId,
            itemType: "message",
            subtype: CONVERSATION_REPLY_REF_SPECIAL_SUBTYPE.UNAVAILABLE,
            previewText: "",
            previewBlocks: [],
            isUnavailable: true,
          })
        : undefined,
      causedByItemId: row.causedByItemId ?? undefined,
      createdAt: presentInstant(row.createdAt),
      clientMessageId: row.clientMessageId ?? undefined,
    } satisfies ConversationItemDetailBase

    if (row.itemType === CONVERSATION_ITEM_TYPE.EVENT) {
      if (!isConversationEventType(row.subtype)) {
        throw new Error(
          `Unsupported conversation event subtype ${row.subtype} for item ${row.id}`
        )
      }
      return {
        ...baseItem,
        itemType: CONVERSATION_ITEM_TYPE.EVENT,
        subtype: row.subtype,
        eventPayload: asConversationFeedEventPayload(
          row.subtype,
          row.eventPayload
        ),
        eventTimelinePolicy:
          (row.eventTimelinePolicy as ConversationEventTimelinePolicy | null) ??
          undefined,
        eventContextPolicy:
          (row.eventContextPolicy as ConversationEventContextPolicy | null) ??
          undefined,
      } satisfies ConversationEventItemDetail
    }

    if (row.itemType === CONVERSATION_ITEM_TYPE.SUMMARY) {
      if (row.subtype !== CONVERSATION_FEED_MESSAGE_TYPE.SUMMARY) {
        throw new Error(
          `Unsupported conversation summary subtype ${row.subtype} for item ${row.id}`
        )
      }
      return {
        ...baseItem,
        itemType: CONVERSATION_ITEM_TYPE.SUMMARY,
        subtype: row.subtype,
      } satisfies ConversationNonEventItemDetail
    }

    assertConversationMessageSubtype(row.subtype)
    return {
      ...baseItem,
      itemType: row.itemType,
      subtype: row.subtype,
    } satisfies ConversationNonEventItemDetail
  })
}

function participantRowToEntityRef(
  participant: ParticipantRow | undefined
): ConversationEntityRef | undefined {
  if (!participant) {
    return undefined
  }
  const transportKind = asParticipantTransportKind(participant.transportKind)
  return {
    participantId: participant.id,
    participantType: subjectKindToParticipantType(participant.participantType),
    workspaceMemberId: participant.workspaceMemberId ?? undefined,
    actorId: participant.actorId ?? undefined,
    remoteAgentId: participant.remoteAgentId ?? undefined,
    externalUserKey:
      transportKind && participant.transportExternalId
        ? `${transportKind}:${participant.transportExternalId}`
        : undefined,
    transportAddressId: participant.transportAddressId ?? undefined,
    transportKind,
    name: participantDisplayName(participant),
    title: participant.participantTitle ?? undefined,
    role: participant.participantRole ?? participant.roleKey,
    avatarUrl: participantAvatarUrl(participant),
    avatarEmoji: participantAvatarEmoji(participant),
  }
}

function participantRowToChatParticipantSummary(
  participant: ParticipantRow
): ChatParticipantSummary {
  const entity = participantRowToEntityRef(participant)
  if (!entity) {
    throw new Error(`Failed to map participant ${participant.id}`)
  }
  return {
    participantId: participant.id,
    conversationId: participant.conversationId,
    participantType: subjectKindToParticipantType(participant.participantType),
    workspaceMemberId: entity.workspaceMemberId,
    actorId: entity.actorId,
    remoteAgentId: entity.remoteAgentId,
    externalUserKey: entity.externalUserKey,
    transportAddressId: entity.transportAddressId,
    transportKind: entity.transportKind,
    name: entity.name ?? participantDisplayName(participant),
    title: entity.title,
    role: entity.role,
    avatarUrl: entity.avatarUrl,
    avatarEmoji: entity.avatarEmoji,
    roleKey: participant.roleKey,
    state: participant.state,
    metadata: participant.metadata,
    joinedAt: presentInstant(participant.joinedAt),
    leftAt: presentOptionalInstant(participant.leftAt),
    sessionId: participant.sessionId ?? undefined,
    sessionStatus: participant.sessionStatus ?? undefined,
  } satisfies ChatParticipantSummary
}

function conversationItemDetailToChatItem(
  item: ConversationItemDetail,
  transportDeliveries: ConversationMessageTransportDelivery[] = []
): ChatConversationItem {
  const author = participantRowToEntityRef(item.authorParticipant)
  const restrictedAudience = item.restrictedAudienceParticipants
    .map((participant) => participantRowToEntityRef(participant))
    .filter((participant): participant is ConversationEntityRef =>
      Boolean(participant)
    )
  const baseItem = {
    id: item.id,
    conversationId: item.conversationId,
    sequence: item.sequence,
    sessionId: item.sessionId,
    turnId: item.turnId,
    clientMessageId: item.clientMessageId,
    itemType: item.itemType,
    role: item.role,
    scope: item.scope,
    surface: item.surface,
    authorParticipantId: item.authorParticipantId,
    author,
    replyToItemId: item.replyToItemId,
    replyTo: item.replyTo,
    causedByItemId: item.causedByItemId,
    content: extractText(item.contentBlocks),
    contentBlocks: item.contentBlocks,
    metadata: item.metadata,
    restrictedAudienceParticipantIds:
      item.restrictedAudienceParticipants.length > 0
        ? item.restrictedAudienceParticipants.map(
            (participant) => participant.id
          )
        : undefined,
    restrictedAudience:
      restrictedAudience.length > 0 ? restrictedAudience : undefined,
    createdAt: assertIsoInstant(item.createdAt),
  }

  if (item.itemType === CONVERSATION_ITEM_TYPE.EVENT) {
    return {
      ...baseItem,
      itemType: CONVERSATION_ITEM_TYPE.EVENT,
      subtype: item.subtype,
      eventPayload: item.eventPayload,
      eventTimelinePolicy: item.eventTimelinePolicy,
      eventContextPolicy: item.eventContextPolicy,
    } as ChatConversationEventItem
  }

  if (item.itemType === CONVERSATION_ITEM_TYPE.SUMMARY) {
    return {
      ...baseItem,
      itemType: CONVERSATION_ITEM_TYPE.SUMMARY,
      subtype: item.subtype,
      transport: mapTransportContext(item.metadata),
      transportDeliveries,
    } satisfies ChatConversationItem
  }

  return {
    ...baseItem,
    itemType: item.itemType,
    subtype: item.subtype,
    transport: mapTransportContext(item.metadata),
    transportDeliveries,
  } satisfies ChatConversationItem
}

async function buildChatConversationItems(
  queryable: Executor,
  itemRows: ItemRow[],
  options?: { includeTransportDeliveries?: boolean }
) {
  if (itemRows.length === 0) {
    return [] as ChatConversationItem[]
  }

  const details = await buildConversationItemDetails(queryable, itemRows)
  const deliveriesByItem = options?.includeTransportDeliveries
    ? await loadTransportDeliveriesForItems(
        queryable,
        details.map((item) => item.id)
      )
    : new Map<string, ConversationMessageTransportDelivery[]>()

  return details.map((detail) =>
    conversationItemDetailToChatItem(
      detail,
      deliveriesByItem.get(detail.id) ?? []
    )
  )
}

function conversationEventDetailToFeedItem<T extends ConversationFeedEventType>(
  item: ConversationEventItemDetail<T>,
  author: ConversationEntityRef | undefined,
  restrictedAudience: ConversationEntityRef[]
): ConversationFeedEventItem<T> {
  return {
    kind: "event",
    itemId: item.id,
    conversationId: item.conversationId,
    sequence: item.sequence,
    sessionId: item.sessionId,
    turnId: item.turnId,
    author,
    restrictedAudience:
      restrictedAudience.length > 0 ? restrictedAudience : undefined,
    causedByItemId: item.causedByItemId,
    eventType: item.subtype,
    payload: item.eventPayload,
    createdAt: assertIsoInstant(item.createdAt),
  } as ConversationFeedEventItem<T>
}

function mapTransportContext(
  metadata: Record<string, unknown>
): ConversationMessageTransportContext | undefined {
  const raw = metadata.transport
  if (!raw || typeof raw !== "object") {
    return undefined
  }
  const value = raw as Record<string, unknown>
  const direction =
    value.direction === CONVERSATION_MESSAGE_TRANSPORT_DIRECTION.INBOUND ||
    value.direction === CONVERSATION_MESSAGE_TRANSPORT_DIRECTION.OUTBOUND
      ? value.direction
      : undefined
  const transportKind = isTransportKind(value.transportKind)
    ? value.transportKind
    : undefined
  if (!direction || !transportKind) {
    return undefined
  }
  return {
    direction,
    transportKind,
    transportAccountId:
      typeof value.transportAccountId === "string"
        ? value.transportAccountId
        : undefined,
    endpointType:
      value.endpointType === "direct" || value.endpointType === "group"
        ? value.endpointType
        : undefined,
    endpointExternalId:
      typeof value.endpointExternalId === "string"
        ? value.endpointExternalId
        : undefined,
    externalMessageId:
      typeof value.externalMessageId === "string"
        ? value.externalMessageId
        : undefined,
    transportAddressId:
      typeof value.transportAddressId === "string"
        ? value.transportAddressId
        : undefined,
    senderExternalId:
      typeof value.senderExternalId === "string"
        ? value.senderExternalId
        : undefined,
  }
}

async function loadTransportDeliveriesForItems(
  queryable: Executor,
  itemIds: string[]
) {
  if (itemIds.length === 0) {
    return new Map<string, ConversationMessageTransportDelivery[]>()
  }
  const rows = await listTransportDeliveryRowsForItems(queryable, itemIds)
  const byItem = new Map<string, ConversationMessageTransportDelivery[]>()
  for (const row of rows) {
    const current = byItem.get(row.itemId) ?? []
    current.push({
      linkId: row.linkId,
      transportKind: row.transportKind,
      direction: row.direction,
      deliveryStatus: row.deliveryStatus,
      endpointType: row.endpointType,
      endpointExternalId: row.endpointExternalId ?? undefined,
      endpointDisplayName: row.endpointDisplayName ?? undefined,
      externalMessageId: row.externalMessageId ?? undefined,
      deliveredAt: presentOptionalInstant(row.deliveredAt),
      metadata: row.metadata,
    })
    byItem.set(row.itemId, current)
  }
  return byItem
}

export function conversationItemDetailToFeedItem(
  item: ConversationItemDetail,
  transportDeliveries: ConversationMessageTransportDelivery[] = []
): ConversationFeedItem {
  const author = participantRowToEntityRef(item.authorParticipant)
  const restrictedAudience = item.restrictedAudienceParticipants
    .map((participant) => participantRowToEntityRef(participant))
    .filter((participant): participant is ConversationEntityRef =>
      Boolean(participant)
    )

  if (item.itemType === CONVERSATION_ITEM_TYPE.EVENT) {
    return conversationEventDetailToFeedItem(item, author, restrictedAudience)
  }

  if (item.itemType !== "summary") {
    assertConversationMessageSubtype(item.subtype)
  }

  return {
    kind: "message",
    itemId: item.id,
    conversationId: item.conversationId,
    sequence: item.sequence,
    sessionId: item.sessionId,
    turnId: item.turnId,
    role: item.role === "tool" ? "system" : item.role,
    messageType: item.subtype,
    author,
    replyToItemId: item.replyToItemId,
    replyTo: item.replyTo,
    restrictedAudience:
      restrictedAudience.length > 0 ? restrictedAudience : undefined,
    content: extractText(item.contentBlocks),
    contentBlocks: item.contentBlocks,
    metadata: item.metadata,
    transport: mapTransportContext(item.metadata),
    transportDeliveries,
    createdAt: assertIsoInstant(item.createdAt),
    clientMessageId: item.clientMessageId,
  } satisfies ConversationFeedMessageItem
}

export function isFeedItemVisibleToWorkspaceMember(
  item: ConversationFeedItem,
  workspaceMemberId: string
) {
  if (item.kind === "message") {
    if (item.messageType === CONVERSATION_MESSAGE_SUBTYPE.MODEL_ERROR_NOTICE) {
      if (!item.restrictedAudience || item.restrictedAudience.length === 0) {
        return true
      }
      if (item.author?.workspaceMemberId === workspaceMemberId) {
        return true
      }
      return item.restrictedAudience.some(
        (target) => target.workspaceMemberId === workspaceMemberId
      )
    }
    return true
  }

  if (!item.restrictedAudience || item.restrictedAudience.length === 0) {
    return true
  }
  if (item.author?.workspaceMemberId === workspaceMemberId) {
    return true
  }
  return item.restrictedAudience.some(
    (target) => target.workspaceMemberId === workspaceMemberId
  )
}

export async function getConversationFeedItemById(
  itemId: string,
  queryable: Executor = rootQueryable()
) {
  const row = await getConversationItemRowById(queryable, itemId)
  if (!row) {
    return null
  }
  const [detail] = await buildConversationItemDetails(queryable, [row])
  if (!detail) {
    return null
  }
  const deliveries = await loadTransportDeliveriesForItems(queryable, [
    detail.id,
  ])
  return conversationItemDetailToFeedItem(
    detail,
    deliveries.get(detail.id) ?? []
  )
}

export async function getContextConversationItemsForParticipant(params: {
  conversationId: string
  participantId: string
  beforeSequence?: number
  limit?: number
  queryable?: Executor
}) {
  const queryable = params.queryable ?? rootQueryable()
  const result = await listContextConversationItemRowsForParticipant(
    queryable,
    {
      conversationId: params.conversationId,
      participantId: params.participantId,
      beforeSequence: params.beforeSequence,
      limit: Math.max(1, Math.min(params.limit ?? 200, 500)),
    }
  )
  const rows = [...result].reverse()
  return buildConversationItemDetails(queryable, rows)
}

export async function getLastVisibleConversationItem(
  conversationId: string,
  queryable: Executor = rootQueryable()
) {
  const row = await getLastVisibleConversationItemRow(queryable, conversationId)
  if (!row) {
    return null
  }
  const [detail] = await buildConversationItemDetails(queryable, [row])
  return detail ?? null
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
  const rows = await listConversationRealtimeRecipientRows(
    queryable,
    conversationId
  )

  return rows.map((row) => ({
    workspaceId: row.workspaceId,
    workspaceMemberId: row.workspaceMemberId,
  }))
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
  const workspaceMemberIds = [
    ...new Set([
      creator.workspaceMemberId,
      ...(params.workspaceMemberIds ?? []),
    ]),
  ]
  const actorIds = [...new Set(params.actorIds ?? [])]
  const remoteAgentIds = [...new Set(params.remoteAgentIds ?? [])]
  // External participants are not creatable through this public path; they are
  // minted only by the IM ingest path (syncTransportAddressConversationParticipant).

  const conversationId = await withChatTransaction(async (client) => {
    const existingConversationId =
      await getChatConversationCreateRequestConversationId(client, {
        workspaceMemberId: creator.workspaceMemberId,
        clientRequestId: params.clientRequestId,
      })
    if (existingConversationId) {
      return existingConversationId
    }

    const memberRows = await loadWorkspaceMembersByIds(
      client,
      params.workspaceId,
      workspaceMemberIds
    )
    if (memberRows.length !== workspaceMemberIds.length) {
      throw createChatError(
        400,
        "invalid_workspace_member",
        "One or more workspace members are invalid"
      )
    }

    const actorRows = await loadActorsByIds(
      client,
      params.workspaceId,
      actorIds
    )
    if (actorRows.length !== actorIds.length) {
      throw createChatError(
        400,
        "invalid_actor",
        "One or more actors are invalid"
      )
    }

    const remoteAgentRows = await loadRemoteAgentsByIds(
      client,
      params.workspaceId,
      remoteAgentIds
    )
    if (remoteAgentRows.length !== remoteAgentIds.length) {
      throw createChatError(
        400,
        "invalid_remote_agent",
        "One or more remote agents are invalid"
      )
    }

    const newConversationId = crypto.randomUUID()
    await insertConversationRecord(client, {
      conversationId: newConversationId,
      kind: params.kind,
      workspaceId: params.workspaceId,
      title: params.title,
      createdByWorkspaceMemberId: creator.workspaceMemberId,
      metadata: params.metadata,
    })

    for (const member of memberRows) {
      await insertParticipant(client, {
        conversationId: newConversationId,
        participantType: "workspace_member",
        workspaceMemberId: member.id,
        displayName: member.userName,
        roleKey:
          member.id === creator.workspaceMemberId
            ? CONVERSATION_PARTICIPANT_ROLE_KEY.OWNER
            : CONVERSATION_PARTICIPANT_ROLE_KEY.MEMBER,
        metadata: {},
      })
      await upsertConversationView(client, {
        workspaceMemberId: member.id,
        conversationId: newConversationId,
        unreadCount: 0,
      })
    }

    for (const actor of actorRows) {
      await insertParticipant(client, {
        conversationId: newConversationId,
        participantType: "actor",
        actorId: actor.id,
        displayName: actor.displayName ?? undefined,
        roleKey: CONVERSATION_PARTICIPANT_ROLE_KEY.MEMBER,
        metadata: {},
      })
    }

    for (const remoteAgent of remoteAgentRows) {
      await insertParticipant(client, {
        conversationId: newConversationId,
        participantType: "remote_agent",
        remoteAgentId: remoteAgent.id,
        displayName: remoteAgent.displayName ?? undefined,
        roleKey: CONVERSATION_PARTICIPANT_ROLE_KEY.MEMBER,
        metadata: {},
      })
    }

    await insertChatConversationCreateRequest(client, {
      workspaceMemberId: creator.workspaceMemberId,
      clientRequestId: params.clientRequestId,
      workspaceId: params.workspaceId,
      conversationId: newConversationId,
    })

    await syncConversationUpsertForWorkspaceMembers(
      client,
      params.workspaceId,
      memberRows.map((row) => row.id),
      newConversationId
    )

    return newConversationId
  })

  const conversation = await loadConversationView(
    rootQueryable(),
    params.workspaceId,
    creator.workspaceMemberId,
    conversationId
  )

  if (!conversation) {
    throw createChatError(
      500,
      "conversation_load_failed",
      "Failed to load created conversation"
    )
  }

  return {
    conversation,
  }
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

export async function requireRemoteAgentConversationAccess(
  queryable: Executor,
  conversationId: string,
  remoteAgentId: string
) {
  const participant = await getConversationParticipant({
    conversationId,
    remoteAgentId,
    queryable,
  })
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

export async function listVisibleConversationItemsForParticipant(params: {
  conversationId: string
  participantId: string
  afterSequence?: number
  beforeSequence?: number
  limit?: number
  queryable?: Executor
}) {
  const queryable = params.queryable ?? rootQueryable()
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 200)
  let rows: ItemRow[] = []

  if (typeof params.afterSequence === "number") {
    rows = await listVisibleConversationMessageRows(queryable, {
      conversationId: params.conversationId,
      participantId: params.participantId,
      afterSequence: params.afterSequence,
      limit,
    })
  } else if (typeof params.beforeSequence === "number") {
    rows = (
      await listVisibleConversationMessageRows(queryable, {
        conversationId: params.conversationId,
        participantId: params.participantId,
        beforeSequence: params.beforeSequence,
        limit,
      })
    ).reverse()
  } else {
    rows = (
      await listVisibleConversationMessageRows(queryable, {
        conversationId: params.conversationId,
        participantId: params.participantId,
        limit,
      })
    ).reverse()
  }

  return buildChatConversationItems(queryable, rows, {
    includeTransportDeliveries: true,
  })
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
  params: SendMessageInput
): Promise<ChatConversationSendMessageRecord> {
  const contentBlocks = params.contentBlocks
  if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) {
    throw createChatError(
      400,
      "invalid_content_blocks",
      "contentBlocks is required"
    )
  }

  const item = await withChatTransaction(async (client) => {
    const access = await requireConversationAccess(
      client,
      params.conversationId,
      params.workspaceMemberId
    )

    await ensureClientInstance(client, {
      workspaceId: params.workspaceId,
      workspaceMemberId: params.workspaceMemberId,
      clientInstanceId: params.clientInstanceId,
    })

    return sendConversationMessageFromParticipant({
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

  await enqueueActorWakeupsForConversationMessage({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    itemId: item.id,
  })
  const { notifyRemoteAgentDeliveriesForConversation } =
    await import("../remote-agents/service.js")
  await notifyRemoteAgentDeliveriesForConversation(params.conversationId)

  return {
    item,
  }
}

export async function updateChatConversationReadWatermark(
  params: ReadWatermarkInput
): Promise<ChatConversationReadWatermarkRecord> {
  return withChatTransaction(async (client) => {
    const access = await requireConversationAccess(
      client,
      params.conversationId,
      params.workspaceMemberId
    )

    await ensureClientInstance(client, {
      workspaceId: params.workspaceId,
      workspaceMemberId: params.workspaceMemberId,
      clientInstanceId: params.clientInstanceId,
    })

    const maxSequence = await getConversationSequenceMax(
      client,
      params.conversationId
    )
    const requestedSequence = Math.min(
      Math.max(params.readUpToSequence, 0),
      maxSequence
    )

    const existingRow = await getConversationParticipantReadState(client, {
      conversationId: params.conversationId,
      participantId: access.participant.id,
    })
    const existingSequence = toNumber(existingRow?.readWatermarkSequence)
    const nextSequence = Math.max(existingSequence, requestedSequence)
    // S6 dedup observability: if the request didn't actually advance the
    // watermark, it's a duplicate POST — the main thread and the SW
    // both flushed the same pending-read. Count it so we can monitor
    // whether the mutex (isChatServiceWorkerActive guard, S23) is
    // holding.
    //
    // S37: require an EXISTING USER-INITIATED watermark before counting.
    // Adding a participant pre-inserts a row with sequence=0 and
    // last_read_at=NULL (see ensureConversationParticipant). The user's
    // first POST with readUpTo=0 collides with that pre-initialized row
    // but isn't actually a duplicate — it's the inaugural mark. Use
    // last_read_at as the "user has marked something before" signal.
    const userHasMarkedBefore =
      Boolean(existingRow) && existingRow!.lastReadAt !== null
    if (userHasMarkedBefore && nextSequence === existingSequence) {
      recordDuplicateWatermarkPost()
    }
    const lastReadItemId = await getLastItemAtOrBeforeSequence(
      client,
      params.conversationId,
      nextSequence
    )

    await upsertConversationParticipantReadState(client, {
      conversationId: params.conversationId,
      participantId: access.participant.id,
      readWatermarkSequence: nextSequence,
      lastReadItemId: lastReadItemId,
    })

    if (params.clientInstanceId) {
      const lastVisibleSequence = Math.min(
        maxSequence,
        Math.max(params.lastVisibleSequence ?? nextSequence, nextSequence)
      )
      await upsertConversationDeviceState(client, {
        conversationId: params.conversationId,
        clientInstanceId: params.clientInstanceId,
        lastVisibleSequence: lastVisibleSequence,
      })
    }

    const unreadCount = await countUnreadVisibleMessages(
      client,
      params.conversationId,
      access.participant.id
    )

    await upsertConversationView(client, {
      workspaceMemberId: params.workspaceMemberId,
      conversationId: params.conversationId,
      unreadCount,
    })

    const lastReadAt = serializeNowInstant()
    await appendWorkspaceMemberSyncEvent(client, {
      workspaceId: params.workspaceId,
      workspaceMemberId: params.workspaceMemberId,
      conversationId: params.conversationId,
      eventType: "conversation.read.updated",
      payload: {
        conversationId: params.conversationId,
        workspaceMemberId: params.workspaceMemberId,
        participantId: access.participant.id,
        readWatermarkSequence: nextSequence,
        lastReadAt,
      },
    })

    await syncConversationUpsertForWorkspaceMembers(
      client,
      params.workspaceId,
      [params.workspaceMemberId],
      params.conversationId
    )

    return {
      conversationId: params.conversationId,
      workspaceMemberId: params.workspaceMemberId,
      participantId: access.participant.id,
      readWatermarkSequence: nextSequence,
      lastReadAt,
    }
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
  if (params.title === undefined && params.metadata === undefined) {
    throw createChatError(
      400,
      "invalid_patch",
      "At least one of title or metadata must be provided"
    )
  }
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  return withChatTransaction(async (client) => {
    await requireConversationManagement(
      client,
      params.conversationId,
      identity.workspaceMemberId
    )

    const updated = await updateConversationMutableFields(client, {
      conversationId: params.conversationId,
      title: params.title,
      metadata: params.metadata,
    })
    if (!updated) {
      return
    }

    const recipients = await listConversationRealtimeRecipients(
      params.conversationId,
      client
    )
    await syncConversationUpsertForWorkspaceMembers(
      client,
      params.workspaceId,
      recipients.map((r) => r.workspaceMemberId),
      params.conversationId
    )

    const conversation = await loadConversationView(
      client,
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
  })
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
  return withChatTransaction(async (client) => {
    await requireConversationManagement(
      client,
      params.conversationId,
      identity.workspaceMemberId
    )

    await addConversationParticipants({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      workspaceMemberIds: params.workspaceMemberIds,
      actorIds: params.actorIds,
      remoteAgentIds: params.remoteAgentIds,
      queryable: client,
    })

    const recipients = await listConversationRealtimeRecipients(
      params.conversationId,
      client
    )
    await syncConversationUpsertForWorkspaceMembers(
      client,
      params.workspaceId,
      recipients.map((r) => r.workspaceMemberId),
      params.conversationId
    )

    const conversation = await loadConversationView(
      client,
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
  })
}

async function setParticipantState(
  queryable: Executor,
  participantId: string,
  state: ChatParticipantRemovalState
) {
  await updateConversationParticipantState(queryable, participantId, state)
}

// Exported for unit-test coverage; see remove-participant.test.ts. After the
// P1b polymorphic-FK collapse, conversation_participants no longer carries
// workspace_member_id / actor_id / remote_agent_id directly — those projections
// come from access_subjects via cp.subject_id. A regression here would only
// surface at runtime when DELETE /chat/conversations/:cid/participants/:pid
// is hit; a focused test on the SQL keeps it honest.
export async function loadParticipantById(
  queryable: Executor,
  conversationId: string,
  participantId: string
) {
  return getConversationParticipantById(queryable, {
    conversationId,
    participantId,
  })
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
  return withChatTransaction(async (client) => {
    const access = await requireConversationAccess(
      client,
      params.conversationId,
      identity.workspaceMemberId
    )

    const target = await loadParticipantById(
      client,
      params.conversationId,
      params.participantId
    )
    if (!target) {
      throw createChatError(
        404,
        "participant_not_found",
        "Participant not found in this conversation"
      )
    }
    if (target.state !== CONVERSATION_PARTICIPANT_STATE.ACTIVE) {
      throw createChatError(
        409,
        "participant_not_active",
        "Participant is already left or removed"
      )
    }

    const isSelfRemoval = target.id === access.participant.id
    // Kicking someone else requires conversation management rights;
    // removing yourself ("leave") only requires being a participant.
    if (!isSelfRemoval) {
      await requireConversationManagement(
        client,
        params.conversationId,
        identity.workspaceMemberId
      )
    }
    const eventType = isSelfRemoval ? "participant_left" : "participant_kicked"

    const removalState = isSelfRemoval
      ? CHAT_PARTICIPANT_REMOVAL_STATE.LEFT
      : CHAT_PARTICIPANT_REMOVAL_STATE.REMOVED

    await setParticipantState(client, target.id, removalState)

    await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType,
      authorParticipantId: access.participant.id,
      eventPayload: {
        batchId: crypto.randomUUID(),
        initiator: isSelfRemoval
          ? undefined
          : {
              participantId: access.participant.id,
              participantType: access.participant
                .participantType as ParticipantKind,
              workspaceMemberId: identity.workspaceMemberId,
            },
        participants: [
          {
            participantId: target.id,
            participantType: target.participantType as Exclude<
              ParticipantKind,
              "system"
            >,
            workspaceMemberId: target.workspaceMemberId ?? undefined,
            actorId: target.actorId ?? undefined,
            remoteAgentId: target.remoteAgentId ?? undefined,
            name: target.displayName ?? undefined,
          },
        ],
      } as never,
      queryable: client,
    })

    const recipients = await listConversationRealtimeRecipients(
      params.conversationId,
      client
    )
    // Remaining active members get a conversation.upsert (roster now reflects
    // the removal). The removed member is intentionally NOT in this list — a
    // conversation.upsert would (a) be skipped by syncConversationUpsert because
    // loadConversationView now excludes them via the active filter, and (b)
    // wrongly imply the conversation is still theirs. They get an explicit
    // membership.updated below instead.
    await syncConversationUpsertForWorkspaceMembers(
      client,
      params.workspaceId,
      recipients.map((r) => r.workspaceMemberId),
      params.conversationId
    )

    // Tell the removed member (every one of their devices) they are out. This
    // is the authoritative "you were removed/left" signal — it does NOT depend
    // on loadConversationView (which now returns null for them), so it is
    // emitted directly. Self-leave still notifies the leaver so their OTHER
    // devices drop the conversation. participants snapshot reflects the
    // post-removal active roster.
    if (target.workspaceMemberId) {
      const activeParticipants = await listConversationParticipants(
        params.conversationId,
        { queryable: client }
      )
      await appendWorkspaceMemberSyncEventInTransaction(client, {
        workspaceId: params.workspaceId,
        workspaceMemberId: target.workspaceMemberId,
        conversationId: params.conversationId,
        eventType: "conversation.membership.updated",
        payload: {
          conversationId: params.conversationId,
          selfState: removalState,
          reason: isSelfRemoval
            ? CHAT_MEMBERSHIP_UPDATE_REASON.LEFT
            : CHAT_MEMBERSHIP_UPDATE_REASON.KICKED,
          participants: activeParticipants
            .filter((p) => p.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE)
            .map(participantRowToChatParticipantSummary),
        },
      })
    }

    return {
      conversationId: params.conversationId,
      participantId: target.id,
      state: removalState,
    }
  })
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
  const access = await requireConversationAccess(
    rootQueryable(),
    params.conversationId,
    identity.workspaceMemberId
  )
  return removeChatConversationParticipant({
    workspaceId: params.workspaceId,
    userId: params.userId,
    conversationId: params.conversationId,
    participantId: access.participant.id,
  })
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
  const access = await requireConversationAccess(
    rootQueryable(),
    params.conversationId,
    identity.workspaceMemberId
  )

  const item = await getConversationFeedItemById(params.itemId)
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

  const metadata = (item.metadata ?? {}) as Record<string, unknown>
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

  // S19: the wakeup "source" is the caller (the user clicking retry),
  // NOT the original assistant author. The downstream model-error notice
  // path in session-thinking.ts:922 expects sourceParticipantType="workspace_member"
  // to come with sourceParticipantId = workspace_members.id (NOT a
  // conversation_participants.id) so it can re-query the participant
  // via getConversationParticipant({workspaceMemberId}).
  const { enqueueSessionWakeup } = await import("../session/runtime.js")
  await enqueueSessionWakeup({
    sessionId: retrySessionId,
    actorId,
    workspaceId: params.workspaceId,
    sourceType: "user_message",
    sourceItemId: params.itemId,
    sourceParticipantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
    sourceParticipantId: identity.workspaceMemberId,
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
