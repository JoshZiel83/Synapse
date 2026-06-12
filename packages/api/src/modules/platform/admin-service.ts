import { config } from "../../config/index.js"
import { getFileUrlById } from "../files/service.js"
import * as repo from "./repo.js"
import type { PlatformAccessKey } from "./repo.js"

export type { PlatformAccessKey } from "./repo.js"

type UserIdentity = {
  id: string
  email: string
}

function configuredPlatformAdminEmails() {
  return Array.from(new Set(config.platform.adminEmails))
}

async function ensureUserExists(userId: string) {
  const exists = await repo.userExists(userId)
  if (!exists) {
    throw new Error("User not found")
  }
}

export function isConfiguredPlatformAdminEmail(email: string) {
  const normalized = email.trim().toLowerCase()
  return configuredPlatformAdminEmails().includes(normalized)
}

export async function hasPlatformAccess(
  userId: string,
  accessKeys: PlatformAccessKey[]
) {
  return repo.hasActivePlatformAccess(userId, accessKeys)
}

export async function isPlatformAdmin(userId: string) {
  return hasPlatformAccess(userId, [
    "super_admin",
    "workspace_admin",
    "model_admin",
  ])
}

/**
 * Stricter check than isPlatformAdmin: only `super_admin` passes.
 * Reserve this for process-wide / globally-destructive ops (cross-
 * workspace deletes, infra-level toggles, etc.) where the
 * workspace_admin / model_admin scopes would be the wrong floor.
 */
export async function isPlatformSuperAdmin(userId: string) {
  return hasPlatformAccess(userId, ["super_admin"])
}

export async function listPlatformAccessBindings() {
  const rows = await repo.listAccessBindings()

  return rows.map((row) => ({
    userId: row.userId,
    accessKey: row.accessKey as PlatformAccessKey,
    source: row.source,
    assignedByUserId: row.assignedByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    userName: row.userName,
    userEmail: row.userEmail,
    avatarUrl: row.avatarFileId ? getFileUrlById(row.avatarFileId) : null,
  }))
}

export async function grantPlatformAccess(input: {
  userId: string
  accessKey: PlatformAccessKey
  assignedByUserId: string
}) {
  await ensureUserExists(input.userId)

  // Re-grant must revive a revoked row (design §6.2). "Already granted" = an
  // existing ACTIVE row; a revoked row is updated back to active.
  const existing = await repo.selectBindingStatus(input.userId, input.accessKey)
  if (existing?.status === "active") {
    throw new Error("Access already granted")
  }

  const row = await repo.upsertManualGrant(input)

  if (!row) {
    throw new Error("Access already granted")
  }

  return {
    userId: row.userId,
    accessKey: row.accessKey as PlatformAccessKey,
    source: row.source,
    assignedByUserId: row.assignedByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function ensureSeedPlatformAdminForUser(user: UserIdentity) {
  const source = isConfiguredPlatformAdminEmail(user.email)
    ? "config"
    : "manual"

  await repo.upsertSeedSuperAdmin(user.id, source)

  return true
}

export async function revokePlatformAccess(
  userId: string,
  accessKey: PlatformAccessKey
) {
  const existing = await repo.selectActiveBindingSource(userId, accessKey)

  if (!existing) {
    throw new Error("Access grant not found")
  }

  if (existing.source === "config") {
    throw new Error("Config-managed access cannot be revoked manually")
  }

  // Soft revoke (design §6.2): status flip, not hard delete (sd_reject_delete).
  await repo.softRevokeBinding(userId, accessKey)
}

export async function ensureConfiguredPlatformAdminForUser(user: UserIdentity) {
  if (!isConfiguredPlatformAdminEmail(user.email)) {
    return false
  }

  await repo.upsertConfiguredSuperAdmin(user.id)

  return true
}

export async function syncConfiguredPlatformAdmins() {
  const emails = configuredPlatformAdminEmails()

  const matchedUserIds =
    emails.length > 0
      ? (await repo.selectUserIdsByLowerEmail(emails)).map((row) => row.id)
      : []

  await repo.reconcileConfiguredSuperAdmins(matchedUserIds)

  const platformAdminCount = await repo.countActiveSuperAdmins()

  return {
    configuredEmailCount: emails.length,
    matchedUserCount: matchedUserIds.length,
    platformAdminCount,
  }
}
