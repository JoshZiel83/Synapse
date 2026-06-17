import {
  SUBJECT_KIND,
  WORKSPACE_APP_KIND,
  WORKSPACE_APP_GRANT_PERMISSION,
  WORKSPACE_APP_GRANT_REQUEST_DIRECTION,
  type WorkspaceAppGrantRequestDirection,
  WORKSPACE_APP_GRANT_REQUEST_STATUS,
  WORKSPACE_APP_STATUS,
  type CapabilityAccessTarget,
  type WorkspaceAppGrantPermission,
  type WorkspaceAppKind,
} from "@synapse/shared"
import { requireWorkspaceMemberIdentity } from "../chat/workspace-identity.js"
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
import { resolveWorkspaceAppGrantRequest } from "./grant-storage.js"
import {
  cancelWorkspaceAppGrantRequestDefault,
  findGrantRequestById,
  findManageableWorkspaceApp,
  hasManageGrantForSubject,
  insertWorkspaceAppGrantRequestDefault,
  isSubjectActiveConversationParticipantDefault,
  listGrantedWorkspaceApps,
  listImplicitOwnerWorkspaceApps,
  listWorkspaceAppGrantPresentationRows,
  listWorkspaceAppGrantRequestPresentationRows,
  listWorkspaceAppsLive,
  loadWorkspaceMemberAccessRecord,
  replaceWorkspaceAppGrantsTx,
  revokeWorkspaceAppGrantsForAppDefault,
  updateWorkspaceAppRootDefault,
  upsertWorkspaceAppSubjectIdDefault,
  type WorkspaceMemberAccessRecord,
} from "./repo.js"
import {
  isCompleteWorkspaceAppRow,
  type WorkspaceAppRow,
  type WorkspaceAppGrantPresentationRow,
  type WorkspaceAppGrantRequestPresentationRow,
} from "./presenter.js"

type WorkspaceMemberAccess = WorkspaceMemberAccessRecord

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
  return loadWorkspaceMemberAccessRecord(workspaceId, userId)
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
  return hasManageGrantForSubject(workspaceAppId, workspaceMemberId)
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
  const app = await findManageableWorkspaceApp(appId, workspaceId)
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
}): Promise<WorkspaceAppRow[]> {
  const access = await loadWorkspaceMemberAccess(
    params.workspaceId,
    params.userId
  )
  if (!access) {
    throw new Error("Workspace member not found")
  }

  const isAdmin = isWorkspaceAdmin(access)
  const rows = await listWorkspaceAppsLive(params.workspaceId, params.kind)
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
  const visible: WorkspaceAppRow[] = []
  for (const row of filtered) {
    if (!isCompleteWorkspaceAppRow(row)) continue
    visible.push(row)
  }
  return visible
}

export async function discoverWorkspaceAppsForMember(params: {
  workspaceId: string
  userId: string
  conversationId?: string
}): Promise<WorkspaceAppRow[]> {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  const workspaceSubjectId = await upsertWorkspaceAppSubjectIdDefault({
    kind: SUBJECT_KIND.WORKSPACE,
    workspaceId: params.workspaceId,
  })
  const memberSubjectId = await upsertWorkspaceAppSubjectIdDefault({
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId: identity.workspaceMemberId,
  })

  let conversationSubjectId: string | null = null
  if (params.conversationId) {
    const participant = await isSubjectActiveConversationParticipantDefault(
      params.conversationId,
      memberSubjectId
    )
    if (participant) {
      conversationSubjectId = await upsertWorkspaceAppSubjectIdDefault({
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: params.conversationId,
      })
    }
  }

  const claimSubjectIds = [workspaceSubjectId, memberSubjectId]
  const grantRows = await listGrantedWorkspaceApps({
    workspaceId: params.workspaceId,
    claimSubjectIds,
    conversationSubjectId,
  })

  const implicitOwnerRows = await listImplicitOwnerWorkspaceApps({
    workspaceId: params.workspaceId,
    ownerWorkspaceMemberId: identity.workspaceMemberId,
    kinds: IMPLICIT_OWNER_VISIBLE_WORKSPACE_APP_KINDS,
  })

  const byId = new Map<string, WorkspaceAppRow>()
  for (const row of grantRows) {
    byId.set(row.id, row)
  }
  for (const row of implicitOwnerRows) {
    if (!isCompleteWorkspaceAppRow(row)) continue
    byId.set(row.id, row)
  }
  return Array.from(byId.values())
}

