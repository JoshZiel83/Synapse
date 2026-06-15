import { randomUUID } from "crypto"
import type { Executor } from "../../infrastructure/database/kysely.js"
import { createChatError } from "./errors.js"
import {
  getChatClientInstanceOwner,
  insertChatClientInstance,
  updateChatClientInstanceSeen,
  withChatTransaction,
} from "./repo.js"
import type { ChatClientInstanceRegistrationRecord } from "./presenter.js"
import { requireWorkspaceMemberIdentity } from "./workspace-identity.js"

type RegisterClientInstanceInput = {
  workspaceId: string
  workspaceMemberId: string
  platform?: string
  deviceLabel?: string
  metadata?: Record<string, unknown>
}

type UpdateClientInstanceInput = RegisterClientInstanceInput & {
  clientInstanceId: string
}

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

export async function ensureClientInstance(
  queryable: Executor,
  input: UpdateClientInstanceInput
) {
  const owner = await getChatClientInstanceOwner(
    queryable,
    input.clientInstanceId
  )
  if (!owner) {
    throw createChatError(
      404,
      "client_instance_not_found",
      "Client instance not found"
    )
  }
  if (
    owner.workspaceId !== input.workspaceId ||
    owner.workspaceMemberId !== input.workspaceMemberId
  ) {
    throw createChatError(
      403,
      "client_instance_forbidden",
      "Client instance belongs to another workspace member"
    )
  }
}

async function createClientInstance(
  queryable: Executor,
  input: RegisterClientInstanceInput
) {
  const clientInstanceId = randomUUID()
  await insertChatClientInstance(queryable, {
    clientInstanceId,
    workspaceId: input.workspaceId,
    workspaceMemberId: input.workspaceMemberId,
    platform: input.platform,
    deviceLabel: input.deviceLabel,
    metadata: input.metadata,
  })

  return clientInstanceId
}

async function touchClientInstance(
  queryable: Executor,
  input: UpdateClientInstanceInput
) {
  await ensureClientInstance(queryable, input)

  await updateChatClientInstanceSeen(queryable, {
    clientInstanceId: input.clientInstanceId,
    platform: input.platform,
    deviceLabel: input.deviceLabel,
    metadata: input.metadata,
  })
}

export async function createChatClientInstance(params: {
  workspaceId: string
  userId: string
  platform?: string
  deviceLabel?: string
  metadata?: Record<string, unknown>
}): Promise<ChatClientInstanceRegistrationRecord> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const clientInstanceId = await withChatTransaction(async (client) =>
    createClientInstance(client, {
      workspaceId: params.workspaceId,
      workspaceMemberId: identity.workspaceMemberId,
      platform: params.platform,
      deviceLabel: params.deviceLabel,
      metadata: params.metadata,
    })
  )

  return {
    clientInstanceId,
    workspaceMemberId: identity.workspaceMemberId,
  }
}

export async function touchChatClientInstance(params: {
  workspaceId: string
  userId: string
  clientInstanceId: string
  platform?: string
  deviceLabel?: string
  metadata?: Record<string, unknown>
}): Promise<ChatClientInstanceRegistrationRecord> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  await withChatTransaction(async (client) => {
    await touchClientInstance(client, {
      workspaceId: params.workspaceId,
      workspaceMemberId: identity.workspaceMemberId,
      clientInstanceId: params.clientInstanceId,
      platform: params.platform,
      deviceLabel: params.deviceLabel,
      metadata: params.metadata,
    })
  })

  return {
    clientInstanceId: params.clientInstanceId,
    workspaceMemberId: identity.workspaceMemberId,
  }
}
