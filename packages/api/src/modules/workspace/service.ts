import crypto from 'node:crypto';
import type pg from 'pg';
import { query, transaction } from '../../infrastructure/database/index.js';
import {
  AUTHZ_PLATFORM_ID,
  authzEnabled,
  deleteRelation,
  flushAuthzOutboxEntries,
  lookupResources,
  queueAuthzRelationships,
  touchRelation,
} from '../../infrastructure/authz/index.js';
import {
  normalizeActorDocs,
  SECRETARY_DEFAULT_DOCS,
} from '@synapse/shared';

export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  userId: string;
}

export interface AddMemberInput {
  workspaceId: string;
  userId: string;
  trustLevel: 'admin' | 'member' | 'guest';
}

export type WorkspaceSupplementalRole =
  | 'model_admin'
  | 'actor_admin'
  | 'capability_admin'
  | 'memory_admin'
  | 'relay_admin'
  | 'conversation_admin';

function workspaceRelationFromTrustLevel(trustLevel: 'owner' | 'admin' | 'member' | 'guest') {
  return trustLevel;
}

async function flushQueuedAuthzEntries(entryIds: string[], source: string) {
  if (!authzEnabled() || entryIds.length === 0) return;

  try {
    await flushAuthzOutboxEntries(entryIds);
  } catch (error) {
    console.error(`[authz] Failed to flush ${source} relationship updates:`, error);
  }
}

function generateSlug(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const suffix = crypto.randomBytes(4).toString('hex');
  return `${base}-${suffix}`;
}

async function insertDefaultActorGrants(
  queryable: Pick<pg.PoolClient, 'query'>,
  actorId: string,
  workspaceId: string,
  grantedBy?: string | null,
) {
  await queryable.query(
    `INSERT INTO actor_grants (
       actor_id,
       permission,
       grant_scope,
       workspace_id,
       status,
       granted_by,
       metadata
     )
     VALUES
       ($1, 'discover', 'workspace', $2, 'active', $3, '{}'::jsonb),
       ($1, 'invoke', 'workspace', $2, 'active', $3, '{}'::jsonb)`,
    [actorId, workspaceId, grantedBy ?? null],
  );
}

export async function createWorkspace(input: CreateWorkspaceInput) {
  const slug = generateSlug(input.name);

  const result = await transaction(async (client: pg.PoolClient) => {
    // 1. Create workspace
    const wsResult = await client.query(
      `INSERT INTO workspaces (name, slug, description, owner_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.name, slug, input.description ?? null, input.userId]
    );
    const workspace = wsResult.rows[0];

    // 2. Add creator as owner member
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, trust_level)
       VALUES ($1, $2, 'owner')`,
      [workspace.id, input.userId]
    );

    // 3. Auto-create secretary actor
    const secretaryDocs = SECRETARY_DEFAULT_DOCS;
    const secretaryResult = await client.query(
      `INSERT INTO actors (
         workspace_id, name, role, title, can_represent_user, docs, parent_id, capabilities, current_version
       )
       VALUES ($1, $2, $3, $4, false, $5, $6, $7, 1)
       RETURNING *`,
      [
        workspace.id,
        'Secretary',
        'secretary',
        'Personal Secretary',
        JSON.stringify(secretaryDocs),
        null,
        ['delegation', 'reporting', 'organization'],
      ]
    );
    const secretary = secretaryResult.rows[0];

    // 4. Create initial actor_versions record for secretary
    await client.query(
      `INSERT INTO actor_versions (
         actor_id, version, name, role, title, avatar_file_id, parent_id, can_represent_user, docs,
         config, capabilities
       )
       VALUES ($1, 1, $2, $3, $4, NULL, NULL, false, $5, '{}', $6)`,
      [
        secretary.id,
        secretary.name,
        secretary.role,
        secretary.title,
        JSON.stringify(secretaryDocs),
        secretary.capabilities,
      ]
    );

    await insertDefaultActorGrants(client, secretary.id, workspace.id, input.userId);

    const authzEntryIds = await queueAuthzRelationships(
      client,
      [
        touchRelation('platform', AUTHZ_PLATFORM_ID, 'workspace', 'workspace', workspace.id),
        touchRelation('workspace', workspace.id, 'platform', 'platform', AUTHZ_PLATFORM_ID),
        touchRelation(
          'workspace',
          workspace.id,
          workspaceRelationFromTrustLevel('owner'),
          'user',
          input.userId,
        ),
        touchRelation('workspace', workspace.id, 'actor', 'actor', secretary.id),
        touchRelation('actor', secretary.id, 'workspace', 'workspace', workspace.id),
        touchRelation('actor', secretary.id, 'discover_workspace', 'workspace', workspace.id),
        touchRelation('actor', secretary.id, 'invoke_workspace', 'workspace', workspace.id),
      ],
      {
        source: 'workspace.create',
        workspaceId: workspace.id,
        userId: input.userId,
      },
    );

    return {
      workspace: mapWorkspaceRow(workspace),
      secretary: mapActorRow(secretary),
      authzEntryIds,
    };
  });

  await flushQueuedAuthzEntries(result.authzEntryIds, 'workspace.create');

  return {
    ...result.workspace,
    secretary: result.secretary,
  };
}

