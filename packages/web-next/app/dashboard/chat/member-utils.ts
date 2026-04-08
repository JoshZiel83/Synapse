"use client"

import type { ConversationEntityRef } from "@synapse/shared"

import type { ConversationMember } from "@/stores/chat-store"

export function getConversationMemberSubtitle(member: ConversationMember) {
  if (member.type === "actor") {
    return member.title || member.role || "Actor"
  }
  if (member.type === "remote_agent") {
    return member.title || member.role || "Remote agent"
  }
  if (member.type === "external") {
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
  if (member.type === "actor") return "Actor"
  if (member.type === "remote_agent") return "Remote agent"
  if (member.type === "external") return "External participant"
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
  basePath = "/dashboard/contacts",
) {
  if (member.type === "actor") {
    return `${basePath}?kind=actor&id=${member.id}`
  }
  if (member.type === "remote_agent") {
    return `${basePath}?kind=remote_agent&id=${member.id}`
  }
  if (member.type === "workspace_member") {
    return `${basePath}?kind=member&id=${member.id}`
  }
  if (member.type === "external" && member.linkedWorkspaceMemberId) {
    return `${basePath}?kind=member&id=${member.linkedWorkspaceMemberId}`
  }
  return undefined
}

export function resolveAuthorMember(
  author: ConversationEntityRef | undefined,
  conversationMembers: ConversationMember[] | undefined,
) {
  if (!author) return undefined
  const participantId = author.participantId
  return conversationMembers?.find((member) => {
    if (participantId && member.participantId === participantId) {
      return true
    }
    if (
      author.participantType === "actor" &&
      member.type === "actor" &&
      author.actorId &&
      member.id === author.actorId
    ) {
      return true
    }
    if (
      author.participantType === "workspace_member" &&
      member.type === "workspace_member" &&
      author.workspaceMemberId &&
      member.id === author.workspaceMemberId
    ) {
      return true
    }
    if (
      author.participantType === "remote_agent" &&
      member.type === "remote_agent" &&
      author.remoteAgentId &&
      member.id === author.remoteAgentId
    ) {
      return true
    }
    if (
      author.participantType === "external" &&
      member.type === "external" &&
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
  basePath = "/dashboard/contacts",
) {
  const authorMember = resolveAuthorMember(author, conversationMembers)
  if (authorMember) {
    return getConversationMemberContactHref(authorMember, basePath)
  }
  if (author?.participantType === "actor" && author.actorId) {
    return `${basePath}?kind=actor&id=${author.actorId}`
  }
  if (author?.participantType === "remote_agent" && author.remoteAgentId) {
    return `${basePath}?kind=remote_agent&id=${author.remoteAgentId}`
  }
  if (
    author?.participantType === "workspace_member" &&
    author.workspaceMemberId
  ) {
    return `${basePath}?kind=member&id=${author.workspaceMemberId}`
  }
  return undefined
}
