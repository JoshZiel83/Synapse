import crypto from 'node:crypto';
import type pg from 'pg';
import { query, transaction } from '../../infrastructure/database/index.js';
import {
  SECRETARY_DEFAULT_CHARTER,
  SECRETARY_DEFAULT_SYSTEM_PROMPT,
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

export async function createWorkspace(input: CreateWorkspaceInput) {
  const slug = generateSlug(input.name);

  return transaction(async (client: pg.PoolClient) => {
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
    const secretaryResult = await client.query(
      `INSERT INTO actors (workspace_id, name, role, title, charter, system_prompt, parent_id, capabilities)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        workspace.id,
        'Secretary',
        'secretary',
        'Personal Secretary',
        SECRETARY_DEFAULT_CHARTER,
        SECRETARY_DEFAULT_SYSTEM_PROMPT,
        null,
        ['delegation', 'reporting', 'organization'],
      ]
    );
    const secretary = secretaryResult.rows[0];

    return {
      ...mapWorkspaceRow(workspace),
      secretary: mapActorRow(secretary),
    };
  });
}

export async function listUserWorkspaces(userId: string) {
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
  const result = await query(
    `INSERT INTO workspace_members (workspace_id, user_id, trust_level)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, user_id) DO NOTHING
     RETURNING *`,
    [input.workspaceId, input.userId, input.trustLevel]
  );
  if (result.rows.length === 0) {
    return null; // Already a member
  }
  return mapMemberRow(result.rows[0]);
}

export async function listMembers(workspaceId: string) {
  const result = await query(
    `SELECT wm.*, u.name AS user_name, u.email AS user_email, u.avatar_url
     FROM workspace_members wm
     INNER JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = $1
     ORDER BY wm.joined_at ASC`,
    [workspaceId]
  );
  return result.rows.map((row) => ({
    ...mapMemberRow(row),
    userName: row.user_name,
    userEmail: row.user_email,
    avatarUrl: row.avatar_url ?? null,
  }));
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
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    role: row.role,
    title: row.title,
    charter: row.charter,
    systemPrompt: row.system_prompt,
    parentId: row.parent_id ?? null,
    capabilities: row.capabilities ?? [],
    config: row.config ?? {},
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
    joinedAt: row.joined_at,
  };
}
