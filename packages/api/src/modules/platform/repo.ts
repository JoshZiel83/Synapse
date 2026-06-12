import { db, withDbTransaction } from "../../infrastructure/database/kysely.js"
import { sql } from "kysely"
import { PLATFORM_ACCESS_KEYS } from "@synapse/shared"

export type PlatformAccessKey = (typeof PLATFORM_ACCESS_KEYS)[number]

export type PlatformAccessBindingRecord = {
  userId: string
  accessKey: string
  source: string
  assignedByUserId: string | null
  createdAt: Date
  updatedAt: Date
  userName: string
  userEmail: string
  avatarFileId: string | null
}

export type PlatformGrantRecord = {
  userId: string
  accessKey: string
  source: string
  assignedByUserId: string | null
  createdAt: Date
  updatedAt: Date
}

export async function userExists(userId: string): Promise<boolean> {
  const row = await db
    .selectFrom("users")
    .select("id")
    .where("id", "=", userId)
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

export async function hasActivePlatformAccess(
  userId: string,
  accessKeys: PlatformAccessKey[]
): Promise<boolean> {
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

export async function listAccessBindings(): Promise<
  PlatformAccessBindingRecord[]
> {
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
    accessKey: row.accessKey,
    source: row.source,
    assignedByUserId: row.assignedByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    userName: row.userName,
    userEmail: row.userEmail,
    avatarFileId: row.avatarFileId ?? null,
  }))
}

export async function selectBindingStatus(
  userId: string,
  accessKey: PlatformAccessKey
): Promise<{ status: string } | undefined> {
  return db
    .selectFrom("platformAccessBindings")
    .select("status")
    .where("userId", "=", userId)
    .where("accessKey", "=", accessKey)
    .executeTakeFirst()
}

export async function upsertManualGrant(input: {
  userId: string
  accessKey: PlatformAccessKey
  assignedByUserId: string
}): Promise<PlatformGrantRecord | undefined> {
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
    return undefined
  }

  return {
    userId: row.userId,
    accessKey: row.accessKey,
    source: row.source,
    assignedByUserId: row.assignedByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function upsertSeedSuperAdmin(
  userId: string,
  source: "config" | "manual"
): Promise<void> {
  await db
    .insertInto("platformAccessBindings")
    .values({
      userId,
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
}

export async function selectActiveBindingSource(
  userId: string,
  accessKey: PlatformAccessKey
): Promise<{ source: string } | undefined> {
  return db
    .selectFrom("platformAccessBindings")
    .select("source")
    .where("userId", "=", userId)
    .where("accessKey", "=", accessKey)
    .where("status", "=", "active")
    .limit(1)
    .executeTakeFirst()
}

export async function softRevokeBinding(
  userId: string,
  accessKey: PlatformAccessKey
): Promise<void> {
  await db
    .updateTable("platformAccessBindings")
    .set({ status: "revoked", revokedAt: sql`NOW()` })
    .where("userId", "=", userId)
    .where("accessKey", "=", accessKey)
    .where("status", "=", "active")
    .execute()
}

export async function upsertConfiguredSuperAdmin(
  userId: string
): Promise<void> {
  await db
    .insertInto("platformAccessBindings")
    .values({
      userId,
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
}

export async function selectUserIdsByLowerEmail(
  emails: string[]
): Promise<{ id: string }[]> {
  return db
    .selectFrom("users")
    .select("id")
    .where(sql<boolean>`lower(email) = ANY(${emails})`)
    .execute()
}

export async function reconcileConfiguredSuperAdmins(
  matchedUserIds: string[]
): Promise<void> {
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
}

export async function countActiveSuperAdmins(): Promise<number> {
  const platformAdminCount = await db
    .selectFrom("platformAccessBindings")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("accessKey", "=", "super_admin")
    .where("status", "=", "active")
    .executeTakeFirstOrThrow()
  return Number(platformAdminCount.count)
}
