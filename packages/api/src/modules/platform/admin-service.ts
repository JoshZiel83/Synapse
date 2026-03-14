import { config } from '../../config/index.js';
import {
  AUTHZ_PLATFORM_ID,
  authzEnabled,
  deleteRelation,
  diffAuthzRelationships,
  enqueueAuthzRelationships,
  flushAuthzOutboxEntries,
  touchRelation,
  type AuthzRelationMutation,
} from '../../infrastructure/authz/index.js';
import { query, transaction } from '../../infrastructure/database/index.js';

export type PlatformRole = 'super_admin' | 'workspace_admin' | 'model_admin' | 'support' | 'auditor';

type UserIdentity = {
  id: string;
  email: string;
};

function configuredPlatformAdminEmails() {
  return Array.from(new Set(config.authz.platformAdminEmails));
}

function buildPlatformRoleRelations(rows: Array<{ userId: string; role: PlatformRole }>): AuthzRelationMutation[] {
  return rows.map((row) =>
    touchRelation('platform', AUTHZ_PLATFORM_ID, row.role, 'user', row.userId),
  );
}

async function flushQueuedAuthzEntries(entryIds: string[], source: string) {
  if (!authzEnabled() || entryIds.length === 0) return;

  try {
    await flushAuthzOutboxEntries(entryIds);
  } catch (error) {
    console.error(`[authz] Failed to flush ${source} relationship updates:`, error);
  }
}

async function listPlatformRoles() {
  const result = await query<{ user_id: string; role: PlatformRole }>(
    `SELECT user_id, role
     FROM platform_user_roles`,
    [],
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    role: row.role,
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
    throw new Error('User not found');
  }
}

export function isConfiguredPlatformAdminEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  return configuredPlatformAdminEmails().includes(normalized);
}

export async function hasPlatformRole(userId: string, roles: PlatformRole[]) {
  const result = await query(
    `SELECT 1
     FROM platform_user_roles
     WHERE user_id = $1
       AND role = ANY($2::text[])
     LIMIT 1`,
    [userId, roles],
  );
  return result.rows.length > 0;
}

export async function isPlatformAdmin(userId: string) {
  return hasPlatformRole(userId, ['super_admin', 'workspace_admin', 'model_admin']);
}

export async function listPlatformRoleAssignments() {
  const result = await query(
    `SELECT
        pur.user_id,
        pur.role,
        pur.source,
        pur.assigned_by,
        pur.metadata,
        pur.created_at,
        pur.updated_at,
        u.name AS user_name,
        u.email AS user_email,
        u.avatar_url
     FROM platform_user_roles pur
     JOIN users u ON u.id = pur.user_id
     ORDER BY pur.role ASC, pur.created_at ASC`,
    [],
  );

  return result.rows.map((row) => ({
    userId: row.user_id,
    role: row.role as PlatformRole,
    source: row.source,
    assignedBy: row.assigned_by ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    userName: row.user_name,
    userEmail: row.user_email,
    avatarUrl: row.avatar_url ?? null,
  }));
}

