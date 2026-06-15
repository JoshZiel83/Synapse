import { randomUUID } from "node:crypto"
import {
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SCOPES,
  CONVERSATION_ITEM_ROLE,
  CONVERSATION_ITEM_ROLES,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_SURFACES,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_ITEM_TYPES,
  CONVERSATION_MESSAGE_SUBTYPE,
  type CanonicalContentBlock,
  type ChatConversationItem,
} from "@synapse/shared"
import type {
  ConversationEventContextPolicy,
  ConversationEventTimelinePolicy,
} from "@synapse/shared/types"
import type { Executor } from "../../infrastructure/database/kysely.js"
import { buildNormalizedMessageContent } from "./message-content.js"
import { recordDuplicateClientMessageIdSend } from "./observability.js"
import {
  insertConversationItemDetailRows,
  insertConversationItemRecord,
  touchConversationUpdatedAt,
  withChatTransaction,
  type ChatConversationItemRow,
  type ChatParticipantRow,
} from "./repo.js"

type ItemScope = (typeof CONVERSATION_ITEM_SCOPES)[number]
type ItemSurface = (typeof CONVERSATION_ITEM_SURFACES)[number]
type ItemType = (typeof CONVERSATION_ITEM_TYPES)[number]
type ItemRole = (typeof CONVERSATION_ITEM_ROLES)[number]

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

export type MentionedParticipantRef = {
  participantId: string
  ordinal: number
}

export type PreparedConversationItemWrite = {
  activeParticipants: ChatParticipantRow[]
  parts: ConversationItemPartInput[]
  mentionedParticipants: MentionedParticipantRef[]
  replyToItem: ChatConversationItemRow | null
}

export type CreateConversationItemInput = {
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
}

export type SendConversationMessageInput = {
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
}

type PrepareConversationItemWrite = (
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
) => Promise<PreparedConversationItemWrite>

type BuildChatConversationItems = (
  queryable: Executor,
  itemRows: ChatConversationItemRow[]
) => Promise<ChatConversationItem[]>

type SyncVisibleSharedItem = (params: {
  queryable: Executor
  workspaceId?: string
  conversationId: string
  item: ChatConversationItem
  activeParticipants: ChatParticipantRow[]
  authorParticipantId?: string
  restrictedAudienceParticipantIds?: string[]
}) => Promise<void>

type CreateRemoteAgentDeliveriesForItem = (params: {
  workspaceId?: string
  conversationId: string
  itemId: string
  authorParticipantId?: string
  queryable?: Executor
}) => Promise<void>

export type CreateConversationItemDeps = {
  prepareConversationItemWrite: PrepareConversationItemWrite
  buildChatConversationItems: BuildChatConversationItems
  syncVisibleSharedItem: SyncVisibleSharedItem
  createRemoteAgentDeliveriesForItem: CreateRemoteAgentDeliveriesForItem
}

export type SendConversationMessageDeps = {
  createConversationItem: (
    params: CreateConversationItemInput
  ) => Promise<ChatConversationItem>
  enqueueActorWakeupsForConversationMessage: (params: {
    workspaceId?: string
    conversationId: string
    itemId: string
    queryable?: Executor
  }) => Promise<unknown>
  notifyRemoteAgentDeliveriesForConversation: (
    conversationId: string
  ) => Promise<void>
}

export async function createConversationItemUseCase(
  params: CreateConversationItemInput,
  deps: CreateConversationItemDeps
) {
  const executeInsert = async (queryable: Executor) => {
    const prepared = await deps.prepareConversationItemWrite(queryable, {
      conversationId: params.conversationId,
      scope: params.scope,
      surface: params.surface,
      parts: params.parts,
      restrictedAudienceParticipantIds: params.restrictedAudienceParticipantIds,
      contextTargetParticipantIds: params.contextTargetParticipantIds,
      replyToItemId: params.replyToItemId,
      authorParticipantId: params.authorParticipantId,
    })

    const itemId = randomUUID()

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
      recordDuplicateClientMessageIdSend()
      const duplicateItems = await deps.buildChatConversationItems(queryable, [
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

    const hydrated = await deps.buildChatConversationItems(queryable, [
      insertedItem,
    ])
    const item = hydrated[0]
    if (!item) {
      throw new Error("Failed to hydrate conversation item")
    }

    if (
      params.scope === CONVERSATION_ITEM_SCOPE.SHARED &&
      params.surface === CONVERSATION_ITEM_SURFACE.VISIBLE
    ) {
      await deps.syncVisibleSharedItem({
        queryable,
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        item,
        activeParticipants: prepared.activeParticipants,
        authorParticipantId: params.authorParticipantId,
        restrictedAudienceParticipantIds:
          params.restrictedAudienceParticipantIds,
      })

      await deps.createRemoteAgentDeliveriesForItem({
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

export async function sendConversationMessageFromParticipantUseCase(
  params: SendConversationMessageInput,
  deps: SendConversationMessageDeps
) {
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

  const item = await deps.createConversationItem({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    sessionId: params.sessionId,
    clientMessageId: params.clientMessageId,
    scope: CONVERSATION_ITEM_SCOPE.SHARED,
    surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
    itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
    subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
    role: params.role ?? CONVERSATION_ITEM_ROLE.USER,
    authorParticipantId: params.senderParticipantId,
    replyToItemId: params.replyToItemId,
    metadata: normalized.normalizedMetadata,
    parts: normalized.parts,
    queryable: params.queryable,
  })
  if (params.queryable || !params.workspaceId) {
    return item
  }
  await deps.enqueueActorWakeupsForConversationMessage({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    itemId: item.id,
  })
  await deps.notifyRemoteAgentDeliveriesForConversation(params.conversationId)
  return item
}
