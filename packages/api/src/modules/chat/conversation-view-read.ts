import type { Executor } from "../../infrastructure/database/kysely.js"
import {
  getChatConversationBaseRow,
  listChatConversationBaseRows,
  listChatConversationParticipantRows,
  listConversationItemRowsByIds,
} from "./repo.js"
import {
  loadConversationViewUseCase,
  loadConversationViewsUseCase,
  type LoadConversationViewsDeps,
} from "./conversation-view.js"
import { buildChatConversationItems } from "./conversation-item-read.js"
import { participantRowToChatParticipantSummary } from "./participant-projection.js"

async function getConversationBaseRow(
  queryable: Executor,
  workspaceMemberId: string,
  conversationId: string
) {
  return getChatConversationBaseRow(queryable, {
    workspaceMemberId,
    conversationId,
  })
}

function chatConversationViewDeps(): LoadConversationViewsDeps {
  return {
    getConversationBaseRow,
    listConversationBaseRows: listChatConversationBaseRows,
    listConversationParticipants: listChatConversationParticipantRows,
    listItemRowsByIds: listConversationItemRowsByIds,
    buildChatConversationItems,
    participantToSummary: participantRowToChatParticipantSummary,
  }
}

export async function loadChatConversationViews(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberId: string,
  conversationIds?: string[]
) {
  return loadConversationViewsUseCase(
    queryable,
    workspaceId,
    workspaceMemberId,
    conversationIds,
    chatConversationViewDeps()
  )
}

export async function loadChatConversationView(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberId: string,
  conversationId: string
) {
  return loadConversationViewUseCase(
    queryable,
    workspaceId,
    workspaceMemberId,
    conversationId,
    chatConversationViewDeps()
  )
}