export async function listUserWorkspaces(userId: string) {
  if (authzEnabled()) {
    const workspaceIds = await lookupResources({
      resourceType: 'workspace',
      permission: 'view',
      subject: { type: 'user', id: userId },
    });

    if (workspaceIds.length === 0) {
      return [];
    }

    const result = await query(
      `SELECT w.*, wm.trust_level
       FROM workspaces w
       LEFT JOIN workspace_members wm
         ON wm.workspace_id = w.id
        AND wm.user_id = $1
       WHERE w.id = ANY($2)
       ORDER BY w.created_at DESC`,
      [userId, workspaceIds]
    );

    return result.rows.map((row) => ({
      ...mapWorkspaceRow(row),
      trustLevel: row.trust_level ?? null,
    }));
  }

  const result = await query(
    `SELECT w.*, wm.trust_level
     FROM workspaces w
     INNER JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE wm.user_id = $1
     ORDER BY w.created_at DESC`,
    [userId]
  );
  return result.rows.map((row) => ({
    ...mapWorkspaceRow(row),
    trustLevel: row.trust_level,
  }));
}

export async function getWorkspaceById(workspaceId: string) {
  const result = await query('SELECT * FROM workspaces WHERE id = $1', [
    workspaceId,
  ]);
  return result.rows.length > 0 ? mapWorkspaceRow(result.rows[0]) : null;
}

export async function updateWorkspace(
  workspaceId: string,
  updates: { name?: string; description?: string }
) {
  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (updates.name !== undefined) {
    fields.push(`name = $${idx++}`);
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push(`description = $${idx++}`);
    values.push(updates.description);
  }

  if (fields.length === 0) {
    return getWorkspaceById(workspaceId);
  }

  values.push(workspaceId);
  const result = await query(
    `UPDATE workspaces SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return result.rows.length > 0 ? mapWorkspaceRow(result.rows[0]) : null;
}

export async function checkMembership(workspaceId: string, userId: string) {
  const result = await query(
    'SELECT trust_level FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId]
  );
  return result.rows.length > 0 ? (result.rows[0].trust_level as string) : null;
}

export async function addMember(input: AddMemberInput) {
  const result = await transaction(async (client: pg.PoolClient) => {
    const memberResult = await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, trust_level)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO NOTHING
       RETURNING *`,
      [input.workspaceId, input.userId, input.trustLevel]
    );

    if (memberResult.rows.length === 0) {
      return null;
    }

    const authzEntryIds = await queueAuthzRelationships(
      client,
      [
        touchRelation(
          'workspace',
          input.workspaceId,
          workspaceRelationFromTrustLevel(input.trustLevel),
          'user',
          input.userId,
        ),
      ],
      {
        source: 'workspace.add_member',
        workspaceId: input.workspaceId,
        userId: input.userId,
        trustLevel: input.trustLevel,
      },
    );

    return {
      member: mapMemberRow(memberResult.rows[0]),
      authzEntryIds,
    };
  });

  if (!result) {
    return null;
  }

  await flushQueuedAuthzEntries(result.authzEntryIds, 'workspace.add_member');
  return result.member;
}

export async function listMembers(workspaceId: string) {
  const result = await query(
    `SELECT
        wm.*,
        u.name AS user_name,
        u.email AS user_email,
        u.avatar_url,
        COALESCE(role_map.roles, '{}'::text[]) AS roles
     FROM workspace_members wm
     INNER JOIN users u ON u.id = wm.user_id
     LEFT JOIN (
       SELECT workspace_id, user_id, ARRAY_AGG(role ORDER BY role) AS roles
       FROM workspace_member_roles
       GROUP BY workspace_id, user_id
     ) role_map
       ON role_map.workspace_id = wm.workspace_id
      AND role_map.user_id = wm.user_id
     WHERE wm.workspace_id = $1
     ORDER BY wm.joined_at ASC`,
    [workspaceId]
  );
  return result.rows.map((row) => ({
    ...mapMemberRow(row),
    userName: row.user_name,
    userEmail: row.user_email,
    avatarUrl: row.avatar_url ?? null,
    roles: Array.isArray(row.roles) ? row.roles : [],
  }));
}

