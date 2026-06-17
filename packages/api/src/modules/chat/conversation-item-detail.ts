import {
  CONVERSATION_FEED_MESSAGE_TYPE,
  CONVERSATION_ITEM_ROLES,
  CONVERSATION_ITEM_SCOPES,
  CONVERSATION_ITEM_SURFACES,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_ITEM_TYPES,
  CONVERSATION_MESSAGE_SUBTYPES,
  type CanonicalContentBlock,
  type ConversationMessageSubtype,
  type ConversationReplyRef,
  type Timestamp,
} from "@synapse/shared"
import type {
  ConversationEventContextPolicy,
  ConversationEventTimelinePolicy,
  ConversationFeedEventPayloadMap,
  ConversationFeedEventType,
  ConversationFeedItemSubtype,
} from "@synapse/shared/types"
import type { ChatParticipantRow } from "./repo.js"
import { isConversationEventType } from "./event-registry.js"

type ItemScope = (typeof CONVERSATION_ITEM_SCOPES)[number]
type ItemSurface = (typeof CONVERSATION_ITEM_SURFACES)[number]
type ItemType = (typeof CONVERSATION_ITEM_TYPES)[number]
type ItemRole = (typeof CONVERSATION_ITEM_ROLES)[number]
type NonEventItemType = Exclude<ItemType, "event">
type MessageLikeItemType = Exclude<NonEventItemType, "summary">

export interface ConversationItemDetailBase {
  id: string
  conversationId: string
  sessionId?: string
  turnId?: string
  sequence: number
  scope: ItemScope
  surface: ItemSurface
  role: ItemRole
  authorParticipantId?: string
  authorParticipant?: ChatParticipantRow
  restrictedAudienceParticipants: ChatParticipantRow[]
  contextTargets: ChatParticipantRow[]
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

const CONVERSATION_MESSAGE_SUBTYPE_SET = new Set<ConversationMessageSubtype>(
  CONVERSATION_MESSAGE_SUBTYPES
)

export function isConversationMessageSubtype(
  value: string
): value is ConversationMessageSubtype {
  return CONVERSATION_MESSAGE_SUBTYPE_SET.has(
    value as ConversationMessageSubtype
  )
}

export function assertConversationMessageSubtype(
  value: string
): asserts value is ConversationMessageSubtype {
  if (!isConversationMessageSubtype(value)) {
    throw new Error(`Unsupported conversation message subtype: ${value}`)
  }
}

export function normalizeConversationItemSubtype(
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
