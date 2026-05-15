"use client"

import {
  CONVERSATION_PARTICIPANT_TYPE,
  type ConversationEntityRef,
} from "@synapse/shared"

import type { ConversationMember } from "@/stores/chat-store"

export function getConversationMemberSubtitle(member: ConversationMember) {
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
    return `Workspace user · reachable via ${formatTransportKindLabel(member.transportKind)}`
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

export function formatTransportKindLabel(
  kind: ConversationMember["transportKind"]
) {
  if (!kind) return undefined
  switch (kind) {
    case "feishu":
      return "Feishu"
    case "weixin":
      return "WeChat"
    default:
      return String(kind)
  }
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
