import { createChatError } from "./errors.js"
import {
  deleteChatPushTokenRecord,
  listChatPushTokenRecords,
  upsertChatPushTokenRecord,
  type ChatPushTokenRow,
} from "./repo.js"
import { requireWorkspaceMemberIdentity } from "./workspace-identity.js"

async function getWorkspaceMemberIdentityOrThrow(
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

export async function registerChatPushToken(params: {
  workspaceId: string
  userId: string
  platform: "ios" | "android" | "web"
  token: string
  deviceLabel?: string
  metadata?: Record<string, unknown>
}): Promise<{ token: ChatPushTokenRow }> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const token = await upsertChatPushTokenRecord({
    workspaceMemberId: identity.workspaceMemberId,
    platform: params.platform,
    token: params.token,
    deviceLabel: params.deviceLabel,
    metadata: params.metadata,
  })
  return { token }
}

export async function listChatPushTokens(params: {
  workspaceId: string
  userId: string
}): Promise<{ tokens: ChatPushTokenRow[] }> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const tokens = await listChatPushTokenRecords(identity.workspaceMemberId)
  return { tokens }
}

export async function deleteChatPushToken(params: {
  workspaceId: string
  userId: string
  tokenId: string
}): Promise<{ deleted: boolean }> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const deleted = await deleteChatPushTokenRecord({
    tokenId: params.tokenId,
    workspaceMemberId: identity.workspaceMemberId,
  })
  return { deleted }
}
