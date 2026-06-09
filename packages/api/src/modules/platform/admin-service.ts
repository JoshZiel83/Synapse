import { config } from "../../config/index.js"
import type { PlatformAccessBindingsAccessKey } from "../../infrastructure/database/generated/db.js"
import { db, withDbTransaction } from "../../infrastructure/database/kysely.js"
import { sql } from "kysely"
import { getFileUrlById } from "../files/service.js"

export type PlatformAccessKey = PlatformAccessBindingsAccessKey

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
    .selectFrom("platform_access_bindings")
    .select("user_id")
    .where("user_id", "=", userId)
    .where("access_key", "in", accessKeys)
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
    .selectFrom("platform_access_bindings as pab")
    .innerJoin("users as u", "u.id", "pab.user_id")
    .select([
      "pab.user_id",
      "pab.access_key",
      "pab.source",
      "pab.assigned_by_user_id",
      "pab.created_at",
      "pab.updated_at",
      "u.name as user_name",
      "u.email as user_email",
      "u.avatar_file_id",
    ])
    .orderBy("pab.access_key", "asc")
    .orderBy("pab.created_at", "asc")
    .execute()

  return rows.map((row) => ({
    userId: row.user_id,
    accessKey: row.access_key as PlatformAccessKey,
    source: row.source,
    assignedByUserId: row.assigned_by_user_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    userName: row.user_name,
    userEmail: row.user_email,
    avatarUrl: row.avatar_file_id ? getFileUrlById(row.avatar_file_id) : null,
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
    .selectFrom("platform_access_bindings")
    .select("status")
    .where("user_id", "=", input.userId)
    .where("access_key", "=", input.accessKey)
    .executeTakeFirst()
  if (existing?.status === "active") {
    throw new Error("Access already granted")
  }

  const row = await db
    .insertInto("platform_access_bindings")
    .values({
      user_id: input.userId,
      access_key: input.accessKey,
      source: "manual",
      assigned_by_user_id: input.assignedByUserId,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "access_key"]).doUpdateSet({
        status: "active",
        revoked_at: null,
        source: "manual",
        assigned_by_user_id: input.assignedByUserId,
      })
    )
    .returningAll()
    .executeTakeFirst()

  if (!row) {
    throw new Error("Access already granted")
  }

  return {
    userId: row.user_id,
    accessKey: row.access_key as PlatformAccessKey,
    source: row.source,
    assignedByUserId: row.assigned_by_user_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function ensureSeedPlatformAdminForUser(user: UserIdentity) {
  const source = isConfiguredPlatformAdminEmail(user.email)
    ? "config"
    : "manual"

  await db
    .insertInto("platform_access_bindings")
    .values({
      user_id: user.id,
      access_key: "super_admin",
      source,
      assigned_by_user_id: null,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "access_key"]).doUpdateSet({
        status: "active",
        revoked_at: null,
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
    .selectFrom("platform_access_bindings")
    .select("source")
    .where("user_id", "=", userId)
    .where("access_key", "=", accessKey)
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
    .updateTable("platform_access_bindings")
    .set({ status: "revoked", revoked_at: sql`NOW()` })
    .where("user_id", "=", userId)
    .where("access_key", "=", accessKey)
    .where("status", "=", "active")
    .execute()
}

export async function ensureConfiguredPlatformAdminForUser(user: UserIdentity) {
  if (!isConfiguredPlatformAdminEmail(user.email)) {
    return false
  }

  await db
    .insertInto("platform_access_bindings")
    .values({
      user_id: user.id,
      access_key: "super_admin",
      source: "config",
      assigned_by_user_id: null,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "access_key"]).doUpdateSet({
        status: "active",
        revoked_at: null,
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
        .updateTable("platform_access_bindings")
        .set({ status: "revoked", revoked_at: sql`NOW()` })
        .where("source", "=", "config")
        .where("access_key", "=", "super_admin")
        .where("status", "=", "active")
        .execute()
      return
    }

    await trx
      .updateTable("platform_access_bindings")
      .set({ status: "revoked", revoked_at: sql`NOW()` })
      .where("source", "=", "config")
      .where("access_key", "=", "super_admin")
      .where("user_id", "not in", matchedUserIds)
      .where("status", "=", "active")
      .execute()
    await trx
      .insertInto("platform_access_bindings")
      .values(
        matchedUserIds.map((userId) => ({
          user_id: userId,
          access_key: "super_admin" as const,
          source: "config" as const,
          assigned_by_user_id: null,
        }))
      )
      .onConflict((oc) =>
        oc.columns(["user_id", "access_key"]).doUpdateSet({
          status: "active",
          revoked_at: null,
          source: "config",
        })
      )
      .execute()
  })
  const platformAdminCount = await db
    .selectFrom("platform_access_bindings")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("access_key", "=", "super_admin")
    .where("status", "=", "active")
    .executeTakeFirstOrThrow()

  return {
    configuredEmailCount: emails.length,
    matchedUserCount: matchedUserIds.length,
    platformAdminCount: Number(platformAdminCount.count),
  }
}
