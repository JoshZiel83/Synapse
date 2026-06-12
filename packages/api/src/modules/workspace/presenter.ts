import type { WorkspaceChiefActorPreference } from "@synapse/shared"
import { type ActorDoc, type ActorRole } from "@synapse/shared"
import { serializeOptionalInstant } from "../../infrastructure/datetime.js"
import { getFileUrlById } from "../files/service.js"
import type {
  ActorRecord,
  WorkspaceAccessKey,
  WorkspaceChiefActorPreferenceRow,
  WorkspaceListRow,
  WorkspaceMemberViewRow,
  WorkspaceViewRow,
} from "./repo.types.js"

/**
 * Workspace presentation layer: DB record → app-facing view. Owns the outward
 * semantic transforms (Date → IsoInstantString) so the service/controller never
 * call serializeInstant (guard-layering r3). Row inputs are taken structurally
 * from repo.types — this file must not import generated/db. See §5.1 / §10.1.
 */

export function deriveWorkspaceTrustLevel(row: {
  ownerId?: string | null
  userId?: string | null
  trustLevel?: string | null
}) {
  if (row.ownerId && row.userId && row.ownerId === row.userId) {
    return "owner"
  }
  return row.trustLevel ?? null
}

export function presentWorkspaceRow(row: WorkspaceViewRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    ownerId: row.ownerId,
    isTrusted: Boolean(row.isTrusted),
    createdAt: serializeOptionalInstant(row.createdAt),
    updatedAt: serializeOptionalInstant(row.updatedAt),
  }
}

export function presentWorkspaceListRow(row: WorkspaceListRow) {
  return {
    ...presentWorkspaceRow(row),
    currentWorkspaceMemberId: row.currentWorkspaceMemberId ?? undefined,
    trustLevel: deriveWorkspaceTrustLevel(row),
  }
}

export function presentActorRow(params: {
  row: ActorRecord
  workspaceId: string
  displayName: string
  docs: ActorDoc[]
}) {
  const { row, workspaceId, displayName, docs } = params
  return {
    id: row.id,
    workspaceId,
    definition: {
      name: displayName,
      role: row.role,
      title: row.title,
      avatarFileId: row.avatarFileId ?? undefined,
      parentId: row.parentId ?? undefined,
      canRepresentUser: Boolean(row.canRepresentUser),
      docs,
      specialties: Array.isArray(row.specialties) ? row.specialties : [],
      config: row.config
        ? typeof row.config === "string"
          ? JSON.parse(row.config)
          : row.config
        : {},
    },
    currentVersion: Number(row.currentVersion || 1),
    isActive: true,
    isPublicShared: Boolean(row.isPublicShared),
    createdAt: serializeOptionalInstant(row.createdAt),
    updatedAt: serializeOptionalInstant(row.updatedAt),
  }
}

export function presentMemberRow(row: WorkspaceMemberViewRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    trustLevel: deriveWorkspaceTrustLevel(row),
    accessKeys: Array.isArray(row.accessKeys) ? row.accessKeys : [],
    joinedAt: serializeOptionalInstant(row.joinedAt),
  }
}

/**
 * Workspace access binding view (app-facing). Owns the Date → IsoInstantString
 * transform so the service builds the binding value without calling
 * serializeInstant (guard-layering r3). `userId` plus the joined user/trust
 * fields are supplied by the service's list query; the grant path omits them.
 */
export function presentAccessBindingRow(row: {
  workspaceId: string
  workspaceMemberId: string
  userId: string
  accessKey: WorkspaceAccessKey
  assignedByWorkspaceMemberId: string | null
  createdAt?: Date | null
  updatedAt?: Date | null
  trustLevel?: string | null
  userName?: string | null
  userEmail?: string | null
  avatarUrl?: string | null
}) {
  return {
    workspaceId: row.workspaceId,
    workspaceMemberId: row.workspaceMemberId,
    userId: row.userId,
    accessKey: row.accessKey,
    assignedByWorkspaceMemberId: row.assignedByWorkspaceMemberId,
    createdAt: serializeOptionalInstant(row.createdAt),
    updatedAt: serializeOptionalInstant(row.updatedAt),
    ...(row.trustLevel !== undefined ? { trustLevel: row.trustLevel } : {}),
    ...(row.userName !== undefined ? { userName: row.userName } : {}),
    ...(row.userEmail !== undefined ? { userEmail: row.userEmail } : {}),
    ...(row.avatarUrl !== undefined ? { avatarUrl: row.avatarUrl } : {}),
  }
}

export function presentWorkspaceChiefActorPreferenceRow(
  row: WorkspaceChiefActorPreferenceRow
): WorkspaceChiefActorPreference {
  const chiefActorId =
    row.chiefActorId && row.chiefActorDisplayName ? row.chiefActorId : undefined

  return {
    workspaceId: row.workspaceId,
    workspaceMemberId: row.workspaceMemberId,
    chiefActorId,
    chiefActor:
      chiefActorId && row.chiefActorDisplayName
        ? {
            id: chiefActorId,
            displayName: row.chiefActorDisplayName,
            role: (row.chiefActorRole as ActorRole | null) || "assistant",
            title: row.chiefActorTitle || row.chiefActorRole || "Actor",
            avatarUrl: row.chiefActorAvatarFileId
              ? getFileUrlById(row.chiefActorAvatarFileId)
              : undefined,
          }
        : undefined,
    createdAt: serializeOptionalInstant(row.createdAt),
    updatedAt: serializeOptionalInstant(row.updatedAt),
  }
}
