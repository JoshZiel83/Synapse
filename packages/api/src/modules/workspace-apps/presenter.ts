import {
  SUBJECT_KIND,
  type CapabilityAccessTarget,
  type WorkspaceAppGrant,
  type WorkspaceAppGrantPermission,
  type WorkspaceAppGrantRequest,
  type WorkspaceAppKind,
  type WorkspaceAppView,
} from "@synapse/shared"
import {
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"

/**
 * Workspace-apps presentation layer: DB row → app-facing view. Owns the
 * outward semantic transforms (Date → IsoInstantString) so the
 * service/controller never call serializeInstant (guard-layering r3), and the
 * row→view shaping lives here rather than under a map*Row name (r4). Row types
 * are structural so this file stays free of database-schema imports.
 */

export type WorkspaceAppRow = {
  id: string | null
  workspaceId: string | null
  kind: WorkspaceAppKind | null
  displayName: string | null
  ownerWorkspaceMemberId: string | null
  status: string | null
  conversationTypeMaskOverride: number | null
  createdAt: Date | null
  updatedAt: Date | null
  deletedAt?: Date | null
}

export type WorkspaceAppGrantViewRow = {
  id: string
  kind: string
  workspaceId: string | null
  workspaceAppId: string
  permissions: WorkspaceAppGrantPermission[]
  status: string
  source: string
  createdByWorkspaceMemberId: string | null
  reason: string | null
  conversationTypeMaskOverride: number | null
  createdAt: Date | null
  revokedAt: Date | null
  workspaceMemberId: string | null
  actorId: string | null
  remoteAgentId: string | null
  conversationId: string | null
  scopeKind: string | null
  scopeWorkspaceIdViaJoin?: string | null
  scopeConversationIdViaJoin?: string | null
}

export type WorkspaceAppGrantRequestViewRow = {
  id: string
  workspaceId: string
  workspaceAppId: string
  requestedPermissions: WorkspaceAppGrantPermission[]
  requesterWorkspaceMemberId: string
  status: string
  resolvedByWorkspaceMemberId: string | null
  resolvedAt: Date | null
  reason: string | null
  createdAt: Date | null
  updatedAt: Date | null
  granteeKind?: string | null
  granteeWorkspaceIdViaJoin?: string | null
  granteeWorkspaceMemberIdViaJoin?: string | null
  granteeActorIdViaJoin?: string | null
  granteeRemoteAgentIdViaJoin?: string | null
  granteeConversationIdViaJoin?: string | null
  granteeScopeKind?: string | null
  granteeScopeWorkspaceIdViaJoin?: string | null
  granteeScopeConversationIdViaJoin?: string | null
}

export function isCompleteWorkspaceAppRow(
  row: WorkspaceAppRow | null
): row is WorkspaceAppRow & {
  id: string
  workspaceId: string
  kind: WorkspaceAppKind
  displayName: string
  status: string
  createdAt: Date
  updatedAt: Date
} {
  return Boolean(
    row?.id &&
    row.workspaceId &&
    row.kind &&
    row.displayName &&
    row.status &&
    row.createdAt &&
    row.updatedAt
  )
}

function subjectRefToTarget(input: {
  kind: string
  workspaceId: string | null
  workspaceMemberId: string | null
  actorId: string | null
  remoteAgentId: string | null
  conversationId: string | null
  scopeKind: string | null
  scopeWorkspaceId: string | null
  scopeConversationId: string | null
}): CapabilityAccessTarget {
  const requireId = (value: string | null, label: string): string => {
    if (!value) {
      throw new Error(`access subject ${input.kind} is missing ${label}`)
    }
    return value
  }

  const subject: CapabilityAccessTarget["subject"] =
    input.kind === SUBJECT_KIND.WORKSPACE
      ? {
          kind: SUBJECT_KIND.WORKSPACE,
          workspaceId: requireId(input.workspaceId, "workspaceId"),
        }
      : input.kind === SUBJECT_KIND.WORKSPACE_MEMBER
        ? {
            kind: SUBJECT_KIND.WORKSPACE_MEMBER,
            memberId: requireId(input.workspaceMemberId, "memberId"),
          }
        : input.kind === SUBJECT_KIND.ACTOR
          ? {
              kind: SUBJECT_KIND.ACTOR,
              actorId: requireId(input.actorId, "actorId"),
            }
          : input.kind === SUBJECT_KIND.REMOTE_AGENT
            ? {
                kind: SUBJECT_KIND.REMOTE_AGENT,
                remoteAgentId: requireId(input.remoteAgentId, "remoteAgentId"),
              }
            : {
                kind: SUBJECT_KIND.CONVERSATION,
                conversationId: requireId(
                  input.conversationId,
                  "conversationId"
                ),
              }

  const scope =
    input.scopeKind === SUBJECT_KIND.CONVERSATION
      ? {
          kind: SUBJECT_KIND.CONVERSATION,
          conversationId: requireId(
            input.scopeConversationId,
            "scope conversationId"
          ),
        }
      : undefined

  return scope ? { subject, scope } : { subject }
}

export function presentWorkspaceApp(row: WorkspaceAppRow): WorkspaceAppView {
  if (!isCompleteWorkspaceAppRow(row)) {
    throw new Error("workspace app row is missing required fields")
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind,
    displayName: row.displayName,
    ownerWorkspaceMemberId: row.ownerWorkspaceMemberId || undefined,
    status: row.status as WorkspaceAppView["status"],
    conversationTypeMaskOverride: row.conversationTypeMaskOverride || undefined,
    createdAt: serializeInstant(row.createdAt),
    updatedAt: serializeInstant(row.updatedAt),
  }
}

export function presentGrant(row: WorkspaceAppGrantViewRow): WorkspaceAppGrant {
  if (!row.createdAt) {
    throw new Error("workspace app grant row is missing created_at")
  }
  if (!row.workspaceId) {
    throw new Error(`workspace_app_grants.${row.id}.workspace_id is missing`)
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceAppId: row.workspaceAppId,
    target: subjectRefToTarget({
      ...row,
      scopeWorkspaceId: row.scopeWorkspaceIdViaJoin || null,
      scopeConversationId: row.scopeConversationIdViaJoin || null,
    }),
    permissions: row.permissions,
    status: row.status as WorkspaceAppGrant["status"],
    source: row.source as WorkspaceAppGrant["source"],
    grantedByWorkspaceMemberId: row.createdByWorkspaceMemberId || undefined,
    reason: row.reason || undefined,
    conversationTypeMaskOverride: row.conversationTypeMaskOverride ?? undefined,
    createdAt: serializeInstant(row.createdAt),
    revokedAt: serializeOptionalInstant(row.revokedAt),
  }
}

export function presentGrantRequest(
  row: WorkspaceAppGrantRequestViewRow
): WorkspaceAppGrantRequest {
  if (!row.granteeKind || !row.createdAt || !row.updatedAt) {
    throw new Error("workspace app grant request row is missing joined fields")
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceAppId: row.workspaceAppId,
    grantee: subjectRefToTarget({
      kind: row.granteeKind,
      workspaceId: row.granteeWorkspaceIdViaJoin || null,
      workspaceMemberId: row.granteeWorkspaceMemberIdViaJoin || null,
      actorId: row.granteeActorIdViaJoin || null,
      remoteAgentId: row.granteeRemoteAgentIdViaJoin || null,
      conversationId: row.granteeConversationIdViaJoin || null,
      scopeKind: row.granteeScopeKind || null,
      scopeWorkspaceId: row.granteeScopeWorkspaceIdViaJoin || null,
      scopeConversationId: row.granteeScopeConversationIdViaJoin || null,
    }),
    requestedPermissions: row.requestedPermissions,
    requesterWorkspaceMemberId: row.requesterWorkspaceMemberId,
    status: row.status as WorkspaceAppGrantRequest["status"],
    resolvedByWorkspaceMemberId: row.resolvedByWorkspaceMemberId || undefined,
    resolvedAt: serializeOptionalInstant(row.resolvedAt),
    reason: row.reason || undefined,
    createdAt: serializeInstant(row.createdAt),
    updatedAt: serializeInstant(row.updatedAt),
  }
}
