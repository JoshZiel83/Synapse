import { config } from "../../config/index.js";
import {
  AUTHZ_PLATFORM_ID,
  deleteRelation,
  diffAuthzRelationships,
  enqueueAuthzRelationships,
  flushAuthzOutboxEntries,
  touchRelation,
  type AuthzRelationMutation,
} from "../../infrastructure/authz/index.js";
import { query, transaction } from "../../infrastructure/database/index.js";
import { getFileUrlById } from "../files/service.js";

export type PlatformAccessKey =
  | "super_admin"
  | "workspace_admin"
  | "model_admin"
  | "support"
  | "auditor";

type UserIdentity = {
  id: string;
  email: string;
};

function configuredPlatformAdminEmails() {
  return Array.from(new Set(config.authz.platformAdminEmails));
}

function buildPlatformAccessRelations(
  rows: Array<{ userId: string; accessKey: PlatformAccessKey }>,
): AuthzRelationMutation[] {
  return rows.map((row) =>
    touchRelation(
      "platform",
      AUTHZ_PLATFORM_ID,
      row.accessKey,
      "user",
      row.userId,
    ),
  );
}

async function flushQueuedAuthzEntries(entryIds: string[], source: string) {
  if (entryIds.length === 0) return;

  try {
    await flushAuthzOutboxEntries(entryIds);
  } catch (error) {
    console.error(
      `[authz] Failed to flush ${source} relationship updates:`,
      error,
    );
  }
}

async function listPlatformAccessRows() {
  const result = await query<{
    user_id: string;
    access_key: PlatformAccessKey;
  }>(
    `SELECT user_id, access_key
     FROM platform_access_bindings`,
    [],
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    accessKey: row.access_key,
  }));
}

