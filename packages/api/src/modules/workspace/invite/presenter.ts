import type {
  WorkspaceInvitePublicView,
  WorkspaceInviteRedeemResult,
  WorkspaceInviteView,
} from "@synapse/shared"
import { serializeInstant } from "../../../infrastructure/datetime.js"
import type {
  WorkspaceInviteRecord,
  WorkspaceInviteRedeemRecord,
  WorkspaceInviteWithWorkspaceNameRecord,
} from "./repo.js"

/**
 * Invite presentation layer: DB record → app-facing view. Owns the outward
 * semantic transforms (Date → IsoInstantString) so the service/controller
 * never call serializeInstant (guard-layering r3). See §5.1 / §10.1.
 */

export function presentWorkspaceInvite(
  record: WorkspaceInviteRecord
): WorkspaceInviteView {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    token: record.token,
    createdByWorkspaceMemberId: record.createdByWorkspaceMemberId,
    trustLevel: record.trustLevel,
    maxUses: record.maxUses ?? null,
    useCount: record.useCount,
    expiresAt: record.expiresAt ? serializeInstant(record.expiresAt) : null,
    isRevoked: record.isRevoked ?? false,
    createdAt: serializeInstant(record.createdAt),
    updatedAt: serializeInstant(record.updatedAt),
  }
}

export function presentWorkspaceInvitePublic(
  record: WorkspaceInviteWithWorkspaceNameRecord
): WorkspaceInvitePublicView {
  return {
    token: record.token,
    workspaceName: record.workspaceName,
    trustLevel: record.trustLevel,
  }
}

export function presentWorkspaceInviteRedeemResult(
  record: WorkspaceInviteRedeemRecord
): WorkspaceInviteRedeemResult {
  return {
    workspaceId: record.workspaceId,
    workspaceName: record.workspaceName,
    trustLevel: record.trustLevel,
  }
}
