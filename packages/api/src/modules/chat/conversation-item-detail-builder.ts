import {
  CONVERSATION_FEED_MESSAGE_TYPE,
  CONVERSATION_ITEM_TYPE,
  type ConversationReplyRef,
} from "@synapse/shared"
import type {
  ConversationEventContextPolicy,
  ConversationEventTimelinePolicy,
  ConversationFeedEventPayloadMap,
  ConversationFeedEventType,
} from "@synapse/shared/types"
import type { HydratedConversationItemRecord } from "./conversation-item-hydration.js"
import {
  assertConversationMessageSubtype,
  type ConversationEventItemDetail,
  type ConversationItemDetail,
  type ConversationItemDetailBase,
  type ConversationNonEventItemDetail,
} from "./conversation-item-detail.js"
import { isConversationEventType } from "./event-registry.js"
import { presentInstant } from "./presenter.js"
import type { ChatConversationItemRow, ChatParticipantRow } from "./repo.js"
import { unavailableConversationReplyRef } from "./conversation-reply-ref.js"

export type BuildConversationItemDetailInput = {
  row: ChatConversationItemRow
  hydrated: HydratedConversationItemRecord
  participantById: Map<string, ChatParticipantRow>
  contextTargetIdsByItem: Map<string, string[]>
  replyRefById: Map<string, ConversationReplyRef>
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

function asConversationFeedEventPayload<T extends ConversationFeedEventType>(
  eventType: T,
  payload: Record<string, unknown>
): ConversationFeedEventPayloadMap[T] {
  return payload as unknown as ConversationFeedEventPayloadMap[T]
}

function existingParticipants(
  participantIds: string[],
  participantById: Map<string, ChatParticipantRow>
): ChatParticipantRow[] {
  return participantIds
    .map((participantId) => participantById.get(participantId))
    .filter((participant): participant is ChatParticipantRow =>
      Boolean(participant)
    )
}

export function buildConversationItemDetail({
  row,
  hydrated,
  participantById,
  contextTargetIdsByItem,
  replyRefById,
}: BuildConversationItemDetailInput): ConversationItemDetail {
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
    restrictedAudienceParticipants: existingParticipants(
      hydrated.restrictedAudienceParticipantIds,
      participantById
    ),
    contextTargets: existingParticipants(
      contextTargetIdsByItem.get(row.id) ?? [],
      participantById
    ),
    contentBlocks: hydrated.contentBlocks,
    metadata: row.metadata,
    replyToItemId: row.replyToItemId ?? undefined,
    replyTo: row.replyToItemId
      ? (replyRefById.get(row.replyToItemId) ??
        unavailableConversationReplyRef(row.replyToItemId))
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
}