async function ensureUserExists(userId: string) {
  const result = await query(
    `SELECT 1
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId],
  );
  if (result.rows.length === 0) {
    throw new Error("User not found");
  }
}

export function isConfiguredPlatformAdminEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  return configuredPlatformAdminEmails().includes(normalized);
}

export async function hasPlatformAccess(
  userId: string,
  accessKeys: PlatformAccessKey[],
) {
  const result = await query(
    `SELECT 1
     FROM platform_access_bindings
     WHERE user_id = $1
       AND access_key = ANY($2::text[])
     LIMIT 1`,
    [userId, accessKeys],
  );
  return result.rows.length > 0;
}

export async function isPlatformAdmin(userId: string) {
  return hasPlatformAccess(userId, [
    "super_admin",
    "workspace_admin",
    "model_admin",
  ]);
}

export async function listPlatformAccessBindings() {
  const result = await query(
    `SELECT
        pab.user_id,
        pab.access_key,
        pab.source,
        pab.assigned_by,
        pab.metadata,
        pab.created_at,
        pab.updated_at,
        u.name AS user_name,
        u.email AS user_email,
        u.avatar_file_id
     FROM platform_access_bindings pab
     JOIN users u ON u.id = pab.user_id
     ORDER BY pab.access_key ASC, pab.created_at ASC`,
    [],
  );

  return result.rows.map((row) => ({
    userId: row.user_id,
    accessKey: row.access_key as PlatformAccessKey,
    source: row.source,
    assignedBy: row.assigned_by ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    userName: row.user_name,
    userEmail: row.user_email,
    avatarUrl: row.avatar_file_id ? getFileUrlById(row.avatar_file_id) : null,
  }));
}

export async function grantPlatformAccess(input: {
  userId: string;
  accessKey: PlatformAccessKey;
  assignedBy: string;
  metadata?: Record<string, unknown>;
}) {
  await ensureUserExists(input.userId);

  const result = await query(
    `INSERT INTO platform_access_bindings (user_id, access_key, source, assigned_by, metadata)
     VALUES ($1, $2, 'manual', $3, $4::jsonb)
     ON CONFLICT (user_id, access_key) DO NOTHING
     RETURNING *`,
    [
      input.userId,
      input.accessKey,
      input.assignedBy,
      JSON.stringify(input.metadata || {}),
    ],
  );

  if (result.rows.length === 0) {
    throw new Error("Access already granted");
  }

  const authzEntryIds = await enqueueAuthzRelationships(
    [
      touchRelation(
        "platform",
        AUTHZ_PLATFORM_ID,
        input.accessKey,
        "user",
        input.userId,
      ),
    ],
    {
      source: "platform.access.grant",
      userId: input.userId,
      accessKey: input.accessKey,
      assignedBy: input.assignedBy,
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, "platform.access.grant");

  return {
    userId: result.rows[0].user_id,
    accessKey: result.rows[0].access_key as PlatformAccessKey,
    source: result.rows[0].source,
    assignedBy: result.rows[0].assigned_by ?? null,
    metadata: result.rows[0].metadata ?? {},
    createdAt: result.rows[0].created_at,
    updatedAt: result.rows[0].updated_at,
  };
}

export async function ensureSeedPlatformAdminForUser(user: UserIdentity) {
  const source = isConfiguredPlatformAdminEmail(user.email)
    ? "config"
    : "manual";

  await query(
    `INSERT INTO platform_access_bindings (user_id, access_key, source, assigned_by, metadata)
     VALUES ($1, 'super_admin', $2, NULL, $3::jsonb)
     ON CONFLICT (user_id, access_key) DO NOTHING`,
    [user.id, source, JSON.stringify({ source: "db.seed", email: user.email })],
  );

  const authzEntryIds = await enqueueAuthzRelationships(
    buildPlatformAccessRelations([
      { userId: user.id, accessKey: "super_admin" },
    ]),
    {
      source: "platform_admin.seed",
      userId: user.id,
      email: user.email,
      accessKey: "super_admin",
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, "platform_admin.seed");

  return true;
}

export async function revokePlatformAccess(
  userId: string,
  accessKey: PlatformAccessKey,
) {
  const existing = await query(
    `SELECT source
     FROM platform_access_bindings
     WHERE user_id = $1
       AND access_key = $2
     LIMIT 1`,
    [userId, accessKey],
  );

  if (existing.rows.length === 0) {
    throw new Error("Access grant not found");
  }

  if (existing.rows[0].source === "config") {
    throw new Error("Config-managed access cannot be revoked manually");
  }

  await query(
    `DELETE FROM platform_access_bindings
     WHERE user_id = $1
       AND access_key = $2`,
    [userId, accessKey],
  );

  const authzEntryIds = await enqueueAuthzRelationships(
    [deleteRelation("platform", AUTHZ_PLATFORM_ID, accessKey, "user", userId)],
    {
      source: "platform.access.revoke",
      userId,
      accessKey,
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, "platform.access.revoke");
}

export async function ensureConfiguredPlatformAdminForUser(user: UserIdentity) {
  if (!isConfiguredPlatformAdminEmail(user.email)) {
    return false;
  }

  await query(
    `INSERT INTO platform_access_bindings (user_id, access_key, source, assigned_by, metadata)
     VALUES ($1, 'super_admin', 'config', NULL, '{}'::jsonb)
     ON CONFLICT (user_id, access_key) DO NOTHING`,
    [user.id],
  );

  const authzEntryIds = await enqueueAuthzRelationships(
    buildPlatformAccessRelations([
      { userId: user.id, accessKey: "super_admin" },
    ]),
    {
      source: "platform_admin.ensure",
      userId: user.id,
      email: user.email,
      accessKey: "super_admin",
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, "platform_admin.ensure");

  return true;
}

export async function syncConfiguredPlatformAdmins() {
  const emails = configuredPlatformAdminEmails();
  const previousAccessRows = await listPlatformAccessRows();

  const matchedUsersResult =
    emails.length > 0
      ? await query<{ id: string }>(
          `SELECT id
         FROM users
         WHERE lower(email) = ANY($1)`,
          [emails],
        )
      : { rows: [] as Array<{ id: string }> };

  const matchedUserIds = matchedUsersResult.rows.map((row) => row.id);

  await transaction(async (client) => {
    if (matchedUserIds.length === 0) {
      await client.query(
        `DELETE FROM platform_access_bindings
         WHERE source = 'config'
           AND access_key = 'super_admin'`,
        [],
      );
      return;
    }

    await client.query(
      `DELETE FROM platform_access_bindings
       WHERE source = 'config'
         AND access_key = 'super_admin'
         AND user_id <> ALL($1::uuid[])`,
      [matchedUserIds],
    );
    await client.query(
      `INSERT INTO platform_access_bindings (user_id, access_key, source, assigned_by, metadata)
       SELECT UNNEST($1::uuid[]), 'super_admin', 'config', NULL, '{}'::jsonb
       ON CONFLICT (user_id, access_key) DO NOTHING`,
      [matchedUserIds],
    );
  });

  const nextAccessRows = await listPlatformAccessRows();

  const authzEntryIds = await enqueueAuthzRelationships(
    diffAuthzRelationships(
      buildPlatformAccessRelations(previousAccessRows),
      buildPlatformAccessRelations(nextAccessRows),
    ),
    {
      source: "platform_admin.sync",
      configuredEmailCount: emails.length,
      matchedUserCount: matchedUserIds.length,
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, "platform_admin.sync");

  return {
    configuredEmailCount: emails.length,
    matchedUserCount: matchedUserIds.length,
    platformAdminCount: nextAccessRows.filter(
      (row) => row.accessKey === "super_admin",
    ).length,
  };
}
