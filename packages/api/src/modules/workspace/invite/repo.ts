import crypto from "node:crypto"
import { sql } from "kysely"
import type { WorkspaceInvitesTrustLevel } from "../../../infrastructure/database/generated/db.js"
import {
  db,
  withDbTransaction,
  type TableRow,
} from "../../../infrastructure/database/kysely.js"
import { parseInstantString } from "../../../infrastructure/datetime.js"
import type { Timestamp } from "@synapse/shared"
import { assignOfficialChiefActorPreference } from "../service.js"

/**
 * Invite data-access layer. The ONLY invite file allowed to touch
 * `generated/db` / `TableRow` / SQL (guard-layering r1/r2/r4). Returns DB
 * records (camelCase, Date instants) — the presenter turns these into the
 * app-facing `WorkspaceInviteView`.
 */

export type WorkspaceInviteRecord = TableRow<"workspaceInvites">

export type WorkspaceInviteWithWorkspaceNameRecord = WorkspaceInviteRecord & {
  workspaceName: string | null
}

export function generateInviteToken(): string {
  return crypto.randomBytes(6).toString("base64url").slice(0, 8)
}

export async function insertInvite(input: {
  workspaceId: string
  createdByWorkspaceMemberId: string
  trustLevel?: WorkspaceInvitesTrustLevel
  maxUses?: number
  expiresAt?: Timestamp
}): Promise<WorkspaceInviteRecord | undefined> {
  return db
    .insertInto("workspaceInvites")
    .values({
      workspaceId: input.workspaceId,
      token: generateInviteToken(),
      createdByWorkspaceMemberId: input.createdByWorkspaceMemberId,
      trustLevel: input.trustLevel || "member",
      maxUses: input.maxUses ?? null,
      expiresAt: input.expiresAt ? parseInstantString(input.expiresAt) : null,
    })
    .returningAll()
    .executeTakeFirst()
}

export async function findInviteWithWorkspaceName(
  token: string
): Promise<WorkspaceInviteWithWorkspaceNameRecord | undefined> {
  return db
    .selectFrom("workspaceInvites as wi")
    .innerJoin("workspaces as w", "w.id", "wi.workspaceId")
    .selectAll("wi")
    .select("w.name as workspaceName")
    .where("wi.token", "=", token)
    .executeTakeFirst()
}

export async function listActiveInvitesByWorkspace(
  workspaceId: string
): Promise<WorkspaceInviteRecord[]> {
  return db
    .selectFrom("workspaceInvites")
    .selectAll()
    .where("workspaceId", "=", workspaceId)
    .where("isRevoked", "=", false)
    .orderBy("createdAt", "desc")
    .execute()
}

export async function updateInviteRevoked(
  inviteId: string,
  workspaceId: string
): Promise<WorkspaceInviteRecord | undefined> {
  return db
    .updateTable("workspaceInvites")
    .set({ isRevoked: true })
    .where("id", "=", inviteId)
    .where("workspaceId", "=", workspaceId)
    .returningAll()
    .executeTakeFirst()
}

/**
 * Transactional redeem: locks the invite, validates liveness, adds the member,
 * assigns the official chief actor preference, and bumps the use count.
 * Returns the joined workspace id/name + granted trust level.
 */
export async function redeemInviteTx(
  token: string,
  userId: string
): Promise<{
  workspaceId: string
  workspaceName: string | null
  trustLevel: WorkspaceInvitesTrustLevel
}> {
  return withDbTransaction(async (trx) => {
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

    const memberCheck = await trx
      .selectFrom("workspaceMembers")
      .select("id")
      .where("workspaceId", "=", invite.workspaceId)
      .where("userId", "=", userId)
      .executeTakeFirst()
    if (memberCheck) {
      throw new Error("Already a member of this workspace")
    }

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

    await trx
      .updateTable("workspaceInvites")
      .set({ useCount: sql`use_count + 1` })
      .where("id", "=", invite.id)
      .execute()

    return {
      workspaceId: invite.workspaceId,
      workspaceName: workspace?.name ?? null,
      trustLevel: invite.trustLevel,
    }
  })
}
