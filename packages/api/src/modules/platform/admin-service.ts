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
import {
  db,
  executeCompiledQuery,
  executeTakeFirst,
  type TableInsert,
} from "../../infrastructure/database/kysely.js";
import { sql } from "kysely";
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
  const rows = await db
    .selectFrom('platform_access_bindings')
    .select(['user_id', 'access_key'])
    .execute();
  return rows.map((row) => ({
    userId: row.user_id,
    accessKey: row.access_key as PlatformAccessKey,
  }));
}

async function ensureUserExists(userId: string) {
  const row = await db
    .selectFrom('users')
    .select('id')
    .where('id', '=', userId)
    .limit(1)
    .executeTakeFirst();
  if (!row) {
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
  const row = await db
    .selectFrom('platform_access_bindings')
    .select('user_id')
    .where('user_id', '=', userId)
    .where('access_key', 'in', accessKeys)
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
}

export async function isPlatformAdmin(userId: string) {
  return hasPlatformAccess(userId, [
    "super_admin",
    "workspace_admin",
    "model_admin",
  ]);
}

export async function listPlatformAccessBindings() {
  const rows = await db
    .selectFrom('platform_access_bindings as pab')
    .innerJoin('users as u', 'u.id', 'pab.user_id')
    .select([
      'pab.user_id',
      'pab.access_key',
      'pab.source',
      'pab.assigned_by',
      'pab.metadata',
      'pab.created_at',
      'pab.updated_at',
      'u.name as user_name',
      'u.email as user_email',
      'u.avatar_file_id',
    ])
    .orderBy('pab.access_key', 'asc')
    .orderBy('pab.created_at', 'asc')
    .execute();

  return rows.map((row) => ({
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

  const row = await db
    .insertInto('platform_access_bindings')
    .values({
      user_id: input.userId,
      access_key: input.accessKey,
      source: 'manual',
      assigned_by: input.assignedBy,
      metadata:
        (input.metadata || {}) as TableInsert<'platform_access_bindings'>['metadata'],
    })
    .onConflict((oc) => oc.columns(['user_id', 'access_key']).doNothing())
    .returningAll()
    .executeTakeFirst();

  if (!row) {
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
    userId: row.user_id,
    accessKey: row.access_key as PlatformAccessKey,
    source: row.source,
    assignedBy: row.assigned_by ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function ensureSeedPlatformAdminForUser(user: UserIdentity) {
  const source = isConfiguredPlatformAdminEmail(user.email)
    ? "config"
    : "manual";

  await db
    .insertInto('platform_access_bindings')
    .values({
      user_id: user.id,
      access_key: 'super_admin',
      source,
      assigned_by: null,
      metadata: {
        source: 'db.seed',
        email: user.email,
      } as TableInsert<'platform_access_bindings'>['metadata'],
    })
    .onConflict((oc) => oc.columns(['user_id', 'access_key']).doNothing())
    .execute();

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
  const existing = await db
    .selectFrom('platform_access_bindings')
    .select('source')
    .where('user_id', '=', userId)
    .where('access_key', '=', accessKey)
    .limit(1)
    .executeTakeFirst();

  if (!existing) {
    throw new Error("Access grant not found");
  }

  if (existing.source === "config") {
    throw new Error("Config-managed access cannot be revoked manually");
  }

  await db
    .deleteFrom('platform_access_bindings')
    .where('user_id', '=', userId)
    .where('access_key', '=', accessKey)
    .execute();

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

  await db
    .insertInto('platform_access_bindings')
    .values({
      user_id: user.id,
      access_key: 'super_admin',
      source: 'config',
      assigned_by: null,
      metadata: {} as TableInsert<'platform_access_bindings'>['metadata'],
    })
    .onConflict((oc) => oc.columns(['user_id', 'access_key']).doNothing())
    .execute();

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
      ? {
          rows: await db
            .selectFrom('users')
            .select('id')
            .where(sql<boolean>`lower(email) = ANY(${emails})`)
            .execute(),
        }
      : { rows: [] as Array<{ id: string }> };

  const matchedUserIds = matchedUsersResult.rows.map((row) => row.id);

  await transaction(async (client) => {
    if (matchedUserIds.length === 0) {
      await executeCompiledQuery(
        client,
        db
          .deleteFrom('platform_access_bindings')
          .where('source', '=', 'config')
          .where('access_key', '=', 'super_admin'),
      );
      return;
    }

    await executeCompiledQuery(
      client,
      db
        .deleteFrom('platform_access_bindings')
        .where('source', '=', 'config')
        .where('access_key', '=', 'super_admin')
        .where('user_id', 'not in', matchedUserIds),
    );
    await executeCompiledQuery(
      client,
      db
        .insertInto('platform_access_bindings')
        .values(
          matchedUserIds.map((userId) => ({
            user_id: userId,
            access_key: 'super_admin',
            source: 'config',
            assigned_by: null,
            metadata: {} as TableInsert<'platform_access_bindings'>['metadata'],
          })),
        )
        .onConflict((oc) => oc.columns(['user_id', 'access_key']).doNothing()),
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
