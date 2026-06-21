// Conversation-feed-event + message-ref runtime helpers.
//
// Migrated out of `types/index.ts` so that `@synapse/shared/types` stays a
// pure type surface (see docs/architecture-boundary-refactor-master-plan.md
// §2.2.1). Re-exported from the package root barrel.

import {
  CONVERSATION_PARTICIPANT_TYPE,
  TASK_REQUEST_KIND,
} from "../constants/enums.js"
import { extractText } from "../content/index.js"
import type {
  CanonicalContentBlock,
  ChatTaskResolveConflictResponse,
  ConversationEntityRef,
  ConversationFeedEventPayloadMap,
  ConversationFeedEventType,
  TaskSummary,
} from "../types/index.js"

function formatConversationEntityName(
  entity: Partial<ConversationEntityRef> | undefined,
  fallback: string
) {
  const name = typeof entity?.name === "string" ? entity.name.trim() : ""
  return name || fallback
}

function formatConversationEntityList(
  entities: Array<Partial<ConversationEntityRef> | undefined>,
  fallback = "Unknown"
) {
  const names = entities
    .map((entity) => formatConversationEntityName(entity, fallback))
    .filter(Boolean)
  if (names.length === 0) return fallback
  if (names.length === 1) return names[0]!
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`
}

function summarizeParticipantEvent(
  eventType: Extract<
    ConversationFeedEventType,
    "participant_joined" | "participant_kicked" | "participant_left"
  >,
  payload:
    | ConversationFeedEventPayloadMap["participant_joined"]
    | ConversationFeedEventPayloadMap["participant_kicked"]
    | ConversationFeedEventPayloadMap["participant_left"]
) {
  const initiator = payload.initiator
  const participants = Array.isArray(payload.participants)
    ? payload.participants
    : []
  const initiatorName = formatConversationEntityName(initiator, "")
  const initiatorParticipantId = initiator?.participantId
  const participantList = formatConversationEntityList(participants)
  const nonInitiatorParticipants = initiatorParticipantId
    ? participants.filter(
        (participant) => participant.participantId !== initiatorParticipantId
      )
    : participants

  if (eventType === "participant_joined") {
    if (initiatorName) {
      if (
        initiatorParticipantId &&
        participants.some(
          (participant) => participant.participantId === initiatorParticipantId
        )
      ) {
        if (nonInitiatorParticipants.length === 0) {
          return `${initiatorName} joined the conversation`
        }
        return `${initiatorName} started the conversation with ${formatConversationEntityList(nonInitiatorParticipants)}`
      }
      return `${initiatorName} invited ${participantList} to the conversation`
    }
    return `${participantList} joined the conversation`
  }

  if (eventType === "participant_kicked") {
    if (initiatorName) {
      return `${initiatorName} removed ${participantList} from the conversation`
    }
    return `${participantList} was removed from the conversation`
  }

  if (initiatorName && initiatorParticipantId && participants.length === 1) {
    const leavingParticipant = participants[0]
    if (
      leavingParticipant &&
      leavingParticipant.participantId === initiatorParticipantId
    ) {
      return `${initiatorName} left the conversation`
    }
  }
  return `${participantList} left the conversation`
}

export function summarizeConversationEvent(
  eventType: ConversationFeedEventType | string,
  payload: unknown
) {
  const eventPayload =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {}

  if (eventType === "participant_joined") {
    return summarizeParticipantEvent(
      "participant_joined",
      eventPayload as ConversationFeedEventPayloadMap["participant_joined"]
    )
  }

  if (eventType === "participant_kicked") {
    return summarizeParticipantEvent(
      "participant_kicked",
      eventPayload as ConversationFeedEventPayloadMap["participant_kicked"]
    )
  }

  if (eventType === "participant_left") {
    return summarizeParticipantEvent(
      "participant_left",
      eventPayload as ConversationFeedEventPayloadMap["participant_left"]
    )
  }

  if (eventType === "memory_saved" || eventType === "memory_updated") {
    const textDigest =
      typeof eventPayload.textDigest === "string"
        ? eventPayload.textDigest.trim()
        : ""
    let scope = "memory"
    if (typeof eventPayload.memorySpaceType === "string") {
      scope = eventPayload.memorySpaceType
    } else if (typeof eventPayload.memoryScope === "string") {
      scope = eventPayload.memoryScope
    }
    const actionLabel = eventType === "memory_updated" ? "updated" : "saved"
    const summary = textDigest || "durable memory saved"
    return `Memory ${actionLabel}: ${summary} (${scope})`
  }

  if (eventType === "actor_renamed") {
    const newName =
      typeof eventPayload.newName === "string"
        ? eventPayload.newName.trim()
        : "Unknown"
    return `Actor renamed: will now be called ${newName}.`
  }

  if (eventType === "actor_avatar_changed") {
    const avatarEmoji =
      typeof eventPayload.newAvatarEmoji === "string"
        ? eventPayload.newAvatarEmoji.trim()
        : ""
    if (avatarEmoji) {
      return `Actor avatar updated to ${avatarEmoji}.`
    }
    return "Actor avatar updated."
  }

  if (eventType === "automation_notice") {
    const messageBlocks = Array.isArray(eventPayload.messageBlocks)
      ? (eventPayload.messageBlocks as CanonicalContentBlock[])
      : []
    const messageFromBlocks = extractText(messageBlocks).trim()
    const message =
      messageFromBlocks ||
      (typeof eventPayload.message === "string"
        ? eventPayload.message.trim()
        : "")
    if (message) return message
    const sourceTitle =
      typeof eventPayload.sourceTitle === "string"
        ? eventPayload.sourceTitle.trim()
        : ""
    const sourceSummary =
      typeof eventPayload.sourceSummary === "string"
        ? eventPayload.sourceSummary.trim()
        : ""
    if (sourceTitle && sourceSummary) {
      return `${sourceTitle}: ${sourceSummary}`
    }
    if (sourceTitle) return sourceTitle
    if (sourceSummary) return sourceSummary
    const sourceLabel =
      typeof eventPayload.sourceLabel === "string"
        ? eventPayload.sourceLabel.trim()
        : ""
    if (sourceLabel) return sourceLabel
    return "Automation notice"
  }

  if (eventType === "task_notice") {
    const summary =
      typeof eventPayload.summary === "string"
        ? eventPayload.summary.trim()
        : ""
    if (summary) return summary
    const toolName =
      typeof eventPayload.toolName === "string"
        ? eventPayload.toolName.trim()
        : "tool"
    const status =
      typeof eventPayload.status === "string"
        ? eventPayload.status.trim()
        : "completed"
    return `${toolName} ${status}`
  }

  if (eventType === "task_requested") {
    const task =
      eventPayload.task && typeof eventPayload.task === "object"
        ? (eventPayload.task as TaskSummary)
        : undefined
    if (!task) {
      return "Task requested"
    }
    if (task.kind === TASK_REQUEST_KIND.USER_INPUT) {
      const targetName =
        task.target?.name?.trim() ||
        (task.requester?.participantType ===
        CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
          ? "the group"
          : "a user")
      const prompt = task.userInput?.title?.trim() || "A question"
      if (task.lifecycleStatus === "cancelled") {
        return `Input request for ${targetName} was cancelled: ${prompt}`
      }
      return task.lifecycleStatus === "completed" && task.outcome === "answered"
        ? `${targetName} answered: ${prompt}`
        : `Input requested from ${targetName}: ${prompt}`
    }
    if (task.kind === TASK_REQUEST_KIND.PLAN_APPROVAL) {
      const targetName =
        task.target?.name?.trim() ||
        (task.requester?.participantType ===
        CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
          ? "the group"
          : "a user")
      const title = task.planApproval?.title?.trim() || "Plan approval"
      if (task.lifecycleStatus === "cancelled") {
        return `Plan approval for ${targetName} was cancelled: ${title}`
      }
      if (task.lifecycleStatus === "completed" && task.outcome === "approved") {
        return `${targetName} approved: ${title}`
      }
      if (
        task.lifecycleStatus === "completed" &&
        task.outcome === "revision_requested"
      ) {
        return `${targetName} requested changes: ${title}`
      }
      return `Plan approval requested from ${targetName}: ${title}`
    }
    const deviceName =
      task.runtimeAuthorization?.deviceDisplayName?.trim() || "device"
    if (task.lifecycleStatus === "cancelled") {
      return `Runtime authorization request was cancelled for ${deviceName}`
    }
    if (task.lifecycleStatus === "completed" && task.outcome === "denied") {
      const resolverName = task.resolvedBy?.name?.trim() || "A user"
      return `${resolverName} rejected access for ${deviceName}`
    }
    if (task.lifecycleStatus === "completed" && task.outcome === "granted") {
      const resolverName = task.resolvedBy?.name?.trim() || "A user"
      return `${resolverName} approved access for ${deviceName}`
    }
    return `Runtime authorization requested for ${deviceName}`
  }

  return `[Event: ${eventType}]`
}

export function buildConversationMessageRef(sequence: number): string {
  return `m_${Math.trunc(sequence)}`
}

export function parseConversationMessageRef(ref: string): number | null {
  const match = /^m_(\d+)$/.exec(ref.trim())
  if (!match) return null
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : null
}

export function isChatTaskResolveConflictResponse(
  value: unknown
): value is ChatTaskResolveConflictResponse {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { outcome?: unknown }).outcome === "conflict" &&
    (value as { code?: unknown }).code === "task_conflict" &&
    typeof (value as { error?: unknown }).error === "string" &&
    (value as { task?: unknown }).task &&
    typeof (value as { task?: unknown }).task === "object"
  )
}