export async function assignPlatformRole(input: {
  userId: string;
  role: PlatformRole;
  assignedBy: string;
  metadata?: Record<string, unknown>;
}) {
  await ensureUserExists(input.userId);

  const result = await query(
    `INSERT INTO platform_user_roles (user_id, role, source, assigned_by, metadata)
     VALUES ($1, $2, 'manual', $3, $4::jsonb)
     ON CONFLICT (user_id, role) DO NOTHING
     RETURNING *`,
    [input.userId, input.role, input.assignedBy, JSON.stringify(input.metadata || {})],
  );

  if (result.rows.length === 0) {
    throw new Error('Role already assigned');
  }

  const authzEntryIds = await enqueueAuthzRelationships(
    [touchRelation('platform', AUTHZ_PLATFORM_ID, input.role, 'user', input.userId)],
    {
      source: 'platform_role.assign',
      userId: input.userId,
      role: input.role,
      assignedBy: input.assignedBy,
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, 'platform_role.assign');

  return {
    userId: result.rows[0].user_id,
    role: result.rows[0].role as PlatformRole,
    source: result.rows[0].source,
    assignedBy: result.rows[0].assigned_by ?? null,
    metadata: result.rows[0].metadata ?? {},
    createdAt: result.rows[0].created_at,
    updatedAt: result.rows[0].updated_at,
  };
}

export async function ensureSeedPlatformAdminForUser(user: UserIdentity) {
  await query(
    `INSERT INTO platform_user_roles (user_id, role, source, assigned_by, metadata)
     VALUES ($1, 'super_admin', 'manual', NULL, $2::jsonb)
     ON CONFLICT (user_id, role) DO NOTHING`,
    [user.id, JSON.stringify({ source: 'db.seed', email: user.email })],
  );

  const authzEntryIds = await enqueueAuthzRelationships(
    buildPlatformRoleRelations([{ userId: user.id, role: 'super_admin' }]),
    {
      source: 'platform_admin.seed',
      userId: user.id,
      email: user.email,
      role: 'super_admin',
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, 'platform_admin.seed');

  return true;
}

export async function revokePlatformRole(userId: string, role: PlatformRole) {
  const existing = await query(
    `SELECT source
     FROM platform_user_roles
     WHERE user_id = $1
       AND role = $2
     LIMIT 1`,
    [userId, role],
  );

  if (existing.rows.length === 0) {
    throw new Error('Role not found');
  }

  if (existing.rows[0].source === 'config') {
    throw new Error('Config-managed role cannot be revoked manually');
  }

  await query(
    `DELETE FROM platform_user_roles
     WHERE user_id = $1
       AND role = $2`,
    [userId, role],
  );

  const authzEntryIds = await enqueueAuthzRelationships(
    [deleteRelation('platform', AUTHZ_PLATFORM_ID, role, 'user', userId)],
    {
      source: 'platform_role.revoke',
      userId,
      role,
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, 'platform_role.revoke');
}

export async function ensureConfiguredPlatformAdminForUser(user: UserIdentity) {
  if (!isConfiguredPlatformAdminEmail(user.email)) {
    return false;
  }

  await query(
    `INSERT INTO platform_user_roles (user_id, role, source, assigned_by, metadata)
     VALUES ($1, 'super_admin', 'config', NULL, '{}'::jsonb)
     ON CONFLICT (user_id, role) DO NOTHING`,
    [user.id],
  );

  const authzEntryIds = await enqueueAuthzRelationships(
    buildPlatformRoleRelations([{ userId: user.id, role: 'super_admin' }]),
    {
      source: 'platform_admin.ensure',
      userId: user.id,
      email: user.email,
      role: 'super_admin',
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, 'platform_admin.ensure');

  return true;
}

export async function syncConfiguredPlatformAdmins() {
  const emails = configuredPlatformAdminEmails();
  const previousRoles = await listPlatformRoles();

  const matchedUsersResult = emails.length > 0
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
        `DELETE FROM platform_user_roles
         WHERE source = 'config'
           AND role = 'super_admin'`,
        [],
      );
      return;
    }

    await client.query(
      `DELETE FROM platform_user_roles
       WHERE source = 'config'
         AND role = 'super_admin'
         AND user_id <> ALL($1::uuid[])`,
      [matchedUserIds],
    );
    await client.query(
      `INSERT INTO platform_user_roles (user_id, role, source, assigned_by, metadata)
       SELECT UNNEST($1::uuid[]), 'super_admin', 'config', NULL, '{}'::jsonb
       ON CONFLICT (user_id, role) DO NOTHING`,
      [matchedUserIds],
    );
  });

  const nextRoles = await listPlatformRoles();

  const authzEntryIds = await enqueueAuthzRelationships(
    diffAuthzRelationships(
      buildPlatformRoleRelations(previousRoles),
      buildPlatformRoleRelations(nextRoles),
    ),
    {
      source: 'platform_admin.sync',
      configuredEmailCount: emails.length,
      matchedUserCount: matchedUserIds.length,
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, 'platform_admin.sync');

  return {
    configuredEmailCount: emails.length,
    matchedUserCount: matchedUserIds.length,
    platformAdminCount: nextRoles.filter((row) => row.role === 'super_admin').length,
  };
}
