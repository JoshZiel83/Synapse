import { sql } from "kysely"
import {
  ACCESS_BINDING_STATUS,
  SUBJECT_KIND,
  WORKSPACE_APP_KIND,
  WORKSPACE_APP_GRANT_PERMISSION,
  WORKSPACE_APP_GRANT_REQUEST_DIRECTION,
  WORKSPACE_APP_GRANT_REQUEST_STATUS,
  type WorkspaceAppGrantRequestDirection,
  WORKSPACE_APP_GRANT_STATUS,
  WORKSPACE_APP_STATUS,
  type CapabilityAccessTarget,
  type WorkspaceAppGrant,
  type WorkspaceAppGrantRequest,
  type WorkspaceAppView,
  type WorkspaceAppGrantPermission,
  type WorkspaceAppKind,
} from "@synapse/shared"
import { db } from "../../infrastructure/database/kysely.js"
import { requireWorkspaceMemberIdentity } from "../chat/workspace-identity.js"
import { isSubjectActiveConversationParticipant } from "../access/subject-resolution.js"
import {
  createActor,
  deleteActor,
  updateActor,
} from "../organization/service.js"
import {
  createRemoteAgent,
  deleteRemoteAgent,
  updateRemoteAgent,
} from "../remote-agents/service.js"
import {
  createWorkspaceSkill,
  installMarketplaceSkill,
  uninstallInstalledSkill,
  updateInstalledSkill,
} from "../skills/service.js"
import {
  installPluginUnified,
  uninstallPluginUnified,
  updateInstallation,
} from "../mcp-plugins/service.js"
import {
  cancelWorkspaceAppGrantRequest,
  insertWorkspaceAppGrant,
  insertWorkspaceAppGrantRequest,
  listActiveWorkspaceAppGrants,
  listWorkspaceAppGrantRequests,
  resolveWorkspaceAppGrantRequest,
  revokeWorkspaceAppGrant,
  revokeWorkspaceAppGrantsForApp,
  type WorkspaceAppGrantRequestRow,
  type WorkspaceAppGrantRow,
} from "./grant-storage.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { updateWorkspaceAppRoot } from "./root-storage.js"

type WorkspaceMemberAccess = {
  workspaceMemberId: string
  workspaceId: string
  userId: string
  ownerId: string
  trustLevel: string
  accessKeys: string[]
}

type WorkspaceAppRow = {
  id: string
  workspace_id: string
  kind: WorkspaceAppKind
  display_name: string
  owner_workspace_member_id: string | null
  status: string
  conversation_type_mask_override: number | null
  created_at: string
  updated_at: string
}

const IMPLICIT_OWNER_VISIBLE_WORKSPACE_APP_KINDS = [
  WORKSPACE_APP_KIND.ACTOR,
  WORKSPACE_APP_KIND.REMOTE_AGENT,
] as const

function workspaceAppKindAdminKey(kind: WorkspaceAppKind): string {
  switch (kind) {
    case WORKSPACE_APP_KIND.PLUGIN_INSTALLATION:
      return "plugin_admin"
    case WORKSPACE_APP_KIND.INSTALLED_SKILL:
      return "skill_admin"
    case WORKSPACE_APP_KIND.ACTOR:
      return "actor_admin"
    case WORKSPACE_APP_KIND.REMOTE_AGENT:
      return "remote_agent_admin"
    case WORKSPACE_APP_KIND.DEVICE_CAPABILITY:
      return "device_admin"
  }
  throw new Error(`Unsupported workspace app kind: ${kind}`)
}