export async function listWorkspaceRoleAssignments(workspaceId: string) {
  const result = await query(
    `SELECT
        wmr.workspace_id,
        wmr.user_id,
        wmr.role,
        wmr.assigned_by,
        wmr.metadata,
        wmr.created_at,
        wmr.updated_at,
        u.name AS user_name,
        u.email AS user_email,
        u.avatar_url,
        wm.trust_level
     FROM workspace_member_roles wmr
     JOIN users u ON u.id = wmr.user_id
     JOIN workspace_members wm
       ON wm.workspace_id = wmr.workspace_id
      AND wm.user_id = wmr.user_id
     WHERE wmr.workspace_id = $1
     ORDER BY wmr.role ASC, wmr.created_at ASC`,
    [workspaceId],
  );

  return result.rows.map((row) => ({
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role as WorkspaceSupplementalRole,
    assignedBy: row.assigned_by ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trustLevel: row.trust_level,
    userName: row.user_name,
    userEmail: row.user_email,
    avatarUrl: row.avatar_url ?? null,
  }));
}

export async function assignWorkspaceRole(input: {
  workspaceId: string;
  userId: string;
  role: WorkspaceSupplementalRole;
  assignedBy: string;
  metadata?: Record<string, unknown>;
}) {
  const membership = await query(
    `SELECT 1
     FROM workspace_members
     WHERE workspace_id = $1
       AND user_id = $2
     LIMIT 1`,
    [input.workspaceId, input.userId],
  );

  if (membership.rows.length === 0) {
    throw new Error('User is not a member of this workspace');
  }

  const result = await query(
    `INSERT INTO workspace_member_roles (workspace_id, user_id, role, assigned_by, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (workspace_id, user_id, role) DO NOTHING
     RETURNING *`,
    [
      input.workspaceId,
      input.userId,
      input.role,
      input.assignedBy,
      JSON.stringify(input.metadata || {}),
    ],
  );

  if (result.rows.length === 0) {
    throw new Error('Role already assigned');
  }

  const authzEntryIds = await queueRoleRelation({
    operation: 'touch',
    workspaceId: input.workspaceId,
    userId: input.userId,
    role: input.role,
    source: 'workspace.role.assign',
    metadata: {
      assignedBy: input.assignedBy,
      ...input.metadata,
    },
  });
  await flushQueuedAuthzEntries(authzEntryIds, 'workspace.role.assign');

  return {
    workspaceId: result.rows[0].workspace_id,
    userId: result.rows[0].user_id,
    role: result.rows[0].role as WorkspaceSupplementalRole,
    assignedBy: result.rows[0].assigned_by ?? null,
    metadata: result.rows[0].metadata ?? {},
    createdAt: result.rows[0].created_at,
    updatedAt: result.rows[0].updated_at,
  };
}

export async function revokeWorkspaceRole(workspaceId: string, userId: string, role: WorkspaceSupplementalRole) {
  const result = await query(
    `DELETE FROM workspace_member_roles
     WHERE workspace_id = $1
       AND user_id = $2
       AND role = $3
     RETURNING workspace_id, user_id, role`,
    [workspaceId, userId, role],
  );

  if (result.rows.length === 0) {
    throw new Error('Role not found');
  }

  const authzEntryIds = await queueRoleRelation({
    operation: 'delete',
    workspaceId,
    userId,
    role,
    source: 'workspace.role.revoke',
  });
  await flushQueuedAuthzEntries(authzEntryIds, 'workspace.role.revoke');
}

// ── Row mappers ──

function mapWorkspaceRow(row: any) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapActorRow(row: any) {
  const docs = normalizeActorDocs(
    typeof row.docs === 'string' ? JSON.parse(row.docs) : (row.docs || []),
  );
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    definition: {
      name: row.name,
      role: row.role,
      title: row.title,
      avatarFileId: row.avatar_file_id ?? undefined,
      parentId: row.parent_id ?? undefined,
      canRepresentUser: Boolean(row.can_represent_user),
      docs,
      capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
      config: row.config ? (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) : {},
    },
    currentVersion: Number(row.current_version || 1),
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMemberRow(row: any) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    trustLevel: row.trust_level,
    roles: Array.isArray(row.roles) ? row.roles : [],
    joinedAt: row.joined_at,
  };
}

async function queueRoleRelation(input: {
  operation: 'touch' | 'delete';
  workspaceId: string;
  userId: string;
  role: WorkspaceSupplementalRole;
  source: string;
  metadata?: Record<string, unknown>;
}) {
  return transaction(async (client: pg.PoolClient) => queueAuthzRelationships(
    client,
    [
      input.operation === 'touch'
        ? touchRelation('workspace', input.workspaceId, input.role, 'user', input.userId)
        : deleteRelation('workspace', input.workspaceId, input.role, 'user', input.userId),
    ],
    {
      source: input.source,
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      ...(input.metadata || {}),
    },
  ));
}
