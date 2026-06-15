import { createChatError } from "./errors.js"
import { requireWorkspaceMemberIdentity } from "./workspace-identity.js"

export async function getWorkspaceMemberIdentityOrThrow(
  workspaceId: string,
  userId: string
) {
  try {
    return await requireWorkspaceMemberIdentity(workspaceId, userId)
  } catch {
    throw createChatError(
      403,
      "workspace_access_denied",
      "You are not a member of this workspace"
    )
  }
}
