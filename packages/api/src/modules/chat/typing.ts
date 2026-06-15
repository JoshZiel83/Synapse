import { serializeNowInstant } from "../../infrastructure/datetime.js"
import { requireConversationAccess } from "./conversation-access.js"
import { getWorkspaceMemberIdentityOrThrow } from "./identity.js"
import { chatRootExecutor } from "./repo.js"

export async function broadcastTypingState(params: {
  workspaceId: string
  userId: string
  conversationId: string
  state: "started" | "stopped"
}): Promise<{ broadcast: boolean }> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  await requireConversationAccess(
    chatRootExecutor(),
    params.conversationId,
    identity.workspaceMemberId
  )
  // Fan out via the event bus. Subscribers (WS bridge) publish to other
  // participants. Typing is intentionally ephemeral, so it is not persisted.
  const { emitEvent } = await import("../../infrastructure/events/index.js")
  await emitEvent({
    type: "chat.typing",
    workspaceId: params.workspaceId,
    payload: {
      conversationId: params.conversationId,
      fromWorkspaceMemberId: identity.workspaceMemberId,
      state: params.state,
      occurredAt: serializeNowInstant(),
    },
    timestamp: serializeNowInstant(),
  })
  return { broadcast: true }
}
