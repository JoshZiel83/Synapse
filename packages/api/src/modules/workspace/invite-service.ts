import crypto from 'node:crypto';
import type pg from 'pg';
import { query, transaction } from '../../infrastructure/database/index.js';
import {
  authzEnabled,
  flushAuthzOutboxEntries,
  queueAuthzRelationships,
  touchRelation,
} from '../../infrastructure/authz/index.js';

// ── Token generation ──

export function generateInviteToken(): string {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

// ── Row mapper ──

function mapInviteRow(row: any) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    token: row.token,
    createdBy: row.created_by,
    trustLevel: row.trust_level,
    maxUses: row.max_uses ?? null,
    useCount: row.use_count,
    expiresAt: row.expires_at ?? null,
    isRevoked: row.is_revoked,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    workspaceName: row.workspace_name ?? undefined,
  };
}

// ── CRUD ──

export async function createInvite(input: {
  workspaceId: string;
  createdBy: string;
  trustLevel?: string;
  maxUses?: number;
  expiresAt?: string;
}) {
  const token = generateInviteToken();
  const result = await query(
    `INSERT INTO workspace_invites (workspace_id, token, created_by, trust_level, max_uses, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.workspaceId,
      token,
      input.createdBy,
      input.trustLevel || 'member',
      input.maxUses ?? null,
      input.expiresAt ?? null,
    ]
  );
  return mapInviteRow(result.rows[0]);
}

export async function getInviteByToken(token: string) {
  const result = await query(
    `SELECT wi.*, w.name AS workspace_name
     FROM workspace_invites wi
     JOIN workspaces w ON w.id = wi.workspace_id
     WHERE wi.token = $1`,
    [token]
  );
  return result.rows.length > 0 ? mapInviteRow(result.rows[0]) : null;
}

export async function redeemInvite(token: string, userId: string) {
  const result = await transaction(async (client: pg.PoolClient) => {
    // Lock the invite row
    const inviteRes = await client.query(
      `SELECT wi.*, w.name AS workspace_name
       FROM workspace_invites wi
       JOIN workspaces w ON w.id = wi.workspace_id
       WHERE wi.token = $1
       FOR UPDATE OF wi`,
      [token]
    );

    if (inviteRes.rows.length === 0) {
      throw new Error('Invite not found');
    }

    const invite = inviteRes.rows[0];

    if (invite.is_revoked) {
      throw new Error('Invite has been revoked');
    }
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      throw new Error('Invite has expired');
    }
    if (invite.max_uses !== null && invite.use_count >= invite.max_uses) {
      throw new Error('Invite has reached maximum uses');
    }

    // Check if already a member
    const memberCheck = await client.query(
      'SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [invite.workspace_id, userId]
    );
    if (memberCheck.rows.length > 0) {
      throw new Error('Already a member of this workspace');
    }

    // Add as member
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, trust_level)
       VALUES ($1, $2, $3)`,
      [invite.workspace_id, userId, invite.trust_level]
    );

    // Increment use count
    await client.query(
      'UPDATE workspace_invites SET use_count = use_count + 1 WHERE id = $1',
      [invite.id]
    );

    const authzEntryIds = await queueAuthzRelationships(
      client,
      [
        touchRelation('workspace', invite.workspace_id, invite.trust_level, 'user', userId),
      ],
      {
        source: 'workspace.redeem_invite',
        workspaceId: invite.workspace_id,
        userId,
        trustLevel: invite.trust_level,
      },
    );

    return {
      workspaceId: invite.workspace_id,
      workspaceName: invite.workspace_name,
      trustLevel: invite.trust_level,
      authzEntryIds,
    };
  });

  if (authzEnabled() && result.authzEntryIds.length > 0) {
    try {
      await flushAuthzOutboxEntries(result.authzEntryIds);
    } catch (error) {
      console.error('[authz] Failed to flush workspace.redeem_invite relationship updates:', error);
    }
  }

  return {
    workspaceId: result.workspaceId,
    workspaceName: result.workspaceName,
    trustLevel: result.trustLevel,
  };
}

export async function listWorkspaceInvites(workspaceId: string) {
  const result = await query(
    `SELECT * FROM workspace_invites
     WHERE workspace_id = $1 AND is_revoked = FALSE
     ORDER BY created_at DESC`,
    [workspaceId]
  );
  return result.rows.map(mapInviteRow);
}

export async function revokeInvite(inviteId: string, workspaceId: string) {
  const result = await query(
    `UPDATE workspace_invites
     SET is_revoked = TRUE
     WHERE id = $1 AND workspace_id = $2
     RETURNING *`,
    [inviteId, workspaceId]
  );
  return result.rows.length > 0 ? mapInviteRow(result.rows[0]) : null;
}
