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
import {
  isCompleteWorkspaceAppRow,
  presentGrant,
  presentGrantRequest,
  presentWorkspaceApp,
} from "./presenter.js"

type WorkspaceMemberAccess = {
  workspaceMemberId: string
  workspaceId: string
  userId: string
  ownerId: string
  trustLevel: string
  accessKeys: string[]
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

function targetToSubjectRef(target: CapabilityAccessTarget) {
  return target.subject
}

function targetScopeToSubjectRef(target: CapabilityAccessTarget) {
  return target.scope
}

async function loadWorkspaceMemberAccess(
  workspaceId: string,
  userId: string
): Promise<WorkspaceMemberAccess | null> {
  const row = await db
    .selectFrom("workspaceMembers as wm")
    .innerJoin("workspaces as w", "w.id", "wm.workspaceId")
    .select([
      "wm.id",
      "wm.workspaceId",
      "wm.userId",
      "wm.trustLevel",
      "w.ownerId",
    ])
    .where("wm.workspaceId", "=", workspaceId)
    .where("wm.userId", "=", userId)
    .where("wm.status", "=", "active")
    .where("w.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()
  if (!row) return null

  const accessRows = await db
    .selectFrom("workspaceAccessBindings")
    .select("accessKey")
    .where("workspaceMemberId", "=", row.id)
    .where("status", "=", ACCESS_BINDING_STATUS.ACTIVE)
    .execute()

  return {
    workspaceMemberId: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    ownerId: row.ownerId,
    trustLevel: row.trustLevel,
    accessKeys: accessRows.map((entry) => entry.accessKey),
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
    .selectFrom("workspaceAppGrants")
    .select("id")
    .where("workspaceAppId", "=", workspaceAppId)
    .where("subjectId", "=", memberSubjectId)
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
    .selectFrom("workspaceAppsLive")
    .selectAll()
    .where("id", "=", appId)
    .where("workspaceId", "=", workspaceId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()
  if (!app) {
    throw new Error("Workspace app not found")
  }
  if (
    isWorkspaceAdmin(access) ||
    hasKindAdmin(access, app.kind as WorkspaceAppKind) ||
    app.ownerWorkspaceMemberId === access.workspaceMemberId ||
    (await hasManageGrant(appId, access.workspaceMemberId))
  ) {
    if (!isCompleteWorkspaceAppRow(app)) {
      throw new Error("Workspace app row is incomplete")
    }
    return { access, app }
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
    .selectFrom("workspaceAppsLive")
    .selectAll()
    .where("workspaceId", "=", params.workspaceId)
    .where("deletedAt", "is", null)
    .orderBy("createdAt", "desc")

  if (params.kind) {
    query = query.where("kind", "=", params.kind)
  }

  const isAdmin = isWorkspaceAdmin(access)
  const rows = await query.execute()
  const filtered = await Promise.all(
    rows.map(async (row) => {
      if (!row?.id || !row.kind) return null
      const kind = row.kind as WorkspaceAppKind
      if (isAdmin || hasKindAdmin(access, kind)) return row
      if (row.ownerWorkspaceMemberId === access.workspaceMemberId) return row
      return (await hasManageGrant(row.id, access.workspaceMemberId))
        ? row
        : null
    })
  )
  const visible: WorkspaceAppView[] = []
  for (const row of filtered) {
    if (!isCompleteWorkspaceAppRow(row)) continue
    visible.push(presentWorkspaceApp(row))
  }
  return visible
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
    .selectFrom("workspaceAppGrants as app_grant")
    .innerJoin("workspaceApps as app", "app.id", "app_grant.workspaceAppId")
    .select([
      "app.id",
      "app.workspaceId",
      "app.kind",
      "app.displayName",
      "app.ownerWorkspaceMemberId",
      "app.status",
      "app.conversationTypeMaskOverride",
      "app.createdAt",
      "app.updatedAt",
    ])
    .where("app.workspaceId", "=", params.workspaceId)
    .where("app.deletedAt", "is", null)
    .where("app.status", "=", WORKSPACE_APP_STATUS.ACTIVE)
    .where("app_grant.status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
    .where("app_grant.subjectId", "in", claimSubjectIds)
    .where((eb) =>
      conversationSubjectId
        ? eb.or([
            eb("app_grant.scopeSubjectId", "is", null),
            eb("app_grant.scopeSubjectId", "=", conversationSubjectId),
          ])
        : eb("app_grant.scopeSubjectId", "is", null)
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
    .selectFrom("workspaceAppsLive as app")
    .selectAll()
    .where("app.workspaceId", "=", params.workspaceId)
    .where("app.deletedAt", "is", null)
    .where("app.status", "=", WORKSPACE_APP_STATUS.ACTIVE)
    .where("app.ownerWorkspaceMemberId", "=", identity.workspaceMemberId)
    .where("app.kind", "in", IMPLICIT_OWNER_VISIBLE_WORKSPACE_APP_KINDS)
    .execute()

  const byId = new Map<string, WorkspaceAppView>()
  for (const row of grantRows) {
    byId.set(row.id, presentWorkspaceApp(row))
  }
  for (const row of implicitOwnerRows) {
    if (!isCompleteWorkspaceAppRow(row)) continue
    byId.set(row.id, presentWorkspaceApp(row))
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
  return presentWorkspaceApp(app)
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
    .selectFrom("workspaceAppGrants as app_grant")
    .innerJoin("accessSubjects as subj", "subj.id", "app_grant.subjectId")
    .leftJoin("accessSubjects as scope", "scope.id", "app_grant.scopeSubjectId")
    .select([
      "app_grant.id",
      "app_grant.workspaceId",
      "app_grant.workspaceAppId",
      "app_grant.permissions",
      "app_grant.status",
      "app_grant.source",
      "app_grant.createdByWorkspaceMemberId",
      "app_grant.reason",
      "app_grant.conversationTypeMaskOverride",
      "app_grant.createdAt",
      "app_grant.revokedAt",
      "subj.kind",
      "subj.workspaceId",
      "subj.workspaceMemberId",
      "subj.actorId",
      "subj.remoteAgentId",
      "subj.conversationId",
      "scope.kind as scopeKind",
      "scope.workspaceId as scopeWorkspaceIdViaJoin",
      "scope.conversationId as scopeConversationIdViaJoin",
    ])
    .where("app_grant.workspaceAppId", "=", params.appId)
    .where("app_grant.status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
    .orderBy("app_grant.createdAt", "desc")
    .execute()
  return rows.map((row) => presentGrant(row))
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
    .selectFrom("workspaceAppGrantRequests as app_request")
    .innerJoin(
      "accessSubjects as grantee",
      "grantee.id",
      "app_request.granteeSubjectId"
    )
    .leftJoin(
      "accessSubjects as scope",
      "scope.id",
      "app_request.granteeScopeSubjectId"
    )
    .select([
      "app_request.id",
      "app_request.workspaceId",
      "app_request.workspaceAppId",
      "app_request.requestedPermissions",
      "app_request.requesterWorkspaceMemberId",
      "app_request.status",
      "app_request.resolvedByWorkspaceMemberId",
      "app_request.resolvedAt",
      "app_request.reason",
      "app_request.createdAt",
      "app_request.updatedAt",
      "grantee.kind as granteeKind",
      "grantee.workspaceId as granteeWorkspaceIdViaJoin",
      "grantee.workspaceMemberId as granteeWorkspaceMemberIdViaJoin",
      "grantee.actorId as granteeActorIdViaJoin",
      "grantee.remoteAgentId as granteeRemoteAgentIdViaJoin",
      "grantee.conversationId as granteeConversationIdViaJoin",
      "scope.kind as granteeScopeKind",
      "scope.workspaceId as granteeScopeWorkspaceIdViaJoin",
      "scope.conversationId as granteeScopeConversationIdViaJoin",
    ])
    .where("app_request.workspaceAppId", "=", params.appId)
    .where((eb) =>
      params.direction === WORKSPACE_APP_GRANT_REQUEST_DIRECTION.OUTGOING
        ? eb(
            "app_request.requesterWorkspaceMemberId",
            "=",
            identity.workspaceMemberId
          )
        : eb.val(true)
    )
    .orderBy("app_request.createdAt", "desc")
    .execute()
  return rows.map((row) => presentGrantRequest(row))
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
  return presentGrantRequest({
    ...row,
    granteeKind: SUBJECT_KIND.WORKSPACE_MEMBER,
    granteeWorkspaceIdViaJoin: params.workspaceId,
    granteeWorkspaceMemberIdViaJoin: identity.workspaceMemberId,
    granteeActorIdViaJoin: null,
    granteeRemoteAgentIdViaJoin: null,
    granteeConversationIdViaJoin: null,
    granteeScopeKind: null,
    granteeScopeWorkspaceIdViaJoin: null,
    granteeScopeConversationIdViaJoin: null,
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
    (rows) =>
      rows.find((item) => item.id === row.id) || presentGrantRequest(row)
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
    (rows) =>
      rows.find((item) => item.id === row.id) || presentGrantRequest(row)
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
    .selectFrom("workspaceAppGrantRequests")
    .select([
      "id",
      "workspaceId",
      "workspaceAppId",
      "requesterWorkspaceMemberId",
      "status",
    ])
    .where("id", "=", params.requestId)
    .executeTakeFirst()
  if (!request) {
    throw new Error("Workspace app grant request not found")
  }
  if (
    request.workspaceId !== params.workspaceId ||
    request.workspaceAppId !== params.appId
  ) {
    throw new Error("Workspace app grant request not found")
  }
  if (request.requesterWorkspaceMemberId !== identity.workspaceMemberId) {
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
