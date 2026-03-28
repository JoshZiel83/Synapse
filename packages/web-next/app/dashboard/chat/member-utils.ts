"use client"

import type { ConversationEntityRef } from "@synapse/shared"

import type { ConversationMember } from "@/stores/chat-store"

export function getConversationMemberSubtitle(member: ConversationMember) {
  if (member.type === "actor") {
    return member.title || member.role || "Actor"
  }
  if (member.type === "external") {
    return member.linkedUserName
      ? `External participant · linked to ${member.linkedUserName}`
      : "External participant"
  }
  if (member.transportKind) {
    return `Workspace user · reachable via ${formatTransportKindLabel(member.transportKind)}`
  }
  return "Workspace user"
}

export function getConversationMemberTypeLabel(member: ConversationMember) {
  if (member.type === "actor") return "Actor"
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
  if (member.type === "user") {
    return `${basePath}?kind=user&id=${member.id}`
  }
  if (member.type === "external" && member.linkedUserId) {
    return `${basePath}?kind=user&id=${member.linkedUserId}`
  }
  return undefined
}

export function resolveAuthorMember(
  author: ConversationEntityRef | undefined,
  conversationMembers: ConversationMember[] | undefined,
) {
  if (!author) return undefined
  const participantId = author.participantId || author.memberId
  return conversationMembers?.find((member) => {
    if (participantId && member.participantId === participantId) {
      return true
    }
    if (
      author.memberType === "actor" &&
      member.type === "actor" &&
      author.actorId &&
      member.id === author.actorId
    ) {
      return true
    }
    if (
      author.memberType === "user" &&
      member.type === "user" &&
      author.userId &&
      member.id === author.userId
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
  if (author?.memberType === "actor" && author.actorId) {
    return `${basePath}?kind=actor&id=${author.actorId}`
  }
  if (author?.memberType === "user" && author.userId) {
    return `${basePath}?kind=user&id=${author.userId}`
  }
  return undefined
}
