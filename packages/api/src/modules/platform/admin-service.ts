import { config } from "../../config/index.js"
import { PLATFORM_ACCESS_KEYS } from "@synapse/shared"
import { db, withDbTransaction } from "../../infrastructure/database/kysely.js"
import { sql } from "kysely"
import { getFileUrlById } from "../files/service.js"

export type PlatformAccessKey = (typeof PLATFORM_ACCESS_KEYS)[number]

type UserIdentity = {
  id: string
  email: string
}

function configuredPlatformAdminEmails() {
  return Array.from(new Set(config.platform.adminEmails))
}

async function ensureUserExists(userId: string) {
  const row = await db
    .selectFrom("users")
    .select("id")
    .where("id", "=", userId)
    .limit(1)
    .executeTakeFirst()
  if (!row) {
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
  const row = await db
    .selectFrom("platformAccessBindings")
    .select("userId")
    .where("userId", "=", userId)
    .where("accessKey", "in", accessKeys)
    .where("status", "=", "active")
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
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
  const rows = await db
    .selectFrom("platformAccessBindings as pab")
    .innerJoin("users as u", "u.id", "pab.userId")
    .select([
      "pab.userId",
      "pab.accessKey",
      "pab.source",
      "pab.assignedByUserId",
      "pab.createdAt",
      "pab.updatedAt",
      "u.name as userName",
      "u.email as userEmail",
      "u.avatarFileId",
    ])
    .orderBy("pab.accessKey", "asc")
    .orderBy("pab.createdAt", "asc")
    .execute()

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
  const existing = await db
    .selectFrom("platformAccessBindings")
    .select("status")
    .where("userId", "=", input.userId)
    .where("accessKey", "=", input.accessKey)
    .executeTakeFirst()
  if (existing?.status === "active") {
    throw new Error("Access already granted")
  }

  const row = await db
    .insertInto("platformAccessBindings")
    .values({
      userId: input.userId,
      accessKey: input.accessKey,
      source: "manual",
      assignedByUserId: input.assignedByUserId,
    })
    .onConflict((oc) =>
      oc.columns(["userId", "accessKey"]).doUpdateSet({
        status: "active",
        revokedAt: null,
        source: "manual",
        assignedByUserId: input.assignedByUserId,
      })
    )
    .returningAll()
    .executeTakeFirst()

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

  await db
    .insertInto("platformAccessBindings")
    .values({
      userId: user.id,
      accessKey: "super_admin",
      source,
      assignedByUserId: null,
    })
    .onConflict((oc) =>
      oc.columns(["userId", "accessKey"]).doUpdateSet({
        status: "active",
        revokedAt: null,
      })
    )
    .execute()

  return true
}

export async function revokePlatformAccess(
  userId: string,
  accessKey: PlatformAccessKey
) {
  const existing = await db
    .selectFrom("platformAccessBindings")
    .select("source")
    .where("userId", "=", userId)
    .where("accessKey", "=", accessKey)
    .where("status", "=", "active")
    .limit(1)
    .executeTakeFirst()

  if (!existing) {
    throw new Error("Access grant not found")
  }

  if (existing.source === "config") {
    throw new Error("Config-managed access cannot be revoked manually")
  }

  // Soft revoke (design §6.2): status flip, not hard delete (sd_reject_delete).
  await db
    .updateTable("platformAccessBindings")
    .set({ status: "revoked", revokedAt: sql`NOW()` })
    .where("userId", "=", userId)
    .where("accessKey", "=", accessKey)
    .where("status", "=", "active")
    .execute()
}

export async function ensureConfiguredPlatformAdminForUser(user: UserIdentity) {
  if (!isConfiguredPlatformAdminEmail(user.email)) {
    return false
  }

  await db
    .insertInto("platformAccessBindings")
    .values({
      userId: user.id,
      accessKey: "super_admin",
      source: "config",
      assignedByUserId: null,
    })
    .onConflict((oc) =>
      oc.columns(["userId", "accessKey"]).doUpdateSet({
        status: "active",
        revokedAt: null,
        source: "config",
      })
    )
    .execute()

  return true
}

export async function syncConfiguredPlatformAdmins() {
  const emails = configuredPlatformAdminEmails()

  const matchedUsersResult =
    emails.length > 0
      ? {
          rows: await db
            .selectFrom("users")
            .select("id")
            .where(sql<boolean>`lower(email) = ANY(${emails})`)
            .execute(),
        }
      : { rows: [] as Array<{ id: string }> }

  const matchedUserIds = matchedUsersResult.rows.map((row) => row.id)

  await withDbTransaction(async (trx) => {
    if (matchedUserIds.length === 0) {
      // Config reconcile: revoke all config-managed super_admin grants (status
      // flip, not hard delete — sd_reject_delete). §6.2.
      await trx
        .updateTable("platformAccessBindings")
        .set({ status: "revoked", revokedAt: sql`NOW()` })
        .where("source", "=", "config")
        .where("accessKey", "=", "super_admin")
        .where("status", "=", "active")
        .execute()
      return
    }

    await trx
      .updateTable("platformAccessBindings")
      .set({ status: "revoked", revokedAt: sql`NOW()` })
      .where("source", "=", "config")
      .where("accessKey", "=", "super_admin")
      .where("userId", "not in", matchedUserIds)
      .where("status", "=", "active")
      .execute()
    await trx
      .insertInto("platformAccessBindings")
      .values(
        matchedUserIds.map((userId) => ({
          userId: userId,
          accessKey: "super_admin" as const,
          source: "config" as const,
          assignedByUserId: null,
        }))
      )
      .onConflict((oc) =>
        oc.columns(["userId", "accessKey"]).doUpdateSet({
          status: "active",
          revokedAt: null,
          source: "config",
        })
      )
      .execute()
  })
  const platformAdminCount = await db
    .selectFrom("platformAccessBindings")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("accessKey", "=", "super_admin")
    .where("status", "=", "active")
    .executeTakeFirstOrThrow()

  return {
    configuredEmailCount: emails.length,
    matchedUserCount: matchedUserIds.length,
    platformAdminCount: Number(platformAdminCount.count),
  }
}
