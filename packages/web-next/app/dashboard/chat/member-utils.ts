"use client"

import type { ConversationEntityRef } from "@synapse/shared"

import type { GroupMember } from "@/stores/chat-store"

export function getGroupMemberSubtitle(member: GroupMember) {
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

export function getGroupMemberTypeLabel(member: GroupMember) {
  if (member.type === "actor") return "Actor"
  if (member.type === "external") return "External participant"
  return "Workspace user"
}

export function formatTransportKindLabel(kind: GroupMember["transportKind"]) {
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

export function getGroupMemberContactHref(
  member: GroupMember,
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
  groupMembers: GroupMember[] | undefined,
) {
  if (!author) return undefined
  const participantId = author.participantId || author.memberId
  return groupMembers?.find((member) => {
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
  groupMembers: GroupMember[] | undefined,
  basePath = "/dashboard/contacts",
) {
  const authorMember = resolveAuthorMember(author, groupMembers)
  if (authorMember) {
    return getGroupMemberContactHref(authorMember, basePath)
  }
  if (author?.memberType === "actor" && author.actorId) {
    return `${basePath}?kind=actor&id=${author.actorId}`
  }
  if (author?.memberType === "user" && author.userId) {
    return `${basePath}?kind=user&id=${author.userId}`
  }
  return undefined
}
