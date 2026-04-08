"use client"

import {
  resolveConversationTypeKey,
  type ChatConversationView,
} from "@synapse/shared"
import type {
  ChatParticipantSummary,
  ConversationTypeKey,
} from "@synapse/shared/types"
import { api } from "@/lib/api"

export type ConversationCatalogParticipant = {
  participantId: string
  participantType: ChatParticipantSummary["participantType"]
  actorId?: string
  remoteAgentId?: string
  workspaceMemberId?: string
  name: string
  state: ChatParticipantSummary["state"]
}

export type ConversationCatalogEntry = {
  id: string
  title: string
  kind: ChatConversationView["kind"]
  boundary: ChatConversationView["boundary"]
  conversationTypeKey: ConversationTypeKey | null
  unreadCount: number
  participants: ConversationCatalogParticipant[]
}

function buildConversationTitle(conversation: ChatConversationView) {
  const explicitTitle = conversation.title?.trim()
  if (explicitTitle) {
    return explicitTitle
  }

  const participantNames = conversation.participants
    .map((participant) => participant.name?.trim())
    .filter((value): value is string => Boolean(value))
  if (participantNames.length > 0) {
    return participantNames.join(", ")
  }

  return "Untitled conversation"
}

export function normalizeConversationCatalogEntry(
  conversation: ChatConversationView
): ConversationCatalogEntry {
  return {
    id: conversation.conversationId,
    title: buildConversationTitle(conversation),
    kind: conversation.kind,
    boundary: conversation.boundary,
    conversationTypeKey: resolveConversationTypeKey(
      conversation.kind,
      conversation.boundary
    ),
    unreadCount: conversation.unreadCount,
    participants: conversation.participants.map(
      (participant): ConversationCatalogParticipant => ({
        participantId: participant.participantId,
        participantType: participant.participantType,
        actorId: participant.actorId,
        remoteAgentId: participant.remoteAgentId,
        workspaceMemberId: participant.workspaceMemberId,
        name: participant.name,
        state: participant.state,
      })
    ),
  }
}

export async function loadConversationCatalog(workspaceId: string) {
  const bootstrap = await api.getChatBootstrap(workspaceId)
  return bootstrap.conversations.map(normalizeConversationCatalogEntry)
}
