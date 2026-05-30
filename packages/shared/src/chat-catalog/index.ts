import { resolveConversationTypeKey } from "../utils/index.js"
import type {
  ChatConversationView,
  ChatParticipantSummary,
  ConversationTypeKey,
} from "../types/index.js"

/**
 * Compact projection of ChatConversationView used by UI surfaces that just
 * need a list of {id, title, kind, type-key, unread, participants} (plugin
 * filters, skill installers, memory browser, etc.). Lives in shared so
 * both web-next and any future client can map the same way without
 * duplicating the projection logic.
 */

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
  isIm: boolean
  conversationTypeKey: ConversationTypeKey | null
  unreadCount: number
  participants: ConversationCatalogParticipant[]
}

function buildConversationTitle(conversation: ChatConversationView) {
  const explicitTitle = conversation.title?.trim()
  if (explicitTitle) return explicitTitle

  const participantNames = conversation.participants
    .map((participant: ChatParticipantSummary) => participant.name?.trim())
    .filter((value: string | undefined): value is string => Boolean(value))
  if (participantNames.length > 0) return participantNames.join(", ")

  return "Untitled conversation"
}

export function normalizeConversationCatalogEntry(
  conversation: ChatConversationView
): ConversationCatalogEntry {
  return {
    id: conversation.conversationId,
    title: buildConversationTitle(conversation),
    kind: conversation.kind,
    isIm: conversation.isIm,
    conversationTypeKey: resolveConversationTypeKey(
      conversation.kind,
      conversation.isIm
    ),
    unreadCount: conversation.unreadCount,
    participants: conversation.participants.map(
      (
        participant: ChatParticipantSummary
      ): ConversationCatalogParticipant => ({
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

export function mapConversationsToCatalog(
  conversations: ChatConversationView[]
): ConversationCatalogEntry[] {
  return conversations.map(normalizeConversationCatalogEntry)
}