function mapWorkspaceAppRow(row: WorkspaceAppRow): WorkspaceAppView {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    displayName: row.display_name,
    ownerWorkspaceMemberId: row.owner_workspace_member_id || undefined,
    status: row.status as WorkspaceAppView["status"],
    conversationTypeMaskOverride:
      row.conversation_type_mask_override || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function targetToSubjectRef(target: CapabilityAccessTarget) {
  return target.subject
}

function targetScopeToSubjectRef(target: CapabilityAccessTarget) {
  return target.scope
}

function subjectRefToTarget(input: {
  kind: string
  workspace_id: string | null
  workspace_member_id: string | null
  actor_id: string | null
  remote_agent_id: string | null
  conversation_id: string | null
  scope_kind: string | null
  scope_workspace_id: string | null
  scope_conversation_id: string | null
}): CapabilityAccessTarget {
  const subject: CapabilityAccessTarget["subject"] =
    input.kind === SUBJECT_KIND.WORKSPACE
      ? { kind: SUBJECT_KIND.WORKSPACE, workspaceId: input.workspace_id || "" }
      : input.kind === SUBJECT_KIND.WORKSPACE_MEMBER
        ? {
            kind: SUBJECT_KIND.WORKSPACE_MEMBER,
            memberId: input.workspace_member_id || "",
          }
        : input.kind === SUBJECT_KIND.ACTOR
          ? { kind: SUBJECT_KIND.ACTOR, actorId: input.actor_id || "" }
          : input.kind === SUBJECT_KIND.REMOTE_AGENT
            ? {
                kind: SUBJECT_KIND.REMOTE_AGENT,
                remoteAgentId: input.remote_agent_id || "",
              }
            : {
                kind: SUBJECT_KIND.CONVERSATION,
                conversationId: input.conversation_id || "",
              }

  const scope =
    input.scope_kind === SUBJECT_KIND.CONVERSATION
      ? {
          kind: SUBJECT_KIND.CONVERSATION,
          conversationId: input.scope_conversation_id || "",
        }
      : undefined

  return scope ? { subject, scope } : { subject }
}

function mapGrantRow(row: any): WorkspaceAppGrant {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceAppId: row.workspace_app_id,
    target: subjectRefToTarget(row),
    permissions: row.permissions,
    status: row.status,
    source: row.source,
    grantedByWorkspaceMemberId: row.created_by_workspace_member_id || undefined,
    reason: row.reason || undefined,
    conversationTypeMaskOverride:
      row.conversation_type_mask_override ?? undefined,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
    revokedAt:
      row.revoked_at instanceof Date
        ? row.revoked_at.toISOString()
        : row.revoked_at || undefined,
  }
}

function mapGrantRequestRow(row: any): WorkspaceAppGrantRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceAppId: row.workspace_app_id,
    grantee: subjectRefToTarget({
      kind: row.grantee_kind,
      workspace_id: row.grantee_workspace_id_via_join,
      workspace_member_id: row.grantee_workspace_member_id_via_join,
      actor_id: row.grantee_actor_id_via_join,
      remote_agent_id: row.grantee_remote_agent_id_via_join,
      conversation_id: row.grantee_conversation_id_via_join,
      scope_kind: row.grantee_scope_kind,
      scope_workspace_id: row.grantee_scope_workspace_id_via_join,
      scope_conversation_id: row.grantee_scope_conversation_id_via_join,
    }),
    requestedPermissions: row.requested_permissions,
    requesterWorkspaceMemberId: row.requester_workspace_member_id,
    status: row.status,
    resolvedByWorkspaceMemberId:
      row.resolved_by_workspace_member_id || undefined,
    resolvedAt:
      row.resolved_at instanceof Date
        ? row.resolved_at.toISOString()
        : row.resolved_at || undefined,
    reason: row.reason || undefined,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row.updated_at,
  }
}

async function loadWorkspaceMemberAccess(
  workspaceId: string,
  userId: string
): Promise<WorkspaceMemberAccess | null> {
  const row = await db
    .selectFrom("workspace_members as wm")
    .innerJoin("workspaces as w", "w.id", "wm.workspace_id")
    .select([
      "wm.id",
      "wm.workspace_id",
      "wm.user_id",
      "wm.trust_level",
      "w.owner_id",
    ])
    .where("wm.workspace_id", "=", workspaceId)
    .where("wm.user_id", "=", userId)
    .where("wm.status", "=", "active")
    .where("w.deleted_at", "is", null)
    .limit(1)
    .executeTakeFirst()
  if (!row) return null

  const accessRows = await db
    .selectFrom("workspace_access_bindings")
    .select("access_key")
    .where("workspace_member_id", "=", row.id)
    .where("status", "=", ACCESS_BINDING_STATUS.ACTIVE)
    .execute()

  return {
    workspaceMemberId: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    ownerId: row.owner_id,
    trustLevel: row.trust_level,
    accessKeys: accessRows.map((entry) => entry.access_key),
  }
}

function isWorkspaceAdmin(access: WorkspaceMemberAccess) {
  return access.ownerId === access.userId || access.trustLevel === "admin"
}

function hasKindAdmin(access: WorkspaceMemberAccess, kind: WorkspaceAppKind) {
  return access.accessKeys.includes(workspaceAppKindAdminKey(kind))
}

