import type {
  InviteTrustLevel,
  WorkspaceInvitePublicView,
  WorkspaceInviteRedeemResult,
  WorkspaceInviteView,
} from "@synapse/shared"
import {
  presentWorkspaceInvite,
  presentWorkspaceInvitePublic,
} from "./presenter.js"
import {
  findInviteWithWorkspaceName,
  insertInvite,
  listActiveInvitesByWorkspace,
  redeemInviteTx,
  updateInviteRevoked,
  type WorkspaceInviteRecord,
} from "./repo.js"

/**
 * Invite business layer. Orchestrates use-cases and returns app-facing views.
 * Data access + instant serialization stay in repo / presenter (guard-layering
 * keeps DB types and time encoding out of this layer). See master plan §8.
 */

export type InvitePublicLookup =
  | { ok: true; view: WorkspaceInvitePublicView }
  | { ok: false; reason: "not_found" | "expired" | "max_uses" }

export async function createInvite(input: {
  workspaceId: string
  createdByWorkspaceMemberId: string
  trustLevel?: InviteTrustLevel
  maxUses?: number
  expiresAt?: import("@synapse/shared").Timestamp
}): Promise<WorkspaceInviteView | null> {
  const record = await insertInvite(input)
  return record ? presentWorkspaceInvite(record) : null
}

export async function listWorkspaceInvites(
  workspaceId: string
): Promise<WorkspaceInviteView[]> {
  const records = await listActiveInvitesByWorkspace(workspaceId)
  return records.map(presentWorkspaceInvite)
}

export async function revokeInvite(
  inviteId: string,
  workspaceId: string
): Promise<WorkspaceInviteView | null> {
  const record = await updateInviteRevoked(inviteId, workspaceId)
  return record ? presentWorkspaceInvite(record) : null
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
  return { ok: true, view: presentWorkspaceInvitePublic(record) }
}

export async function redeemInvite(
  token: string,
  userId: string
): Promise<WorkspaceInviteRedeemResult> {
  return redeemInviteTx(token, userId)
}

// Re-export so existing in-module importers (e.g. service.ts seeding paths) keep
// a single entry point for the invite record type without reaching into repo.
export type { WorkspaceInviteRecord }
