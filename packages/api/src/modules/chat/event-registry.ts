import type {
  CanonicalContentBlock,
  ConversationFeedEventPayloadMap,
  ConversationFeedEventType,
  ConversationEventContextPolicy,
  ConversationEventTimelinePolicy,
} from "@synapse/shared/types"
import {
  isCanonicalContentBlock,
  summarizeConversationEvent,
  textBlocks,
} from "@synapse/shared"

export interface ConversationEventRenderContext {
  eventType: ConversationFeedEventType
  payload: ConversationFeedEventPayloadMap[ConversationFeedEventType]
}

export interface ConversationEventSpec {
  timelinePolicy: ConversationEventTimelinePolicy
  contextPolicy: ConversationEventContextPolicy
  renderTimeline(
    context: ConversationEventRenderContext
  ): CanonicalContentBlock[]
  renderContext?(
    context: ConversationEventRenderContext
  ): CanonicalContentBlock[] | null
}

function genericSummary(eventType: string) {
  return `[Event: ${eventType}]`
}

function noContext(): null {
  return null
}

function noticeBlocks(
  payload: {
    messageBlocks?: unknown
    message?: unknown
    sourceTitle?: unknown
    sourceDescription?: unknown
  },
  fallback: string
): CanonicalContentBlock[] {
  // Strict validation: only accept input items that pass isCanonicalContentBlock.
  // Previously we accepted any object, which let garbage payloads (mismatched
  // schemas, half-built shapes) flow downstream as "blocks" and surface as
  // typed bugs at the LLM compile boundary.
  const messageBlocks = Array.isArray(payload.messageBlocks)
    ? (payload.messageBlocks.filter(
        isCanonicalContentBlock
      ) as CanonicalContentBlock[])
    : []
  if (messageBlocks.length > 0) {
    return messageBlocks
  }

  const message =
    typeof payload.message === "string" ? payload.message.trim() : ""
  if (message) {
    return textBlocks(message)
  }

  const sourceTitle =
    typeof payload.sourceTitle === "string" ? payload.sourceTitle.trim() : ""
  const sourceDescription =
    typeof payload.sourceDescription === "string"
      ? payload.sourceDescription.trim()
      : ""
  if (sourceTitle && sourceDescription) {
    return textBlocks(`${sourceTitle}\n${sourceDescription}`)
  }
  if (sourceTitle) {
    return textBlocks(sourceTitle)
  }

  return textBlocks(fallback)
}

const EVENT_SPECS: Record<ConversationFeedEventType, ConversationEventSpec> = {
  participant_joined: {
    timelinePolicy: "all_members",
    contextPolicy: "shared",
    renderTimeline: ({ eventType, payload }) =>
      textBlocks(summarizeConversationEvent(eventType, payload)),
    renderContext: ({ eventType, payload }) =>
      textBlocks(summarizeConversationEvent(eventType, payload)),
  },
  participant_kicked: {
    timelinePolicy: "all_members",
    contextPolicy: "shared",
    renderTimeline: ({ eventType, payload }) =>
      textBlocks(summarizeConversationEvent(eventType, payload)),
    renderContext: ({ eventType, payload }) =>
      textBlocks(summarizeConversationEvent(eventType, payload)),
  },
  participant_left: {
    timelinePolicy: "all_members",
    contextPolicy: "shared",
    renderTimeline: ({ eventType, payload }) =>
      textBlocks(summarizeConversationEvent(eventType, payload)),
    renderContext: ({ eventType, payload }) =>
      textBlocks(summarizeConversationEvent(eventType, payload)),
  },
  memory_saved: {
    timelinePolicy: "users_only",
    contextPolicy: "none",
    renderTimeline: ({ eventType, payload }) =>
      textBlocks(summarizeConversationEvent(eventType, payload)),
    renderContext: noContext,
  },
  memory_updated: {
    timelinePolicy: "users_only",
    contextPolicy: "none",
    renderTimeline: ({ eventType, payload }) =>
      textBlocks(summarizeConversationEvent(eventType, payload)),
    renderContext: noContext,
  },
  actor_renamed: {
    timelinePolicy: "users_only",
    contextPolicy: "none",
    renderTimeline: ({ eventType, payload }) =>
      textBlocks(summarizeConversationEvent(eventType, payload)),
    renderContext: noContext,
  },
  actor_avatar_changed: {
    timelinePolicy: "users_only",
    contextPolicy: "none",
    renderTimeline: ({ eventType, payload }) =>
      textBlocks(summarizeConversationEvent(eventType, payload)),
    renderContext: noContext,
  },
  automation_notice: {
    timelinePolicy: "all_members",
    contextPolicy: "shared",
    renderTimeline: ({ payload }) =>
      noticeBlocks(
        payload as ConversationFeedEventPayloadMap["automation_notice"],
        "Automation notice"
      ),
    renderContext: ({ payload }) =>
      noticeBlocks(
        payload as ConversationFeedEventPayloadMap["automation_notice"],
        "Automation notice"
      ),
  },
  task_requested: {
    timelinePolicy: "targeted_members",
    contextPolicy: "targeted_members",
    renderTimeline: ({ eventType, payload }) =>
      textBlocks(summarizeConversationEvent(eventType, payload)),
    renderContext: ({ eventType, payload }) =>
      textBlocks(summarizeConversationEvent(eventType, payload)),
  },
  task_notice: {
    timelinePolicy: "none",
    contextPolicy: "actor_private",
    renderTimeline: ({ payload }) =>
      noticeBlocks(
        payload as ConversationFeedEventPayloadMap["task_notice"],
        "Task update"
      ),
    renderContext: ({ payload }) =>
      noticeBlocks(
        payload as ConversationFeedEventPayloadMap["task_notice"],
        "Task update"
      ),
  },
}

const EVENT_TYPE_SET = new Set<ConversationFeedEventType>(
  Object.keys(EVENT_SPECS) as ConversationFeedEventType[]
)

export function isConversationEventType(
  value: string
): value is ConversationFeedEventType {
  return EVENT_TYPE_SET.has(value as ConversationFeedEventType)
}

export function getConversationEventSpec(
  eventType: ConversationFeedEventType
): ConversationEventSpec {
  return EVENT_SPECS[eventType]
}

export function renderConversationEventTimelineBlocks<
  T extends ConversationFeedEventType,
>(
  eventType: T,
  payload: ConversationFeedEventPayloadMap[T]
): CanonicalContentBlock[] {
  return getConversationEventSpec(eventType).renderTimeline({
    eventType,
    payload,
  })
}

export function renderConversationEventContextBlocks<
  T extends ConversationFeedEventType,
>(
  eventType: T,
  payload: ConversationFeedEventPayloadMap[T]
): CanonicalContentBlock[] | null {
  const spec = getConversationEventSpec(eventType)
  return spec.renderContext
    ? spec.renderContext({ eventType, payload })
    : spec.renderTimeline({ eventType, payload })
}
