import {
  CONVERSATION_ITEM_TYPE,
  extractText,
  type ChatConversationEventItem,
  type ChatConversationItem,
} from "@synapse/shared"
import { assertIsoInstant } from "@synapse/shared/datetime"
import type {
  ConversationEntityRef,
  ConversationMessageTransportDelivery,
} from "@synapse/shared/types"
import type { Executor } from "../../infrastructure/database/kysely.js"
import {
  chatRootExecutor,
  getConversationItemRowById,
  getLastVisibleConversationItemRow,
  listChatConversationParticipantRows,
  listContextConversationItemRowsForParticipant,
  listConversationItemContextTargetRows,
  listConversationItemPartRows,
  listConversationItemRowsByIds,
  listConversationItemTargetRows,
  listTransportDeliveryRowsForItems,
  listVisibleConversationMessageRows,
  type ChatConversationItemRow,
} from "./repo.js"
import { hydrateConversationItemsUseCase } from "./conversation-item-hydration.js"
import { buildConversationItemDetail } from "./conversation-item-detail-builder.js"
import { buildConversationReplyRefs } from "./conversation-reply-ref.js"
import { participantRowToEntityRef } from "./participant-projection.js"
import {
  loadConversationTransportDeliveriesUseCase,
  mapConversationTransportContext,
} from "./conversation-transport.js"
import { conversationItemDetailToFeedItem } from "./conversation-feed-mapper.js"
import type { ConversationItemDetail } from "./conversation-item-detail.js"

type ItemRow = ChatConversationItemRow

function rootQueryable(): Executor {
  return chatRootExecutor()
}

function chatConversationItemHydrationDeps() {
  return {
    listConversationItemParts: listConversationItemPartRows,
    listConversationItemTargets: listConversationItemTargetRows,
  }
}

function chatConversationTransportDeps() {
  return {
    listTransportDeliveryRowsForItems,
  }
}

export async function hydrateConversationItems(
  queryable: Executor,
  itemRows: ItemRow[]
) {
  return hydrateConversationItemsUseCase(
    queryable,
    itemRows,
    chatConversationItemHydrationDeps()
  )
}

async function listItemRowsByIds(queryable: Executor, itemIds: string[]) {
  return listConversationItemRowsByIds(queryable, itemIds)
}

export async function buildConversationItemDetails(
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
  const participants = await listChatConversationParticipantRows(
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
  const replyRefById = buildConversationReplyRefs({
    replyToIds,
    replyRows,
    replyHydratedItems: replyHydrated,
    participantById,
  })

  return itemRows.map((row) => {
    const hydrated = hydratedById.get(row.id)
    if (!hydrated) {
      throw new Error(`Failed to hydrate conversation item ${row.id}`)
    }
    return buildConversationItemDetail({
      row,
      hydrated,
      participantById,
      contextTargetIdsByItem,
      replyRefById,
    })
  })
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
      transport: mapConversationTransportContext(item.metadata),
      transportDeliveries,
    } satisfies ChatConversationItem
  }

  return {
    ...baseItem,
    itemType: item.itemType,
    subtype: item.subtype,
    transport: mapConversationTransportContext(item.metadata),
    transportDeliveries,
  } satisfies ChatConversationItem
}

async function loadTransportDeliveriesForItems(
  queryable: Executor,
  itemIds: string[]
) {
  return loadConversationTransportDeliveriesUseCase(
    queryable,
    itemIds,
    chatConversationTransportDeps()
  )
}

export async function buildChatConversationItems(
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
