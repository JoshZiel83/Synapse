import {
  CONVERSATION_ITEM_ROLE,
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_PARTICIPANT_STATE,
  type CanonicalContentBlock,
  type ChatConversationEventItem,
  type ChatConversationItem,
} from "@synapse/shared"
import type {
  ConversationEventContextPolicy,
  ConversationEventTimelinePolicy,
  ConversationFeedEventPayloadMap,
  ConversationFeedEventType,
} from "@synapse/shared/types"
import type { Executor } from "../../infrastructure/database/kysely.js"
import {
  getConversationEventSpec,
  renderConversationEventTimelineBlocks,
} from "./event-registry.js"
import { buildNormalizedMessageContent } from "./message-content.js"
import {
  chatRootExecutor,
  updateConversationItemEventPayload as updateConversationItemEventPayloadRow,
  withChatTransaction,
  type ChatParticipantRow,
} from "./repo.js"
import type { CreateConversationItemInput } from "./item-write.js"

export type CreateConversationEventInput<T extends ConversationFeedEventType> =
  {
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
  }

export type CreateConversationEventResult<T extends ConversationFeedEventType> =
  {
    item: ChatConversationEventItem<T>
    timelinePolicy: ConversationEventTimelinePolicy
    contextPolicy: ConversationEventContextPolicy
    timelineTargetParticipantIds: string[]
    contextTargetParticipantIds: string[]
    timelineContent: string
    timelineContentBlocks: CanonicalContentBlock[]
    metadata: Record<string, unknown>
    eventPayload: ConversationFeedEventPayloadMap[T]
  }

export type CreateConversationEventDeps = {
  listConversationParticipants: (
    queryable: Executor,
    conversationIds: string[]
  ) => Promise<ChatParticipantRow[]>
  createConversationItem: (
    params: CreateConversationItemInput
  ) => Promise<ChatConversationItem>
}

export type UpdateConversationItemEventPayloadDeps = {
  updateConversationItemEventPayload: (
    queryable: Executor,
    itemId: string,
    payload: unknown
  ) => Promise<void>
}

export async function updateConversationItemEventPayloadUseCase<
  T extends ConversationFeedEventType,
>(
  params: {
    itemId: string
    payload: ConversationFeedEventPayloadMap[T]
    queryable: Executor
  },
  deps: UpdateConversationItemEventPayloadDeps
): Promise<void> {
  await deps.updateConversationItemEventPayload(
    params.queryable,
    params.itemId,
    params.payload
  )
}

export async function updateConversationItemEventPayload<
  T extends ConversationFeedEventType,
>(
  itemId: string,
  payload: ConversationFeedEventPayloadMap[T],
  queryable: Executor = chatRootExecutor()
): Promise<void> {
  await updateConversationItemEventPayloadUseCase(
    {
      itemId,
      payload,
      queryable,
    },
    {
      updateConversationItemEventPayload: updateConversationItemEventPayloadRow,
    }
  )
}

function activeParticipants(participants: ChatParticipantRow[]) {
  return participants.filter(
    (participant) => participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE
  )
}

function resolveTimelineTargetParticipantIds(params: {
  timelinePolicy: ConversationEventTimelinePolicy
  activeParticipants: ChatParticipantRow[]
  restrictedAudienceParticipantIds?: string[]
}) {
  if (params.timelinePolicy === "targeted_members") {
    return [...new Set(params.restrictedAudienceParticipantIds ?? [])]
  }
  if (params.timelinePolicy === "users_only") {
    return params.activeParticipants
      .filter((participant) => participant.workspaceMemberId)
      .map((participant) => participant.id)
  }
  if (params.timelinePolicy === "actors_only") {
    return params.activeParticipants
      .filter((participant) => participant.actorId)
      .map((participant) => participant.id)
  }
  return []
}

function resolveContextTargetParticipantIds(params: {
  contextPolicy: ConversationEventContextPolicy
  activeParticipants: ChatParticipantRow[]
  contextTargetParticipantIds?: string[]
}) {
  if (params.contextPolicy === "targeted_members") {
    return [...new Set(params.contextTargetParticipantIds ?? [])]
  }
  if (params.contextPolicy === "shared") {
    return params.activeParticipants
      .filter((participant) => participant.actorId)
      .map((participant) => participant.id)
  }
  if (params.contextPolicy === "actor_private") {
    return [...new Set(params.contextTargetParticipantIds ?? [])]
  }
  return []
}

export async function createConversationEventUseCase<
  T extends ConversationFeedEventType,
>(
  params: CreateConversationEventInput<T>,
  deps: CreateConversationEventDeps
): Promise<CreateConversationEventResult<T>> {
  const executeCreate = async (queryable: Executor) => {
    const spec = getConversationEventSpec(params.eventType)
    const timelinePolicy = params.timelinePolicy ?? spec.timelinePolicy
    const contextPolicy = params.contextPolicy ?? spec.contextPolicy
    const eventPayload = params.eventPayload
    const participants = await deps.listConversationParticipants(queryable, [
      params.conversationId,
    ])
    const active = activeParticipants(participants)

    const timelineTargetParticipantIds = resolveTimelineTargetParticipantIds({
      timelinePolicy,
      activeParticipants: active,
      restrictedAudienceParticipantIds: params.restrictedAudienceParticipantIds,
    })
    const contextTargetParticipantIds = resolveContextTargetParticipantIds({
      contextPolicy,
      activeParticipants: active,
      contextTargetParticipantIds: params.contextTargetParticipantIds,
    })

    const normalizedTimeline = await buildNormalizedMessageContent({
      content: "",
      contentBlocks: renderConversationEventTimelineBlocks(
        params.eventType,
        eventPayload
      ),
      metadata: params.metadata ?? {},
    })

    const item = await deps.createConversationItem({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      turnId: params.turnId,
      scope: CONVERSATION_ITEM_SCOPE.SHARED,
      surface:
        timelinePolicy === "none"
          ? CONVERSATION_ITEM_SURFACE.INTERNAL
          : CONVERSATION_ITEM_SURFACE.VISIBLE,
      itemType: CONVERSATION_ITEM_TYPE.EVENT,
      subtype: params.eventType,
      role: CONVERSATION_ITEM_ROLE.SYSTEM,
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

    if (item.itemType !== CONVERSATION_ITEM_TYPE.EVENT) {
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
