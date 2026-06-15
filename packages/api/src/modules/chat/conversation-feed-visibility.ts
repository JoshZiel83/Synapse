import { CONVERSATION_MESSAGE_SUBTYPE } from "@synapse/shared"
import type { ConversationFeedItem } from "@synapse/shared/types"

export function isFeedItemVisibleToWorkspaceMember(
  item: ConversationFeedItem,
  workspaceMemberId: string
) {
  if (item.kind === "message") {
    if (item.messageType === CONVERSATION_MESSAGE_SUBTYPE.MODEL_ERROR_NOTICE) {
      if (!item.restrictedAudience || item.restrictedAudience.length === 0) {
        return true
      }
      if (item.author?.workspaceMemberId === workspaceMemberId) {
        return true
      }
      return item.restrictedAudience.some(
        (target) => target.workspaceMemberId === workspaceMemberId
      )
    }
    return true
  }

  if (!item.restrictedAudience || item.restrictedAudience.length === 0) {
    return true
  }
  if (item.author?.workspaceMemberId === workspaceMemberId) {
    return true
  }
  return item.restrictedAudience.some(
    (target) => target.workspaceMemberId === workspaceMemberId
  )
}
