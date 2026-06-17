import { CONVERSATION_ITEM_TYPE, extractText } from "@synapse/shared"
import { assertIsoInstant } from "@synapse/shared/datetime"
import type {
  ConversationEntityRef,
  ConversationFeedEventItem,
  ConversationFeedEventType,
  ConversationFeedItem,
  ConversationFeedMessageItem,
  ConversationMessageTransportDelivery,
} from "@synapse/shared/types"
import {
  assertConversationMessageSubtype,
  type ConversationEventItemDetail,
  type ConversationItemDetail,
} from "./conversation-item-detail.js"
import { mapConversationTransportContext } from "./conversation-transport.js"
import { participantRowToEntityRef } from "./participant-projection.js"

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
    transport: mapConversationTransportContext(item.metadata),
    transportDeliveries,
    createdAt: assertIsoInstant(item.createdAt),
    clientMessageId: item.clientMessageId,
  } satisfies ConversationFeedMessageItem
}
