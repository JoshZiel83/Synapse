import {
  CONVERSATION_PARTICIPANT_TYPE,
  isTransportKind,
  type ChatParticipantSummary,
} from "@synapse/shared"
import type { ConversationEntityRef } from "@synapse/shared/types"
import { subjectKindToParticipantType } from "../access/subject-registry.js"
import { getFileUrlById } from "../files/service.js"
import { presentInstant, presentOptionalInstant } from "./presenter.js"
import type { ChatParticipantRow } from "./repo.js"

function asParticipantTransportKind(
  value: string | null | undefined
): ConversationEntityRef["transportKind"] {
  return isTransportKind(value) ? value : undefined
}

export function participantDisplayName(row: ChatParticipantRow): string {
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

function participantAvatarUrl(row: ChatParticipantRow): string | undefined {
  const fileId =
    row.participantAvatarFileId ??
    row.userAvatarFileId ??
    row.linkedUserAvatarFileId
  return fileId ? getFileUrlById(fileId) : undefined
}

function participantAvatarEmoji(row: ChatParticipantRow): string | undefined {
  return row.participantAvatarEmoji ?? undefined
}

export function participantRowToEntityRef(
  participant: ChatParticipantRow | undefined
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

export function participantRowToChatParticipantSummary(
  participant: ChatParticipantRow
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
