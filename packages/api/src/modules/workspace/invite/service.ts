import type { InviteTrustLevel } from "@synapse/shared"
import {
  findInviteWithWorkspaceName,
  insertInvite,
  listActiveInvitesByWorkspace,
  redeemInviteTx,
  updateInviteRevoked,
  type WorkspaceInviteRedeemRecord,
  type WorkspaceInviteRecord,
  type WorkspaceInviteWithWorkspaceNameRecord,
} from "./repo.js"

/**
 * Invite business layer. Orchestrates use-cases and returns internal records.
 * Data access + instant serialization stay in repo / presenter (guard-layering
 * keeps DB types and time encoding out of this layer). See master plan §8.
 */

export type InvitePublicLookup =
  | { ok: true; record: WorkspaceInviteWithWorkspaceNameRecord }
  | { ok: false; reason: "not_found" | "expired" | "max_uses" }

export async function createInvite(input: {
  workspaceId: string
  createdByWorkspaceMemberId: string
  trustLevel?: InviteTrustLevel
  maxUses?: number
  expiresAt?: import("@synapse/shared").Timestamp
}): Promise<WorkspaceInviteRecord | null> {
  return (await insertInvite(input)) ?? null
}

export async function listWorkspaceInvites(
  workspaceId: string
): Promise<WorkspaceInviteRecord[]> {
  return listActiveInvitesByWorkspace(workspaceId)
}

export async function revokeInvite(
  inviteId: string,
  workspaceId: string
): Promise<WorkspaceInviteRecord | null> {
  return (await updateInviteRevoked(inviteId, workspaceId)) ?? null
}

/**
 * Public (unauthenticated) invite info lookup. Validates liveness as a business
 * rule and returns a discriminated result the controller maps to HTTP status.
 */
export async function getPublicInviteInfo(
  token: string
): Promise<InvitePublicLookup> {
  const record = await findInviteWithWorkspaceName(token)
  if (!record || record.isRevoked) return { ok: false, reason: "not_found" }
  if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
    return { ok: false, reason: "expired" }
  }
  if (record.maxUses !== null && record.useCount >= record.maxUses) {
    return { ok: false, reason: "max_uses" }
  }
  return { ok: true, record }
}

export async function redeemInvite(
  token: string,
  userId: string
): Promise<WorkspaceInviteRedeemRecord> {
  return redeemInviteTx(token, userId)
}

// Re-export so existing in-module importers (e.g. service.ts seeding paths) keep
// a single entry point for the invite record type without reaching into repo.
export type { WorkspaceInviteRecord, WorkspaceInviteWithWorkspaceNameRecord }
