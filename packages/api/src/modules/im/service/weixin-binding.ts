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

import { sql } from "kysely"
import { nowIsoInstant } from "@synapse/shared/datetime"
import { db } from "../../../infrastructure/database/kysely.js"
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
import {
  normalizeAccountRow,
  parseJsonObject,
  readTrimmedString,
} from "./_helpers.js"
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

async function loadWorkspaceMemberTransportAccountRow(params: {
  workspaceId: string
  workspaceMemberId: string
  transportKind: "weixin"
}) {
  return db
    .selectFrom("transportAccounts")
    .selectAll()
    .where("workspaceId", "=", params.workspaceId)
    .where("transportKind", "=", params.transportKind)
    .where("ownerScope", "=", "workspace_member")
    .where("ownerWorkspaceMemberId", "=", params.workspaceMemberId)
    .orderBy(
      sql<number>`CASE
        WHEN status = 'active' THEN 0
        WHEN status = 'error' THEN 1
        ELSE 2
      END`
    )
    .orderBy("updatedAt", "desc")
    .orderBy("createdAt", "desc")
    .limit(1)
    .executeTakeFirst()
}

async function loadWorkspaceMemberDisplayName(params: {
  workspaceId: string
  workspaceMemberId: string
}) {
  const row = await db
    .selectFrom("workspaceMembers as wm")
    .innerJoin("users as u", "u.id", "wm.userId")
    .select("u.name as name")
    .where("wm.workspaceId", "=", params.workspaceId)
    .where("wm.id", "=", params.workspaceMemberId)
    .limit(1)
    .executeTakeFirst()
  return readTrimmedString((row || {}) as Record<string, unknown>, "name")
}

export async function getCurrentUserWeixinBinding(params: {
  workspaceId: string
  userId: string
}): Promise<CurrentUserWeixinBindingSummary | null> {
  const workspaceMember = await db
    .selectFrom("workspaceMembers")
    .select("id")
    .where("workspaceId", "=", params.workspaceId)
    .where("userId", "=", params.userId)
    .limit(1)
    .executeTakeFirst()
  if (!workspaceMember?.id) {
    return null
  }

  const row = await loadWorkspaceMemberTransportAccountRow({
    workspaceId: params.workspaceId,
    workspaceMemberId: workspaceMember.id,
    transportKind: "weixin",
  })
  if (!row) {
    return null
  }

  const account = normalizeAccountRow(row)
  if (account.status !== "active") {
    return null
  }
  const metadata = parseJsonObject(row.metadata)
  const scannerUserId = readTrimmedString(metadata, "scannerUserId")
  const pendingAutoLinkWorkspaceMemberId =
    readPendingAutoLinkWorkspaceMemberId(metadata)
  const externalUsers = await listTransportExternalUsers({
    workspaceId: params.workspaceId,
    transportAccountId: account.id,
  })
  const pendingAutoLinkWorkspaceMemberName = pendingAutoLinkWorkspaceMemberId
    ? await loadWorkspaceMemberDisplayName({
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
  const currentWorkspaceMember = await db
    .selectFrom("workspaceMembers")
    .select("id")
    .where("workspaceId", "=", params.workspaceId)
    .where("userId", "=", params.userId)
    .limit(1)
    .executeTakeFirst()
  if (!currentWorkspaceMember?.id) {
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
    externalUser.linkedWorkspaceMemberId !== currentWorkspaceMember.id
  ) {
    throw new Error("WeChat user is already linked to another workspace member")
  }

  await setTransportAddressLinkedUser({
    workspaceId: params.workspaceId,
    transportAddressId: externalUser.id,
    workspaceMemberId: currentWorkspaceMember.id,
  })

  const updatedBinding = await getCurrentUserWeixinBinding(params)
  if (!updatedBinding) {
    throw new Error("WeChat binding not found")
  }
  return updatedBinding
}
