import crypto from "node:crypto"
import type pg from "pg"
import type { WorkspaceInvitesTrustLevel } from "../../infrastructure/database/generated/db.js"
import { query, transaction } from "../../infrastructure/database/index.js"
import {
  db,
  executeCompiledQuery,
  executeTakeFirst,
} from "../../infrastructure/database/kysely.js"
import { sql } from "kysely"
import { assignOfficialChiefActorPreference } from "./service.js"

// ── Token generation ──

export function generateInviteToken(): string {
  return crypto.randomBytes(6).toString("base64url").slice(0, 8)
}

// ── Row mapper ──

function mapInviteRow(row: any) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    token: row.token,
    createdByWorkspaceMemberId: row.created_by_workspace_member_id,
    trustLevel: row.trust_level,
    maxUses: row.max_uses ?? null,
    useCount: row.use_count,
    expiresAt: row.expires_at ?? null,
    isRevoked: row.is_revoked,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    workspaceName: row.workspace_name ?? undefined,
  }
}

// ── CRUD ──

export async function createInvite(input: {
  workspaceId: string
  createdByWorkspaceMemberId: string
  trustLevel?: WorkspaceInvitesTrustLevel
  maxUses?: number
  expiresAt?: string
}) {
  const token = generateInviteToken()
  const row = await db
    .insertInto("workspace_invites")
    .values({
      workspace_id: input.workspaceId,
      token,
      created_by_workspace_member_id: input.createdByWorkspaceMemberId,
      trust_level: input.trustLevel || "member",
      max_uses: input.maxUses ?? null,
      expires_at: input.expiresAt ?? null,
    })
    .returningAll()
    .executeTakeFirst()
  return mapInviteRow(row)
}

export async function getInviteByToken(token: string) {
  const row = await db
    .selectFrom("workspace_invites as wi")
    .innerJoin("workspaces as w", "w.id", "wi.workspace_id")
    .selectAll("wi")
    .select("w.name as workspace_name")
    .where("wi.token", "=", token)
    .executeTakeFirst()
  return row ? mapInviteRow(row) : null
}

export async function redeemInvite(token: string, userId: string) {
  const result = await transaction(async (client: pg.PoolClient) => {
    const runner = { query: client.query.bind(client) as typeof query }
    // Lock the invite row
    const invite = await executeTakeFirst<any>(
      runner,
      db
        .selectFrom("workspace_invites")
        .selectAll()
        .where("token", "=", token)
        .forUpdate()
    )
    if (!invite) {
      throw new Error("Invite not found")
    }

    const workspace = await executeTakeFirst<{ name: string }>(
      runner,
      db
        .selectFrom("workspaces")
        .select("name")
        .where("id", "=", invite.workspace_id)
    )

    if (invite.is_revoked) {
      throw new Error("Invite has been revoked")
    }
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      throw new Error("Invite has expired")
    }
    if (invite.max_uses !== null && invite.use_count >= invite.max_uses) {
      throw new Error("Invite has reached maximum uses")
    }

    // Check if already a member
    const memberCheck = await executeTakeFirst<{ id: string }>(
      runner,
      db
        .selectFrom("workspace_members")
        .select("id")
        .where("workspace_id", "=", invite.workspace_id)
        .where("user_id", "=", userId)
    )
    if (memberCheck) {
      throw new Error("Already a member of this workspace")
    }

    // Add as member
    const memberRow = await executeTakeFirst<{ id: string }>(
      runner,
      db
        .insertInto("workspace_members")
        .values({
          workspace_id: invite.workspace_id,
          user_id: userId,
          trust_level: invite.trust_level,
        })
        .returning("id")
    )
    if (!memberRow) {
      throw new Error("Failed to create workspace member")
    }

    await assignOfficialChiefActorPreference(
      client,
      invite.workspace_id,
      memberRow.id
    )

    // Increment use count
    await executeCompiledQuery(
      runner,
      db
        .updateTable("workspace_invites")
        .set({
          use_count: sql`use_count + 1`,
        })
        .where("id", "=", invite.id)
    )

    return {
      workspaceId: invite.workspace_id,
      workspaceName: workspace?.name,
      trustLevel: invite.trust_level,
    }
  })

  return {
    workspaceId: result.workspaceId,
    workspaceName: result.workspaceName,
    trustLevel: result.trustLevel,
  }
}

export async function listWorkspaceInvites(workspaceId: string) {
  const rows = await db
    .selectFrom("workspace_invites")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("is_revoked", "=", false)
    .orderBy("created_at", "desc")
    .execute()
  return rows.map(mapInviteRow)
}

export async function revokeInvite(inviteId: string, workspaceId: string) {
  const row = await db
    .updateTable("workspace_invites")
    .set({
      is_revoked: true,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", inviteId)
    .where("workspace_id", "=", workspaceId)
    .returningAll()
    .executeTakeFirst()
  return row ? mapInviteRow(row) : null
}