async function hasManageGrant(
  workspaceAppId: string,
  workspaceMemberId: string
): Promise<boolean> {
  const memberSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId: workspaceMemberId,
  })
  const row = await db
    .selectFrom("workspace_app_grants")
    .select("id")
    .where("workspace_app_id", "=", workspaceAppId)
    .where("subject_id", "=", memberSubjectId)
    .where("status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
    .where(
      sql<boolean>`${WORKSPACE_APP_GRANT_PERMISSION.MANAGE}::workspace_app_grant_permission = ANY(permissions)`
    )
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

async function requireManageWorkspaceApp(
  workspaceId: string,
  appId: string,
  userId: string
) {
  const access = await loadWorkspaceMemberAccess(workspaceId, userId)
  if (!access) {
    throw new Error("Workspace member not found")
  }
  const app = await db
    .selectFrom("workspace_apps")
    .selectAll()
    .where("id", "=", appId)
    .where("workspace_id", "=", workspaceId)
    .where("deleted_at", "is", null)
    .executeTakeFirst()
  if (!app) {
    throw new Error("Workspace app not found")
  }
  if (
    isWorkspaceAdmin(access) ||
    hasKindAdmin(access, app.kind as WorkspaceAppKind) ||
    app.owner_workspace_member_id === access.workspaceMemberId ||
    (await hasManageGrant(appId, access.workspaceMemberId))
  ) {
    return { access, app: app as unknown as WorkspaceAppRow }
  }
  throw new Error("Not allowed to manage this workspace app")
}

export async function listWorkspaceAppsInventory(params: {
  workspaceId: string
  userId: string
  kind?: WorkspaceAppKind
}): Promise<WorkspaceAppView[]> {
  const access = await loadWorkspaceMemberAccess(
    params.workspaceId,
    params.userId
  )
  if (!access) {
    throw new Error("Workspace member not found")
  }

  let query = db
    .selectFrom("workspace_apps")
    .selectAll()
    .where("workspace_id", "=", params.workspaceId)
    .where("deleted_at", "is", null)
    .orderBy("created_at", "desc")

  if (params.kind) {
    query = query.where("kind", "=", params.kind)
  }

  const isAdmin = isWorkspaceAdmin(access)
  const rows = await query.execute()
  const filtered = await Promise.all(
    rows.map(async (row) => {
      const kind = row.kind as WorkspaceAppKind
      if (isAdmin || hasKindAdmin(access, kind)) return row
      if (row.owner_workspace_member_id === access.workspaceMemberId) return row
      return (await hasManageGrant(row.id, access.workspaceMemberId))
        ? row
        : null
    })
  )
  return filtered.filter(Boolean).map((row) => mapWorkspaceAppRow(row! as any))
}

export async function discoverWorkspaceAppsForMember(params: {
  workspaceId: string
  userId: string
  conversationId?: string
}): Promise<WorkspaceAppView[]> {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  const workspaceSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE,
    workspaceId: params.workspaceId,
  })
  const memberSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId: identity.workspaceMemberId,
  })

  let conversationSubjectId: string | null = null
  if (params.conversationId) {
    const participant = await isSubjectActiveConversationParticipant(
      db,
      params.conversationId,
      memberSubjectId
    )
    if (participant) {
      conversationSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: params.conversationId,
      })
    }
  }

  const claimSubjectIds = [workspaceSubjectId, memberSubjectId]
  const grantRows = await db
    .selectFrom("workspace_app_grants as app_grant")
    .innerJoin("workspace_apps as app", "app.id", "app_grant.workspace_app_id")
    .select([
      "app.id",
      "app.workspace_id",
      "app.kind",
      "app.display_name",
      "app.owner_workspace_member_id",
      "app.status",
      "app.conversation_type_mask_override",
      "app.created_at",
      "app.updated_at",
    ])
    .where("app.workspace_id", "=", params.workspaceId)
    .where("app.deleted_at", "is", null)
    .where("app.status", "=", WORKSPACE_APP_STATUS.ACTIVE)
    .where("app_grant.status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
    .where("app_grant.subject_id", "in", claimSubjectIds)
    .where((eb) =>
      conversationSubjectId
        ? eb.or([
            eb("app_grant.scope_subject_id", "is", null),
            eb("app_grant.scope_subject_id", "=", conversationSubjectId),
          ])
        : eb("app_grant.scope_subject_id", "is", null)
    )
    .where(
      sql<boolean>`(
        ${WORKSPACE_APP_GRANT_PERMISSION.USE}::workspace_app_grant_permission = ANY(app_grant.permissions)
        OR ${WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE}::workspace_app_grant_permission = ANY(app_grant.permissions)
      )`
    )
    .distinct()
    .execute()

  const implicitOwnerRows = await db
    .selectFrom("workspace_apps as app")
    .selectAll()
    .where("app.workspace_id", "=", params.workspaceId)
    .where("app.deleted_at", "is", null)
    .where("app.status", "=", WORKSPACE_APP_STATUS.ACTIVE)
    .where("app.owner_workspace_member_id", "=", identity.workspaceMemberId)
    .where("app.kind", "in", IMPLICIT_OWNER_VISIBLE_WORKSPACE_APP_KINDS)
    .execute()

  const byId = new Map<string, WorkspaceAppView>()
  for (const row of grantRows as any[]) {
    byId.set(row.id, mapWorkspaceAppRow(row as any))
  }
  for (const row of implicitOwnerRows as any[]) {
    byId.set(row.id, mapWorkspaceAppRow(row as any))
  }
  return Array.from(byId.values())
}

