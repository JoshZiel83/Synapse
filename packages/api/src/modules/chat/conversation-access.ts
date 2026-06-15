import {
  CONVERSATION_KIND,
  CONVERSATION_PARTICIPANT_STATE,
} from "@synapse/shared"
import type { Executor } from "../../infrastructure/database/kysely.js"
import { createChatError } from "./errors.js"
import {
  getChatConversationBaseRow,
  getChatWorkspaceMemberConversationParticipantRow,
} from "./repo.js"

export async function requireConversationAccess(
  queryable: Executor,
  conversationId: string,
  workspaceMemberId: string
) {
  const participant = await getChatWorkspaceMemberConversationParticipantRow(
    queryable,
    {
      conversationId,
      workspaceMemberId,
    }
  )
  if (
    !participant ||
    participant.state !== CONVERSATION_PARTICIPANT_STATE.ACTIVE
  ) {
    throw createChatError(
      403,
      "conversation_access_denied",
      "You are not a participant in this conversation"
    )
  }

  const baseRow = await getChatConversationBaseRow(queryable, {
    workspaceMemberId,
    conversationId,
  })
  if (!baseRow) {
    throw createChatError(
      404,
      "conversation_not_found",
      "Conversation not found"
    )
  }

  return {
    participant,
    baseRow,
  }
}

/**
 * Same as requireConversationAccess + asserts the viewer has management rights.
 * Throws 403 conversation_manage_denied otherwise.
 */
export async function requireConversationManagement(
  queryable: Executor,
  conversationId: string,
  workspaceMemberId: string
) {
  const access = await requireConversationAccess(
    queryable,
    conversationId,
    workspaceMemberId
  )
  if (access.baseRow.kind === CONVERSATION_KIND.DIRECT) {
    throw createChatError(
      403,
      "conversation_manage_denied",
      "Direct conversations cannot be managed"
    )
  }
  const roleKey = access.participant.roleKey
  if (roleKey !== "owner" && roleKey !== "admin") {
    throw createChatError(
      403,
      "conversation_manage_denied",
      "Only conversation owners or admins can perform this action"
    )
  }
  return access
}
