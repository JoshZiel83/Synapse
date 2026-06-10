import crypto from "node:crypto"
import type { Timestamp } from "@synapse/shared"
import type { WorkspaceInvitesTrustLevel } from "../../infrastructure/database/generated/db.js"
import {
  db,
  withDbTransaction,
  type TableRow,
} from "../../infrastructure/database/kysely.js"
import { parseInstantString } from "../../infrastructure/datetime.js"
import { sql } from "kysely"
import { assignOfficialChiefActorPreference } from "./service.js"

// ── Token generation ──

export function generateInviteToken(): string {
  return crypto.randomBytes(6).toString("base64url").slice(0, 8)
}

// ── Row mapper ──

type InviteRow = TableRow<"workspaceInvites"> & {
  workspaceName?: string | null
}

function mapInviteRow(row: InviteRow | undefined | null) {
  if (!row) return null
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    token: row.token,
    createdByWorkspaceMemberId: row.createdByWorkspaceMemberId,
    trustLevel: row.trustLevel,
    maxUses: row.maxUses ?? null,
    useCount: row.useCount,
    expiresAt: row.expiresAt ?? null,
    isRevoked: row.isRevoked,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    workspaceName: row.workspaceName ?? undefined,
  }
}

// ── CRUD ──

export async function createInvite(input: {
  workspaceId: string
  createdByWorkspaceMemberId: string
  trustLevel?: WorkspaceInvitesTrustLevel
  maxUses?: number
  expiresAt?: Timestamp
}) {
  const token = generateInviteToken()
  const row = await db
    .insertInto("workspaceInvites")
    .values({
      workspaceId: input.workspaceId,
      token,
      createdByWorkspaceMemberId: input.createdByWorkspaceMemberId,
      trustLevel: input.trustLevel || "member",
      maxUses: input.maxUses ?? null,
      expiresAt: input.expiresAt ? parseInstantString(input.expiresAt) : null,
    })
    .returningAll()
    .executeTakeFirst()
  return mapInviteRow(row)
}

export async function getInviteByToken(token: string) {
  const row = await db
    .selectFrom("workspaceInvites as wi")
    .innerJoin("workspaces as w", "w.id", "wi.workspaceId")
    .selectAll("wi")
    .select("w.name as workspaceName")
    .where("wi.token", "=", token)
    .executeTakeFirst()
  return row ? mapInviteRow(row) : null
}

export async function redeemInvite(token: string, userId: string) {
  const result = await withDbTransaction(async (trx) => {
    // Lock the invite row
    const invite = await trx
      .selectFrom("workspaceInvites")
      .selectAll()
      .where("token", "=", token)
      .forUpdate()
      .executeTakeFirst()
    if (!invite) {
      throw new Error("Invite not found")
    }

    const workspace = await trx
      .selectFrom("workspaces")
      .select("name")
      .where("id", "=", invite.workspaceId)
      .executeTakeFirst()

    if (invite.isRevoked) {
      throw new Error("Invite has been revoked")
    }
    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
      throw new Error("Invite has expired")
    }
    if (invite.maxUses !== null && invite.useCount >= invite.maxUses) {
      throw new Error("Invite has reached maximum uses")
    }

    // Check if already a member
    const memberCheck = await trx
      .selectFrom("workspaceMembers")
      .select("id")
      .where("workspaceId", "=", invite.workspaceId)
      .where("userId", "=", userId)
      .executeTakeFirst()
    if (memberCheck) {
      throw new Error("Already a member of this workspace")
    }

    // Add as member
    const memberRow = await trx
      .insertInto("workspaceMembers")
      .values({
        workspaceId: invite.workspaceId,
        userId: userId,
        trustLevel: invite.trustLevel,
      })
      .returning("id")
      .executeTakeFirst()
    if (!memberRow) {
      throw new Error("Failed to create workspace member")
    }

    await assignOfficialChiefActorPreference(
      trx,
      invite.workspaceId,
      memberRow.id
    )

    // Increment use count
    await trx
      .updateTable("workspaceInvites")
      .set({
        useCount: sql`use_count + 1`,
      })
      .where("id", "=", invite.id)
      .execute()

    return {
      workspaceId: invite.workspaceId,
      workspaceName: workspace?.name,
      trustLevel: invite.trustLevel,
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
    .selectFrom("workspaceInvites")
    .selectAll()
    .where("workspaceId", "=", workspaceId)
    .where("isRevoked", "=", false)
    .orderBy("createdAt", "desc")
    .execute()
  return rows.map((row) => mapInviteRow(row)!)
}

export async function revokeInvite(inviteId: string, workspaceId: string) {
  const row = await db
    .updateTable("workspaceInvites")
    .set({
      isRevoked: true,
    })
    .where("id", "=", inviteId)
    .where("workspaceId", "=", workspaceId)
    .returningAll()
    .executeTakeFirst()
  return mapInviteRow(row)
}