export async function getWorkspaceAppInventoryDetail(params: {
  workspaceId: string
  appId: string
  userId: string
}): Promise<WorkspaceAppView> {
  const { access, app } = await requireManageWorkspaceApp(
    params.workspaceId,
    params.appId,
    params.userId
  )
  return mapWorkspaceAppRow(app)
}

export async function listWorkspaceAppGrantsView(params: {
  workspaceId: string
  appId: string
  userId: string
}): Promise<WorkspaceAppGrant[]> {
  await requireManageWorkspaceApp(
    params.workspaceId,
    params.appId,
    params.userId
  )
  const rows = await db
    .selectFrom("workspace_app_grants as app_grant")
    .innerJoin("access_subjects as subj", "subj.id", "app_grant.subject_id")
    .leftJoin(
      "access_subjects as scope",
      "scope.id",
      "app_grant.scope_subject_id"
    )
    .select([
      "app_grant.id",
      "app_grant.workspace_id",
      "app_grant.workspace_app_id",
      "app_grant.permissions",
      "app_grant.status",
      "app_grant.source",
      "app_grant.created_by_workspace_member_id",
      "app_grant.reason",
      "app_grant.conversation_type_mask_override",
      "app_grant.created_at",
      "app_grant.revoked_at",
      "subj.kind",
      "subj.workspace_id",
      "subj.workspace_member_id",
      "subj.actor_id",
      "subj.remote_agent_id",
      "subj.conversation_id",
      "scope.kind as scope_kind",
      "scope.workspace_id as scope_workspace_id_via_join",
      "scope.conversation_id as scope_conversation_id_via_join",
    ])
    .where("app_grant.workspace_app_id", "=", params.appId)
    .where("app_grant.status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
    .orderBy("app_grant.created_at", "desc")
    .execute()
  return rows.map((row) => mapGrantRow(row))
}

export async function replaceWorkspaceAppGrants(params: {
  workspaceId: string
  appId: string
  userId: string
  grants: Array<{
    target: CapabilityAccessTarget
    permissions: WorkspaceAppGrantPermission[]
    conversationTypeMaskOverride?: number | null
    reason?: string
  }>
}): Promise<WorkspaceAppGrant[]> {
  const { access } = await requireManageWorkspaceApp(
    params.workspaceId,
    params.appId,
    params.userId
  )
  await db.transaction().execute(async (trx) => {
    const existing = await listActiveWorkspaceAppGrants(trx, params.appId)
    for (const grant of existing) {
      await revokeWorkspaceAppGrant(trx, grant.id)
    }
    for (const grant of params.grants) {
      await insertWorkspaceAppGrant(trx, {
        workspaceId: params.workspaceId,
        workspaceAppId: params.appId,
        target: grant.target,
        permissions: grant.permissions,
        conversationTypeMaskOverride:
          grant.conversationTypeMaskOverride ?? null,
        createdByWorkspaceMemberId: access.workspaceMemberId,
        reason: grant.reason ?? null,
      })
    }
  })
  return listWorkspaceAppGrantsView(params)
}

export async function listWorkspaceAppGrantRequestsView(params: {
  workspaceId: string
  appId: string
  userId: string
  direction: WorkspaceAppGrantRequestDirection
}): Promise<WorkspaceAppGrantRequest[]> {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (params.direction === WORKSPACE_APP_GRANT_REQUEST_DIRECTION.INCOMING) {
    await requireManageWorkspaceApp(
      params.workspaceId,
      params.appId,
      params.userId
    )
  }
  const rows = await db
    .selectFrom("workspace_app_grant_requests as app_request")
    .innerJoin(
      "access_subjects as grantee",
      "grantee.id",
      "app_request.grantee_subject_id"
    )
    .leftJoin(
      "access_subjects as scope",
      "scope.id",
      "app_request.grantee_scope_subject_id"
    )
    .select([
      "app_request.id",
      "app_request.workspace_id",
      "app_request.workspace_app_id",
      "app_request.requested_permissions",
      "app_request.requester_workspace_member_id",
      "app_request.status",
      "app_request.resolved_by_workspace_member_id",
      "app_request.resolved_at",
      "app_request.reason",
      "app_request.created_at",
      "app_request.updated_at",
      "grantee.kind as grantee_kind",
      "grantee.workspace_id as grantee_workspace_id_via_join",
      "grantee.workspace_member_id as grantee_workspace_member_id_via_join",
      "grantee.actor_id as grantee_actor_id_via_join",
      "grantee.remote_agent_id as grantee_remote_agent_id_via_join",
      "grantee.conversation_id as grantee_conversation_id_via_join",
      "scope.kind as grantee_scope_kind",
      "scope.workspace_id as grantee_scope_workspace_id_via_join",
      "scope.conversation_id as grantee_scope_conversation_id_via_join",
    ])
    .where("app_request.workspace_app_id", "=", params.appId)
    .where((eb) =>
      params.direction === WORKSPACE_APP_GRANT_REQUEST_DIRECTION.OUTGOING
        ? eb(
            "app_request.requester_workspace_member_id",
            "=",
            identity.workspaceMemberId
          )
        : eb.val(true)
    )
    .orderBy("app_request.created_at", "desc")
    .execute()
  return rows.map((row) => mapGrantRequestRow(row))
}

export async function submitWorkspaceAppGrantRequest(params: {
  workspaceId: string
  appId: string
  userId: string
  reason?: string
}): Promise<WorkspaceAppGrantRequest> {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  const row = await insertWorkspaceAppGrantRequest(db, {
    workspaceId: params.workspaceId,
    workspaceAppId: params.appId,
    grantee: {
      subject: {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: identity.workspaceMemberId,
      },
    },
    requestedPermissions: [WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE],
    requesterWorkspaceMemberId: identity.workspaceMemberId,
    reason: params.reason ?? null,
  })
  return mapGrantRequestRow({
    ...row,
    grantee_kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    grantee_workspace_id_via_join: params.workspaceId,
    grantee_workspace_member_id_via_join: identity.workspaceMemberId,
    grantee_actor_id_via_join: null,
    grantee_remote_agent_id_via_join: null,
    grantee_conversation_id_via_join: null,
    grantee_scope_kind: null,
    grantee_scope_workspace_id_via_join: null,
    grantee_scope_conversation_id_via_join: null,
  })
}

export async function approveWorkspaceAppGrantRequest(params: {
  workspaceId: string
  appId: string
  requestId: string
  userId: string
}): Promise<WorkspaceAppGrantRequest> {
  const { access } = await requireManageWorkspaceApp(
    params.workspaceId,
    params.appId,
    params.userId
  )
  const row = await resolveWorkspaceAppGrantRequest({
    workspaceId: params.workspaceId,
    workspaceAppId: params.appId,
    requestId: params.requestId,
    approverWorkspaceMemberId: access.workspaceMemberId,
    decision: "approve",
  })
  return listWorkspaceAppGrantRequestsView({
    workspaceId: params.workspaceId,
    appId: params.appId,
    userId: params.userId,
    direction: WORKSPACE_APP_GRANT_REQUEST_DIRECTION.INCOMING,
  }).then(
    (rows) => rows.find((item) => item.id === row.id) || mapGrantRequestRow(row)
  )
}

export async function rejectWorkspaceAppGrantRequest(params: {
  workspaceId: string
  appId: string
  requestId: string
  userId: string
}): Promise<WorkspaceAppGrantRequest> {
  const { access } = await requireManageWorkspaceApp(
    params.workspaceId,
    params.appId,
    params.userId
  )
  const row = await resolveWorkspaceAppGrantRequest({
    workspaceId: params.workspaceId,
    workspaceAppId: params.appId,
    requestId: params.requestId,
    approverWorkspaceMemberId: access.workspaceMemberId,
    decision: "reject",
  })
  return listWorkspaceAppGrantRequestsView({
    workspaceId: params.workspaceId,
    appId: params.appId,
    userId: params.userId,
    direction: WORKSPACE_APP_GRANT_REQUEST_DIRECTION.INCOMING,
  }).then(
    (rows) => rows.find((item) => item.id === row.id) || mapGrantRequestRow(row)
  )
}

export async function cancelWorkspaceAppGrantRequestByRequester(params: {
  workspaceId: string
  appId: string
  requestId: string
  userId: string
}): Promise<boolean> {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  const request = await db
    .selectFrom("workspace_app_grant_requests")
    .select([
      "id",
      "workspace_id",
      "workspace_app_id",
      "requester_workspace_member_id",
      "status",
    ])
    .where("id", "=", params.requestId)
    .executeTakeFirst()
  if (!request) {
    throw new Error("Workspace app grant request not found")
  }
  if (
    request.workspace_id !== params.workspaceId ||
    request.workspace_app_id !== params.appId
  ) {
    throw new Error("Workspace app grant request not found")
  }
  if (request.requester_workspace_member_id !== identity.workspaceMemberId) {
    throw new Error("Not allowed to cancel this workspace app grant request")
  }
  if (request.status !== WORKSPACE_APP_GRANT_REQUEST_STATUS.PENDING) {
    throw new Error("Workspace app grant request is no longer pending")
  }
  const cancelled = await cancelWorkspaceAppGrantRequest(db, {
    workspaceId: params.workspaceId,
    workspaceAppId: params.appId,
    requestId: params.requestId,
    requesterWorkspaceMemberId: identity.workspaceMemberId,
  })
  if (!cancelled) {
    throw new Error("Workspace app grant request is no longer pending")
  }
  return true
}

export async function createWorkspaceApp(params: {
  workspaceId: string
  userId: string
  input:
    | {
        kind: typeof WORKSPACE_APP_KIND.ACTOR
        displayName: string
        role: string
        title?: string
        avatarFileId?: string
        avatarEmoji?: string
        canRepresentUser?: boolean
        docs?: any[]
        parentId?: string
        specialties?: string[]
        config?: Record<string, unknown>
        grants?: Array<{
          target: CapabilityAccessTarget
          permissions: WorkspaceAppGrantPermission[]
          conversationTypeMaskOverride?: number | null
          reason?: string
        }>
      }
    | {
        kind: typeof WORKSPACE_APP_KIND.INSTALLED_SKILL
        sourceType: "custom"
        displayName: string
        description?: unknown
        iconFileId?: string
        tags?: string[]
        attachmentFiles?: Array<{
          path: string
          contentBlocks: unknown[]
          mediaType?: string
        }>
        grants?: Array<{
          target: CapabilityAccessTarget
          permissions: WorkspaceAppGrantPermission[]
          conversationTypeMaskOverride?: number | null
          reason?: string
        }>
      }
    | {
        kind: typeof WORKSPACE_APP_KIND.INSTALLED_SKILL
        sourceType: "marketplace"
        marketSkillId: string
        grants?: Array<{
          target: CapabilityAccessTarget
          permissions: WorkspaceAppGrantPermission[]
          conversationTypeMaskOverride?: number | null
          reason?: string
        }>
      }
    | {
        kind: typeof WORKSPACE_APP_KIND.REMOTE_AGENT
        displayName: string
        title: string
        description?: string
        runtimeKind: string
        avatarFileId?: string
        avatarEmoji?: string
        isPublicShared?: boolean
        metadata?: Record<string, unknown>
        grants?: Array<{
          target: CapabilityAccessTarget
          permissions: WorkspaceAppGrantPermission[]
          conversationTypeMaskOverride?: number | null
          reason?: string
        }>
      }
    | {
        kind: typeof WORKSPACE_APP_KIND.PLUGIN_INSTALLATION
        pluginId: string
        lifecycleScope?: string
        configData?: Record<string, unknown>
        authSessionIds?: Record<string, string>
        grants?: Array<{
          target: CapabilityAccessTarget
          permissions: WorkspaceAppGrantPermission[]
          conversationTypeMaskOverride?: number | null
          reason?: string
        }>
      }
}): Promise<WorkspaceAppView> {
  if (params.input.kind === WORKSPACE_APP_KIND.ACTOR) {
    const actor = await createActor({
      workspaceId: params.workspaceId,
      createdByWorkspaceMemberId: (
        await requireWorkspaceMemberIdentity(params.workspaceId, params.userId)
      ).workspaceMemberId,
      displayName: params.input.displayName,
      role: params.input.role as any,
      title: params.input.title,
      avatarFileId: params.input.avatarFileId,
      avatarEmoji: params.input.avatarEmoji,
      canRepresentUser: params.input.canRepresentUser,
      docs: params.input.docs,
      parentId: params.input.parentId,
      specialties: params.input.specialties,
      config: params.input.config,
      grants: params.input.grants,
    })
    return getWorkspaceAppInventoryDetail({
      workspaceId: params.workspaceId,
      appId: actor.id,
      userId: params.userId,
    })
  }

  if (params.input.kind === WORKSPACE_APP_KIND.INSTALLED_SKILL) {
    const skill =
      params.input.sourceType === "custom"
        ? await createWorkspaceSkill({
            workspaceId: params.workspaceId,
            name: params.input.displayName,
            description: params.input.description as any,
            iconFileId: params.input.iconFileId,
            tags: params.input.tags,
            attachmentFiles: params.input.attachmentFiles as any,
            grants: params.input.grants,
            installedByWorkspaceMemberId: (
              await requireWorkspaceMemberIdentity(
                params.workspaceId,
                params.userId
              )
            ).workspaceMemberId,
          })
        : await installMarketplaceSkill({
            workspaceId: params.workspaceId,
            marketSkillId: params.input.marketSkillId,
            grants: params.input.grants,
            installedByWorkspaceMemberId: (
              await requireWorkspaceMemberIdentity(
                params.workspaceId,
                params.userId
              )
            ).workspaceMemberId,
          })
    return getWorkspaceAppInventoryDetail({
      workspaceId: params.workspaceId,
      appId: skill.id,
      userId: params.userId,
    })
  }

  if (params.input.kind === WORKSPACE_APP_KIND.PLUGIN_INSTALLATION) {
    const installation = await installPluginUnified({
      workspaceId: params.workspaceId,
      pluginId: params.input.pluginId,
      lifecycleScope: params.input.lifecycleScope as any,
      configData: params.input.configData,
      authSessionIds: params.input.authSessionIds,
      grants: params.input.grants,
      installedByWorkspaceMemberId: (
        await requireWorkspaceMemberIdentity(params.workspaceId, params.userId)
      ).workspaceMemberId,
    })
    return getWorkspaceAppInventoryDetail({
      workspaceId: params.workspaceId,
      appId: installation.id,
      userId: params.userId,
    })
  }

  const remoteAgent = await createRemoteAgent({
    workspaceId: params.workspaceId,
    userId: params.userId,
    displayName: params.input.displayName,
    title: params.input.title,
    description: params.input.description,
    runtimeKind: params.input.runtimeKind as any,
    avatarFileId: params.input.avatarFileId,
    avatarEmoji: params.input.avatarEmoji,
    isPublicShared: params.input.isPublicShared,
    metadata: params.input.metadata,
    grants: params.input.grants,
  })
  return getWorkspaceAppInventoryDetail({
    workspaceId: params.workspaceId,
    appId: remoteAgent.remoteAgent.id,
    userId: params.userId,
  })
}

export async function updateWorkspaceApp(params: {
  workspaceId: string
  appId: string
  userId: string
  input:
    | {
        kind: typeof WORKSPACE_APP_KIND.ACTOR
        displayName?: string
        role?: string
        title?: string
        avatarFileId?: string | null
        avatarEmoji?: string | null
        canRepresentUser?: boolean
        docs?: any[]
        parentId?: string | null
        specialties?: string[]
        config?: Record<string, unknown>
      }
    | {
        kind: typeof WORKSPACE_APP_KIND.REMOTE_AGENT
        displayName?: string
        title?: string
        description?: string | null
        avatarFileId?: string | null
        avatarEmoji?: string | null
        isPublicShared?: boolean
        isActive?: boolean
        metadata?: Record<string, unknown>
      }
    | {
        kind: typeof WORKSPACE_APP_KIND.INSTALLED_SKILL
        displayName?: string
        description?: unknown
        iconFileId?: string | null
        tags?: string[]
        isEnabled?: boolean
        conversationTypeMaskOverride?: number | null
        attachmentFiles?: Array<{
          path: string
          contentBlocks: unknown[]
          mediaType?: string
        }>
      }
    | {
        kind: typeof WORKSPACE_APP_KIND.DEVICE_CAPABILITY
        displayName?: string
        conversationTypeMaskOverride?: number | null
      }
    | {
        kind: typeof WORKSPACE_APP_KIND.PLUGIN_INSTALLATION
        isEnabled?: boolean
        configData?: Record<string, unknown>
        authSessionIds?: Record<string, string>
        lifecycleScope?: string
        conversationTypeMaskOverride?: number | null
      }
}): Promise<WorkspaceAppView> {
  const { access, app } = await requireManageWorkspaceApp(
    params.workspaceId,
    params.appId,
    params.userId
  )
  if (app.kind !== params.input.kind) {
    throw new Error("Workspace app kind does not match update payload")
  }

  switch (params.input.kind) {
    case WORKSPACE_APP_KIND.ACTOR:
      await updateActor(params.appId, params.workspaceId, {
        displayName: params.input.displayName,
        role: params.input.role as any,
        title: params.input.title,
        avatarFileId: params.input.avatarFileId,
        avatarEmoji: params.input.avatarEmoji,
        canRepresentUser: params.input.canRepresentUser,
        docs: params.input.docs as any,
        parentId: params.input.parentId,
        specialties: params.input.specialties,
        config: params.input.config,
      })
      break
    case WORKSPACE_APP_KIND.REMOTE_AGENT:
      await updateRemoteAgent({
        workspaceId: params.workspaceId,
        remoteAgentId: params.appId,
        userId: params.userId,
        displayName: params.input.displayName,
        title: params.input.title,
        description: params.input.description,
        avatarFileId: params.input.avatarFileId,
        avatarEmoji: params.input.avatarEmoji,
        isPublicShared: params.input.isPublicShared,
        isActive: params.input.isActive,
        metadata: params.input.metadata,
      })
      break
    case WORKSPACE_APP_KIND.INSTALLED_SKILL:
      await updateInstalledSkill({
        workspaceId: params.workspaceId,
        installedSkillId: params.appId,
        name: params.input.displayName,
        description: params.input.description as any,
        iconFileId: params.input.iconFileId,
        tags: params.input.tags,
        isEnabled: params.input.isEnabled,
        conversationTypeMaskOverride: params.input.conversationTypeMaskOverride,
        attachmentFiles: params.input.attachmentFiles as any,
      })
      break
    case WORKSPACE_APP_KIND.PLUGIN_INSTALLATION:
      await updateInstallation(params.appId, {
        isEnabled: params.input.isEnabled,
        configData: params.input.configData,
        authSessionIds: params.input.authSessionIds,
        lifecycleScope: params.input.lifecycleScope as any,
        conversationTypeMaskOverride: params.input.conversationTypeMaskOverride,
        updatedByWorkspaceMemberId: access.workspaceMemberId,
      })
      break
    case WORKSPACE_APP_KIND.DEVICE_CAPABILITY:
      await updateWorkspaceAppRoot(db, {
        id: params.appId,
        displayName: params.input.displayName,
        conversationTypeMaskOverride: params.input.conversationTypeMaskOverride,
      })
      break
    default:
      throw new Error("Workspace app update is not supported for this kind")
  }

  return getWorkspaceAppInventoryDetail({
    workspaceId: params.workspaceId,
    appId: params.appId,
    userId: params.userId,
  })
}

export async function deleteWorkspaceApp(params: {
  workspaceId: string
  appId: string
  userId: string
}): Promise<boolean> {
  const { app } = await requireManageWorkspaceApp(
    params.workspaceId,
    params.appId,
    params.userId
  )
  switch (app.kind) {
    case WORKSPACE_APP_KIND.ACTOR:
      return deleteActor(params.appId, params.workspaceId)
    case WORKSPACE_APP_KIND.REMOTE_AGENT:
      return (
        await deleteRemoteAgent({
          workspaceId: params.workspaceId,
          remoteAgentId: params.appId,
          userId: params.userId,
        })
      ).deleted
    case WORKSPACE_APP_KIND.INSTALLED_SKILL:
      return uninstallInstalledSkill(params.workspaceId, params.appId)
    case WORKSPACE_APP_KIND.PLUGIN_INSTALLATION:
      await uninstallPluginUnified(params.appId)
      return true
    case WORKSPACE_APP_KIND.DEVICE_CAPABILITY:
      await updateWorkspaceAppRoot(db, {
        id: params.appId,
        status: WORKSPACE_APP_STATUS.ARCHIVED,
        deletedAt: new Date(),
      })
      await revokeWorkspaceAppGrantsForApp(db, params.appId)
      return true
    default:
      throw new Error("Workspace app deletion is not supported for this kind")
  }
}
