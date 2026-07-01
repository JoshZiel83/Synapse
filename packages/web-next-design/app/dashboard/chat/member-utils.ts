"use client"

import {
  CONVERSATION_PARTICIPANT_TYPE,
  describeTransportKind,
  isTransportKind,
  type ConversationEntityRef,
  type TransportConnectorCapability,
  type TransportKind,
} from "@synapse/shared"

import type { ConversationMember } from "@/stores/chat-store"

/**
 * Per-workspace IM connector metadata map. Sourced from the
 * `ConnectorMetadataProvider` in `@/lib/im-connector-metadata`;
 * passed as an optional parameter into pure-utility functions so
 * the utilities themselves stay hook-free (and SSR-friendly).
 */
export type ConnectorMetadataMap = Map<
  TransportKind,
  TransportConnectorCapability
>
type Metadata = ConnectorMetadataMap | undefined

export function getConversationMemberSubtitle(
  member: ConversationMember,
  metadata?: Metadata
) {
  if (member.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR) {
    return member.title || member.role || "Actor"
  }
  if (member.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT) {
    return member.title || member.role || "Remote agent"
  }
  if (member.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL) {
    return member.linkedWorkspaceMemberName
      ? `External participant · linked to ${member.linkedWorkspaceMemberName}`
      : "External participant"
  }
  if (member.transportKind) {
    return `Workspace user · reachable via ${formatTransportKindLabel(
      member.transportKind,
      metadata
    )}`
  }
  return "Workspace user"
}

export function getConversationMemberTypeLabel(member: ConversationMember) {
  if (member.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR)
    return "Actor"
  if (member.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT)
    return "Remote agent"
  if (member.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL)
    return "External participant"
  return "Workspace user"
}

/**
 * Resolve a user-facing transport label. Priority:
 *   1. `metadata.displayName` from the connector capability (true SoT)
 *   2. `describeTransportKind` static fallback (covers SSR/initial
 *      paint before the provider mounts)
 *   3. `String(kind)` when metadata absent and kind not in
 *      `TRANSPORT_KINDS` (defensive — should not normally happen)
 */
export function formatTransportKindLabel(
  kind: ConversationMember["transportKind"],
  metadata?: Metadata
) {
  if (!isTransportKind(kind)) return undefined
  const fromMeta = metadata?.get(kind)?.displayName
  if (fromMeta) return fromMeta
  return describeTransportKind(kind)
}

export function getConversationMemberContactHref(
  member: ConversationMember,
  basePath = "/dashboard/contacts"
) {
  if (member.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR) {
    return `${basePath}?kind=actor&id=${member.id}`
  }
  if (member.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT) {
    return `${basePath}?kind=remote_agent&id=${member.id}`
  }
  if (
    member.participantType === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER
  ) {
    return `${basePath}?kind=member&id=${member.id}`
  }
  if (
    member.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL &&
    member.linkedWorkspaceMemberId
  ) {
    return `${basePath}?kind=member&id=${member.linkedWorkspaceMemberId}`
  }
  return undefined
}

export function resolveAuthorMember(
  author: ConversationEntityRef | undefined,
  conversationMembers: ConversationMember[] | undefined
) {
  if (!author) return undefined
  const participantId = author.participantId
  return conversationMembers?.find((member) => {
    if (participantId && member.participantId === participantId) {
      return true
    }
    if (
      author.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR &&
      member.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR &&
      author.actorId &&
      member.id === author.actorId
    ) {
      return true
    }
    if (
      author.participantType ===
        CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
      member.participantType ===
        CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
      author.workspaceMemberId &&
      member.id === author.workspaceMemberId
    ) {
      return true
    }
    if (
      author.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT &&
      member.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT &&
      author.remoteAgentId &&
      member.id === author.remoteAgentId
    ) {
      return true
    }
    if (
      author.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL &&
      member.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL &&
      author.externalUserKey &&
      member.externalUserKey === author.externalUserKey
    ) {
      return true
    }
    return false
  })
}

export function getAuthorContactHref(
  author: ConversationEntityRef | undefined,
  conversationMembers: ConversationMember[] | undefined,
  basePath = "/dashboard/contacts"
) {
  const authorMember = resolveAuthorMember(author, conversationMembers)
  if (authorMember) {
    return getConversationMemberContactHref(authorMember, basePath)
  }
  if (
    author?.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR &&
    author.actorId
  ) {
    return `${basePath}?kind=actor&id=${author.actorId}`
  }
  if (
    author?.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT &&
    author.remoteAgentId
  ) {
    return `${basePath}?kind=remote_agent&id=${author.remoteAgentId}`
  }
  if (
    author?.participantType ===
      CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
    author.workspaceMemberId
  ) {
    return `${basePath}?kind=member&id=${author.workspaceMemberId}`
  }
  return undefined
}
