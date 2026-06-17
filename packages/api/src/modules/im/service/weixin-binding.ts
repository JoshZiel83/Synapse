/**
 * "Current user's WeChat binding" dashboard endpoints. The browser UI uses
 * these to: see whether the logged-in user has a personal WeChat account
 * linked, configure first-inbound auto-link, and finally consume the link
 * by attaching their workspace_member to the scanner's transport address.
 *
 * Personal WeChat is fundamentally tied to *the human who scanned the QR*,
 * so the binding lives at the workspace_member level (not workspace) and
 * gets its own dashboard surface separate from generic IM account CRUD.
 *
 * Extracted from service.ts. service.ts re-exports for back-compat.
 */

import { nowIsoInstant } from "@synapse/shared/datetime"
import type {
  CurrentUserWeixinBindingSummary,
  TransportExternalUserSummary,
} from "@synapse/shared/types"
import {
  ensureTransportAddress,
  assertWorkspaceMember,
  setTransportAddressLinkedUser,
} from "./addresses.js"
import { listTransportExternalUsers } from "./external-users.js"
import { normalizeAccountRow, readTrimmedString } from "./_helpers.js"
import {
  findWeixinWorkspaceMemberIdByUser,
  findWorkspaceMemberDisplayName,
  findWorkspaceMemberWeixinAccountRow,
} from "./repo.js"
import { updateTransportAccount } from "./accounts.js"

function pickCurrentWeixinExternalUser(params: {
  externalUsers: TransportExternalUserSummary[]
  scannerUserId?: string
}) {
  if (params.scannerUserId) {
    return (
      params.externalUsers.find(
        (externalUser) => externalUser.externalId === params.scannerUserId
      ) || null
    )
  }
  return params.externalUsers[0] || null
}

function readPendingAutoLinkWorkspaceMemberId(
  metadata: Record<string, unknown>
) {
  return readTrimmedString(metadata, "pendingAutoLinkWorkspaceMemberId")
}

export async function getCurrentUserWeixinBinding(params: {
  workspaceId: string
  userId: string
}): Promise<CurrentUserWeixinBindingSummary | null> {
  const workspaceMemberId = await findWeixinWorkspaceMemberIdByUser({
    workspaceId: params.workspaceId,
    userId: params.userId,
  })
  if (!workspaceMemberId) {
    return null
  }

  const row = await findWorkspaceMemberWeixinAccountRow({
    workspaceId: params.workspaceId,
    workspaceMemberId,
    transportKind: "weixin",
  })
  if (!row) {
    return null
  }

  const account = normalizeAccountRow(row)
  if (account.status !== "active") {
    return null
  }
  const metadata = account.metadata
  const scannerUserId = readTrimmedString(metadata, "scannerUserId")
  const pendingAutoLinkWorkspaceMemberId =
    readPendingAutoLinkWorkspaceMemberId(metadata)
  const externalUsers = await listTransportExternalUsers({
    workspaceId: params.workspaceId,
    transportAccountId: account.id,
  })
  const pendingAutoLinkWorkspaceMemberName = pendingAutoLinkWorkspaceMemberId
    ? await findWorkspaceMemberDisplayName({
        workspaceId: params.workspaceId,
        workspaceMemberId: pendingAutoLinkWorkspaceMemberId,
      })
    : undefined

  return {
    account,
    scannerUserId,
    pendingAutoLinkWorkspaceMemberId:
      pendingAutoLinkWorkspaceMemberId || undefined,
    pendingAutoLinkWorkspaceMemberName,
    externalUser:
      pickCurrentWeixinExternalUser({ externalUsers, scannerUserId }) ||
      undefined,
  }
}

export async function setCurrentUserWeixinBindingAutoLink(params: {
  workspaceId: string
  userId: string
  targetWorkspaceMemberId?: string | null
}): Promise<CurrentUserWeixinBindingSummary> {
  const binding = await getCurrentUserWeixinBinding({
    workspaceId: params.workspaceId,
    userId: params.userId,
  })
  if (!binding) {
    throw new Error("WeChat binding not found")
  }

  const nextTargetWorkspaceMemberId = params.targetWorkspaceMemberId || null
  if (nextTargetWorkspaceMemberId) {
    const isWorkspaceMember = await assertWorkspaceMember({
      workspaceId: params.workspaceId,
      workspaceMemberId: nextTargetWorkspaceMemberId,
    })
    if (!isWorkspaceMember) {
      throw new Error("Workspace member not found")
    }
  }

  const nextMetadata = {
    ...(binding.account.metadata || {}),
  } as Record<string, unknown>
  if (nextTargetWorkspaceMemberId) {
    nextMetadata.pendingAutoLinkWorkspaceMemberId = nextTargetWorkspaceMemberId
    nextMetadata.pendingAutoLinkMode = "first_inbound_once"
    nextMetadata.pendingAutoLinkConfiguredAt = nowIsoInstant()
  } else {
    delete (nextMetadata as any).pendingAutoLinkWorkspaceMemberId
    delete (nextMetadata as any).pendingAutoLinkMode
    delete (nextMetadata as any).pendingAutoLinkConfiguredAt
  }
  delete (nextMetadata as any).pendingAutoLinkConsumedAt
  delete (nextMetadata as any).pendingAutoLinkConsumedExternalId

  await updateTransportAccount({
    workspaceId: params.workspaceId,
    accountId: binding.account.id,
    metadata: nextMetadata,
  })

  const updatedBinding = await getCurrentUserWeixinBinding({
    workspaceId: params.workspaceId,
    userId: params.userId,
  })
  if (!updatedBinding) {
    throw new Error("WeChat binding not found")
  }
  return updatedBinding
}

export async function linkCurrentUserWeixinBinding(params: {
  workspaceId: string
  userId: string
}): Promise<CurrentUserWeixinBindingSummary> {
  const currentWorkspaceMemberId = await findWeixinWorkspaceMemberIdByUser({
    workspaceId: params.workspaceId,
    userId: params.userId,
  })
  if (!currentWorkspaceMemberId) {
    throw new Error("Workspace member not found")
  }

  const binding = await getCurrentUserWeixinBinding(params)
  if (!binding) {
    throw new Error("WeChat binding not found")
  }

  const scannerUserId =
    binding.scannerUserId || binding.externalUser?.externalId
  if (!scannerUserId) {
    throw new Error("WeChat binding does not expose a user ID yet")
  }

  let externalUser = binding.externalUser || null
  if (!externalUser) {
    await ensureTransportAddress({
      workspaceId: params.workspaceId,
      transportAccountId: binding.account.id,
      transportKind: "weixin",
      addressType: "user",
      externalId: scannerUserId,
      displayName: scannerUserId,
      metadata: {
        source: "qr_login",
        scannerUserId,
      },
    })

    const refreshed = await getCurrentUserWeixinBinding(params)
    externalUser = refreshed?.externalUser || null
  }

  if (!externalUser) {
    throw new Error("WeChat user not found")
  }
  if (
    externalUser.linkedWorkspaceMemberId &&
    externalUser.linkedWorkspaceMemberId !== currentWorkspaceMemberId
  ) {
    throw new Error("WeChat user is already linked to another workspace member")
  }

  await setTransportAddressLinkedUser({
    workspaceId: params.workspaceId,
    transportAddressId: externalUser.id,
    workspaceMemberId: currentWorkspaceMemberId,
  })

  const updatedBinding = await getCurrentUserWeixinBinding(params)
  if (!updatedBinding) {
    throw new Error("WeChat binding not found")
  }
  return updatedBinding
}