export async function getWorkspaceAppInventoryDetail(params: {
  workspaceId: string
  appId: string
  userId: string
}): Promise<WorkspaceAppRow> {
  const { app } = await requireManageWorkspaceApp(
    params.workspaceId,
    params.appId,
    params.userId
  )
  return app
}

export async function listWorkspaceAppGrantRecords(params: {
  workspaceId: string
  appId: string
  userId: string
}): Promise<WorkspaceAppGrantPresentationRow[]> {
  await requireManageWorkspaceApp(
    params.workspaceId,
    params.appId,
    params.userId
  )
  return listWorkspaceAppGrantPresentationRows(params.appId)
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
}): Promise<WorkspaceAppGrantPresentationRow[]> {
  const { access } = await requireManageWorkspaceApp(
    params.workspaceId,
    params.appId,
    params.userId
  )
  await replaceWorkspaceAppGrantsTx({
    workspaceId: params.workspaceId,
    appId: params.appId,
    grants: params.grants,
    createdByWorkspaceMemberId: access.workspaceMemberId,
  })
  return listWorkspaceAppGrantRecords(params)
}

export async function listWorkspaceAppGrantRequestRecords(params: {
  workspaceId: string
  appId: string
  userId: string
  direction: WorkspaceAppGrantRequestDirection
}): Promise<WorkspaceAppGrantRequestPresentationRow[]> {
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
  return listWorkspaceAppGrantRequestPresentationRows({
    appId: params.appId,
    direction: params.direction,
    requesterWorkspaceMemberId: identity.workspaceMemberId,
  })
}

export async function submitWorkspaceAppGrantRequest(params: {
  workspaceId: string
  appId: string
  userId: string
  reason?: string
}): Promise<WorkspaceAppGrantRequestPresentationRow> {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  const row = await insertWorkspaceAppGrantRequestDefault({
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
  const record: WorkspaceAppGrantRequestPresentationRow = {
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
  }
  return record
}

export async function approveWorkspaceAppGrantRequest(params: {
  workspaceId: string
  appId: string
  requestId: string
  userId: string
}): Promise<WorkspaceAppGrantRequestPresentationRow> {
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
  return listWorkspaceAppGrantRequestRecords({
    workspaceId: params.workspaceId,
    appId: params.appId,
    userId: params.userId,
    direction: WORKSPACE_APP_GRANT_REQUEST_DIRECTION.INCOMING,
  }).then((rows) => rows.find((item) => item.id === row.id) || row)
}

export async function rejectWorkspaceAppGrantRequest(params: {
  workspaceId: string
  appId: string
  requestId: string
  userId: string
}): Promise<WorkspaceAppGrantRequestPresentationRow> {
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
  return listWorkspaceAppGrantRequestRecords({
    workspaceId: params.workspaceId,
    appId: params.appId,
    userId: params.userId,
    direction: WORKSPACE_APP_GRANT_REQUEST_DIRECTION.INCOMING,
  }).then((rows) => rows.find((item) => item.id === row.id) || row)
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
  const request = await findGrantRequestById(params.requestId)
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
  const cancelled = await cancelWorkspaceAppGrantRequestDefault({
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
}): Promise<WorkspaceAppRow> {
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
      appId: installation.row.installationId,
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
}): Promise<WorkspaceAppRow> {
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
      await updateWorkspaceAppRootDefault({
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
      await updateWorkspaceAppRootDefault({
        id: params.appId,
        status: WORKSPACE_APP_STATUS.ARCHIVED,
        deletedAt: new Date(),
      })
      await revokeWorkspaceAppGrantsForAppDefault(params.appId)
      return true
    default:
      throw new Error("Workspace app deletion is not supported for this kind")
  }
}
