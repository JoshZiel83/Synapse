import {
  SUBJECT_KIND,
  WORKSPACE_RESOURCE_KIND,
  WORKSPACE_RESOURCE_GRANT_PERMISSION,
  WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTION,
  type WorkspaceResourceGrantRequestDirection,
  WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS,
  WORKSPACE_RESOURCE_STATUS,
  type CapabilityAccessTarget,
  type SubjectRef,
  type WorkspaceResourceGrantPermission,
  type WorkspaceResourceKind,
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
import { resolveWorkspaceResourceGrantRequest } from "./grant-storage.js"
import {
  cancelWorkspaceResourceGrantRequestDefault,
  findGrantRequestById,
  findManageableWorkspaceResource,
  hasManageGrantForSubject,
  insertWorkspaceResourceGrantRequestDefault,
  isSubjectActiveConversationParticipantDefault,
  listGrantedWorkspaceResources,
  listImplicitOwnerWorkspaceResources,
  listWorkspaceResourceGrantPresentationRows,
  listWorkspaceResourceGrantRequestPresentationRows,
  listWorkspaceResourcesLive,
  loadWorkspaceMemberAccessRecord,
  replaceWorkspaceResourceGrantsTx,
  revokeWorkspaceResourceGrantsForResourceDefault,
  updateWorkspaceResourceRootDefault,
  upsertWorkspaceResourceSubjectIdDefault,
  type WorkspaceMemberAccessRecord,
} from "./repo.js"
import {
  isCompleteWorkspaceResourceRow,
  type WorkspaceResourceRow,
  type WorkspaceResourceGrantPresentationRow,
  type WorkspaceResourceGrantRequestPresentationRow,
} from "./presenter.js"

type WorkspaceMemberAccess = WorkspaceMemberAccessRecord

const IMPLICIT_OWNER_VISIBLE_WORKSPACE_RESOURCE_KINDS = [
  WORKSPACE_RESOURCE_KIND.ACTOR,
  WORKSPACE_RESOURCE_KIND.REMOTE_AGENT,
] as const

function workspaceResourceKindAdminKey(kind: WorkspaceResourceKind): string {
  switch (kind) {
    case WORKSPACE_RESOURCE_KIND.PLUGIN_INSTALLATION:
      return "plugin_admin"
    case WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL:
      return "skill_admin"
    case WORKSPACE_RESOURCE_KIND.ACTOR:
      return "actor_admin"
    case WORKSPACE_RESOURCE_KIND.REMOTE_AGENT:
      return "remote_agent_admin"
    case WORKSPACE_RESOURCE_KIND.RUNTIME_CAPABILITY:
      return "device_admin"
    case WORKSPACE_RESOURCE_KIND.AUTOMATION_EVENT_SOURCE:
      return "automation_admin"
  }
  throw new Error(`Unsupported workspace resource kind: ${kind}`)
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

/**
 * §6.7 manage gate (kind-admin arm): a workspace member holds management rights
 * over a resource kind iff their access record carries that kind's admin access
 * key. This is the arm of `requireManageWorkspaceResource` that authorizes an
 * ownerless resource (e.g. an automation_event_source with no owner_subject_id)
 * without owner-equality. Exported for unit coverage; the surrounding gate is
 * pool-bound and only reachable through the HTTP/service path.
 */
export function hasKindAdmin(
  access: Pick<WorkspaceMemberAccess, "accessKeys">,
  kind: WorkspaceResourceKind
) {
  return access.accessKeys.includes(workspaceResourceKindAdminKey(kind))
}

async function hasManageGrant(
  workspaceResourceId: string,
  workspaceMemberId: string
): Promise<boolean> {
  return hasManageGrantForSubject(workspaceResourceId, workspaceMemberId)
}

/**
 * Authorize "manage" on a workspace_resource for the calling principal.
 *
 * Owner→subject migration (plan §4.2): owner equality is matched BY SUBJECT
 * KIND, not only by member id. A caller may be:
 *  - a workspace_member principal (the HTTP path, `userId`): member-admin /
 *    kind-admin / owner-equality (member subject == owner subject) / manage grant.
 *  - an actor / remote_agent principal (`callerSubject`): owner of ITS OWN
 *    resource only — owner-equality (its subject == owner subject). Such an
 *    owner gets implicit manage but cannot delegate (no manage grant is ever
 *    written for a non-member subject; see validate_workspace_resource_grant).
 *
 * The member access context is still loaded (admins / kind-admin / manage
 * grants are all member-scoped); an actor/remote_agent caller passes its
 * SubjectRef as `callerSubject` and is authorized purely by owner-equality.
 */
async function requireManageWorkspaceResource(
  workspaceId: string,
  resourceId: string,
  userId: string,
  callerSubject?: SubjectRef
) {
  const resource = await findManageableWorkspaceResource(
    resourceId,
    workspaceId
  )
  if (!resource) {
    throw new Error("Workspace resource not found")
  }

  // actor / remote_agent caller: authorized iff it owns this resource.
  if (
    callerSubject &&
    (callerSubject.kind === SUBJECT_KIND.ACTOR ||
      callerSubject.kind === SUBJECT_KIND.REMOTE_AGENT)
  ) {
    const callerSubjectId =
      await upsertWorkspaceResourceSubjectIdDefault(callerSubject)
    if (
      resource.ownerSubjectId &&
      resource.ownerSubjectId === callerSubjectId
    ) {
      if (!isCompleteWorkspaceResourceRow(resource)) {
        throw new Error("Workspace resource row is incomplete")
      }
      return { access: null, resource }
    }
    throw new Error("Not allowed to manage this workspace resource")
  }

  const access = await loadWorkspaceMemberAccess(workspaceId, userId)
  if (!access) {
    throw new Error("Workspace member not found")
  }
  if (
    isWorkspaceAdmin(access) ||
    hasKindAdmin(access, resource.kind as WorkspaceResourceKind) ||
    resource.ownerWorkspaceMemberId === access.workspaceMemberId ||
    (await hasManageGrant(resourceId, access.workspaceMemberId))
  ) {
    if (!isCompleteWorkspaceResourceRow(resource)) {
      throw new Error("Workspace resource row is incomplete")
    }
    return { access, resource }
  }
  throw new Error("Not allowed to manage this workspace resource")
}

/**
 * Member-only variant: asserts the caller resolved to a workspace_member access
 * record (the management/grant flows that write a member id need it). Actor /
 * remote_agent principals never reach these member-scoped flows.
 */
async function requireManageWorkspaceResourceAsMember(
  workspaceId: string,
  resourceId: string,
  userId: string
): Promise<{ access: WorkspaceMemberAccess; resource: WorkspaceResourceRow }> {
  const result = await requireManageWorkspaceResource(
    workspaceId,
    resourceId,
    userId
  )
  if (!result.access) {
    throw new Error("Workspace member not found")
  }
  return { access: result.access, resource: result.resource }
}

export async function listWorkspaceResourcesInventory(params: {
  workspaceId: string
  userId: string
  kind?: WorkspaceResourceKind
}): Promise<WorkspaceResourceRow[]> {
  const access = await loadWorkspaceMemberAccess(
    params.workspaceId,
    params.userId
  )
  if (!access) {
    throw new Error("Workspace member not found")
  }

  const isAdmin = isWorkspaceAdmin(access)
  const rows = await listWorkspaceResourcesLive(params.workspaceId, params.kind)
  const filtered = await Promise.all(
    rows.map(async (row) => {
      if (!row?.id || !row.kind) return null
      const kind = row.kind as WorkspaceResourceKind
      if (isAdmin || hasKindAdmin(access, kind)) return row
      if (row.ownerWorkspaceMemberId === access.workspaceMemberId) return row
      return (await hasManageGrant(row.id, access.workspaceMemberId))
        ? row
        : null
    })
  )
  const visible: WorkspaceResourceRow[] = []
  for (const row of filtered) {
    if (!isCompleteWorkspaceResourceRow(row)) continue
    visible.push(row)
  }
  return visible
}

export async function discoverWorkspaceResourcesForMember(params: {
  workspaceId: string
  userId: string
  conversationId?: string
}): Promise<WorkspaceResourceRow[]> {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  const workspaceSubjectId = await upsertWorkspaceResourceSubjectIdDefault({
    kind: SUBJECT_KIND.WORKSPACE,
    workspaceId: params.workspaceId,
  })
  const memberSubjectId = await upsertWorkspaceResourceSubjectIdDefault({
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    workspaceMemberId: identity.workspaceMemberId,
  })

  let conversationSubjectId: string | null = null
  if (params.conversationId) {
    const participant = await isSubjectActiveConversationParticipantDefault(
      params.conversationId,
      memberSubjectId
    )
    if (participant) {
      conversationSubjectId = await upsertWorkspaceResourceSubjectIdDefault({
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: params.conversationId,
      })
    }
  }

  const claimSubjectIds = [workspaceSubjectId, memberSubjectId]
  const grantRows = await listGrantedWorkspaceResources({
    workspaceId: params.workspaceId,
    claimSubjectIds,
    conversationSubjectId,
  })

  const implicitOwnerRows = await listImplicitOwnerWorkspaceResources({
    workspaceId: params.workspaceId,
    ownerWorkspaceMemberId: identity.workspaceMemberId,
    kinds: IMPLICIT_OWNER_VISIBLE_WORKSPACE_RESOURCE_KINDS,
  })

  const byId = new Map<string, WorkspaceResourceRow>()
  for (const row of grantRows) {
    byId.set(row.id, row)
  }
  for (const row of implicitOwnerRows) {
    if (!isCompleteWorkspaceResourceRow(row)) continue
    byId.set(row.id, row)
  }
  return Array.from(byId.values())
}

export async function getWorkspaceResourceInventoryDetail(params: {
  workspaceId: string
  resourceId: string
  userId: string
}): Promise<WorkspaceResourceRow> {
  const { resource } = await requireManageWorkspaceResource(
    params.workspaceId,
    params.resourceId,
    params.userId
  )
  return resource
}

export async function listWorkspaceResourceGrantRecords(params: {
  workspaceId: string
  resourceId: string
  userId: string
}): Promise<WorkspaceResourceGrantPresentationRow[]> {
  await requireManageWorkspaceResource(
    params.workspaceId,
    params.resourceId,
    params.userId
  )
  return listWorkspaceResourceGrantPresentationRows(params.resourceId)
}

export async function replaceWorkspaceResourceGrants(params: {
  workspaceId: string
  resourceId: string
  userId: string
  grants: Array<{
    target: CapabilityAccessTarget
    permissions: WorkspaceResourceGrantPermission[]
    conversationTypeMaskOverride?: number | null
    reason?: string
  }>
}): Promise<WorkspaceResourceGrantPresentationRow[]> {
  const { access } = await requireManageWorkspaceResourceAsMember(
    params.workspaceId,
    params.resourceId,
    params.userId
  )
  await replaceWorkspaceResourceGrantsTx({
    workspaceId: params.workspaceId,
    resourceId: params.resourceId,
    grants: params.grants,
    createdByWorkspaceMemberId: access.workspaceMemberId,
  })
  return listWorkspaceResourceGrantRecords(params)
}

export async function listWorkspaceResourceGrantRequestRecords(params: {
  workspaceId: string
  resourceId: string
  userId: string
  direction: WorkspaceResourceGrantRequestDirection
}): Promise<WorkspaceResourceGrantRequestPresentationRow[]> {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (
    params.direction === WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTION.INCOMING
  ) {
    await requireManageWorkspaceResource(
      params.workspaceId,
      params.resourceId,
      params.userId
    )
  }
  return listWorkspaceResourceGrantRequestPresentationRows({
    resourceId: params.resourceId,
    direction: params.direction,
    requesterWorkspaceMemberId: identity.workspaceMemberId,
  })
}

export async function submitWorkspaceResourceGrantRequest(params: {
  workspaceId: string
  resourceId: string
  userId: string
  reason?: string
}): Promise<WorkspaceResourceGrantRequestPresentationRow> {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  const row = await insertWorkspaceResourceGrantRequestDefault({
    workspaceId: params.workspaceId,
    workspaceResourceId: params.resourceId,
    grantee: {
      subject: {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        workspaceMemberId: identity.workspaceMemberId,
      },
    },
    requestedPermissions: [WORKSPACE_RESOURCE_GRANT_PERMISSION.CONTACT_VISIBLE],
    requesterWorkspaceMemberId: identity.workspaceMemberId,
    reason: params.reason ?? null,
  })
  const record: WorkspaceResourceGrantRequestPresentationRow = {
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

export async function approveWorkspaceResourceGrantRequest(params: {
  workspaceId: string
  resourceId: string
  requestId: string
  userId: string
}): Promise<WorkspaceResourceGrantRequestPresentationRow> {
  const { access } = await requireManageWorkspaceResourceAsMember(
    params.workspaceId,
    params.resourceId,
    params.userId
  )
  const row = await resolveWorkspaceResourceGrantRequest({
    workspaceId: params.workspaceId,
    workspaceResourceId: params.resourceId,
    requestId: params.requestId,
    approverWorkspaceMemberId: access.workspaceMemberId,
    decision: "approve",
  })
  return listWorkspaceResourceGrantRequestRecords({
    workspaceId: params.workspaceId,
    resourceId: params.resourceId,
    userId: params.userId,
    direction: WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTION.INCOMING,
  }).then((rows) => rows.find((item) => item.id === row.id) || row)
}

export async function rejectWorkspaceResourceGrantRequest(params: {
  workspaceId: string
  resourceId: string
  requestId: string
  userId: string
}): Promise<WorkspaceResourceGrantRequestPresentationRow> {
  const { access } = await requireManageWorkspaceResourceAsMember(
    params.workspaceId,
    params.resourceId,
    params.userId
  )
  const row = await resolveWorkspaceResourceGrantRequest({
    workspaceId: params.workspaceId,
    workspaceResourceId: params.resourceId,
    requestId: params.requestId,
    approverWorkspaceMemberId: access.workspaceMemberId,
    decision: "reject",
  })
  return listWorkspaceResourceGrantRequestRecords({
    workspaceId: params.workspaceId,
    resourceId: params.resourceId,
    userId: params.userId,
    direction: WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTION.INCOMING,
  }).then((rows) => rows.find((item) => item.id === row.id) || row)
}

export async function cancelWorkspaceResourceGrantRequestByRequester(params: {
  workspaceId: string
  resourceId: string
  requestId: string
  userId: string
}): Promise<boolean> {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  const request = await findGrantRequestById(params.requestId)
  if (!request) {
    throw new Error("Workspace resource grant request not found")
  }
  if (
    request.workspaceId !== params.workspaceId ||
    request.workspaceResourceId !== params.resourceId
  ) {
    throw new Error("Workspace resource grant request not found")
  }
  if (request.requesterWorkspaceMemberId !== identity.workspaceMemberId) {
    throw new Error(
      "Not allowed to cancel this workspace resource grant request"
    )
  }
  if (request.status !== WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS.PENDING) {
    throw new Error("Workspace resource grant request is no longer pending")
  }
  const cancelled = await cancelWorkspaceResourceGrantRequestDefault({
    workspaceId: params.workspaceId,
    workspaceResourceId: params.resourceId,
    requestId: params.requestId,
    requesterWorkspaceMemberId: identity.workspaceMemberId,
  })
  if (!cancelled) {
    throw new Error("Workspace resource grant request is no longer pending")
  }
  return true
}

export async function createWorkspaceResource(params: {
  workspaceId: string
  userId: string
  input:
    | {
        kind: typeof WORKSPACE_RESOURCE_KIND.ACTOR
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
          permissions: WorkspaceResourceGrantPermission[]
          conversationTypeMaskOverride?: number | null
          reason?: string
        }>
      }
    | {
        kind: typeof WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL
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
          permissions: WorkspaceResourceGrantPermission[]
          conversationTypeMaskOverride?: number | null
          reason?: string
        }>
      }
    | {
        kind: typeof WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL
        sourceType: "marketplace"
        marketSkillId: string
        grants?: Array<{
          target: CapabilityAccessTarget
          permissions: WorkspaceResourceGrantPermission[]
          conversationTypeMaskOverride?: number | null
          reason?: string
        }>
      }
    | {
        kind: typeof WORKSPACE_RESOURCE_KIND.REMOTE_AGENT
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
          permissions: WorkspaceResourceGrantPermission[]
          conversationTypeMaskOverride?: number | null
          reason?: string
        }>
      }
    | {
        kind: typeof WORKSPACE_RESOURCE_KIND.PLUGIN_INSTALLATION
        pluginId: string
        lifecycleScope?: string
        configData?: Record<string, unknown>
        authSessionIds?: Record<string, string>
        grants?: Array<{
          target: CapabilityAccessTarget
          permissions: WorkspaceResourceGrantPermission[]
          conversationTypeMaskOverride?: number | null
          reason?: string
        }>
      }
}): Promise<WorkspaceResourceRow> {
  if (params.input.kind === WORKSPACE_RESOURCE_KIND.ACTOR) {
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
    return getWorkspaceResourceInventoryDetail({
      workspaceId: params.workspaceId,
      resourceId: actor.id,
      userId: params.userId,
    })
  }

  if (params.input.kind === WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL) {
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
    return getWorkspaceResourceInventoryDetail({
      workspaceId: params.workspaceId,
      resourceId: skill.id,
      userId: params.userId,
    })
  }

  if (params.input.kind === WORKSPACE_RESOURCE_KIND.PLUGIN_INSTALLATION) {
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
    return getWorkspaceResourceInventoryDetail({
      workspaceId: params.workspaceId,
      resourceId: installation.row.installationId,
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
  return getWorkspaceResourceInventoryDetail({
    workspaceId: params.workspaceId,
    resourceId: remoteAgent.remoteAgent.id,
    userId: params.userId,
  })
}

export async function updateWorkspaceResource(params: {
  workspaceId: string
  resourceId: string
  userId: string
  input:
    | {
        kind: typeof WORKSPACE_RESOURCE_KIND.ACTOR
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
        kind: typeof WORKSPACE_RESOURCE_KIND.REMOTE_AGENT
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
        kind: typeof WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL
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
        kind: typeof WORKSPACE_RESOURCE_KIND.RUNTIME_CAPABILITY
        displayName?: string
        conversationTypeMaskOverride?: number | null
      }
    | {
        kind: typeof WORKSPACE_RESOURCE_KIND.PLUGIN_INSTALLATION
        isEnabled?: boolean
        configData?: Record<string, unknown>
        authSessionIds?: Record<string, string>
        lifecycleScope?: string
        conversationTypeMaskOverride?: number | null
      }
}): Promise<WorkspaceResourceRow> {
  const { access, resource } = await requireManageWorkspaceResourceAsMember(
    params.workspaceId,
    params.resourceId,
    params.userId
  )
  if (resource.kind !== params.input.kind) {
    throw new Error("Workspace resource kind does not match update payload")
  }

  switch (params.input.kind) {
    case WORKSPACE_RESOURCE_KIND.ACTOR:
      await updateActor(params.resourceId, params.workspaceId, {
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
    case WORKSPACE_RESOURCE_KIND.REMOTE_AGENT:
      await updateRemoteAgent({
        workspaceId: params.workspaceId,
        remoteAgentId: params.resourceId,
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
    case WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL:
      await updateInstalledSkill({
        workspaceId: params.workspaceId,
        installedSkillId: params.resourceId,
        name: params.input.displayName,
        description: params.input.description as any,
        iconFileId: params.input.iconFileId,
        tags: params.input.tags,
        isEnabled: params.input.isEnabled,
        conversationTypeMaskOverride: params.input.conversationTypeMaskOverride,
        attachmentFiles: params.input.attachmentFiles as any,
      })
      break
    case WORKSPACE_RESOURCE_KIND.PLUGIN_INSTALLATION:
      await updateInstallation(params.resourceId, {
        isEnabled: params.input.isEnabled,
        configData: params.input.configData,
        authSessionIds: params.input.authSessionIds,
        lifecycleScope: params.input.lifecycleScope as any,
        conversationTypeMaskOverride: params.input.conversationTypeMaskOverride,
        updatedByWorkspaceMemberId: access.workspaceMemberId,
      })
      break
    case WORKSPACE_RESOURCE_KIND.RUNTIME_CAPABILITY:
      await updateWorkspaceResourceRootDefault({
        id: params.resourceId,
        displayName: params.input.displayName,
        conversationTypeMaskOverride: params.input.conversationTypeMaskOverride,
      })
      break
    default:
      throw new Error(
        "Workspace resource update is not supported for this kind"
      )
  }

  return getWorkspaceResourceInventoryDetail({
    workspaceId: params.workspaceId,
    resourceId: params.resourceId,
    userId: params.userId,
  })
}

export async function deleteWorkspaceResource(params: {
  workspaceId: string
  resourceId: string
  userId: string
}): Promise<boolean> {
  const { resource } = await requireManageWorkspaceResource(
    params.workspaceId,
    params.resourceId,
    params.userId
  )
  switch (resource.kind) {
    case WORKSPACE_RESOURCE_KIND.ACTOR:
      return deleteActor(params.resourceId, params.workspaceId)
    case WORKSPACE_RESOURCE_KIND.REMOTE_AGENT:
      return (
        await deleteRemoteAgent({
          workspaceId: params.workspaceId,
          remoteAgentId: params.resourceId,
          userId: params.userId,
        })
      ).deleted
    case WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL:
      return uninstallInstalledSkill(params.workspaceId, params.resourceId)
    case WORKSPACE_RESOURCE_KIND.PLUGIN_INSTALLATION:
      await uninstallPluginUnified(params.resourceId)
      return true
    case WORKSPACE_RESOURCE_KIND.RUNTIME_CAPABILITY:
      await updateWorkspaceResourceRootDefault({
        id: params.resourceId,
        status: WORKSPACE_RESOURCE_STATUS.ARCHIVED,
        deletedAt: new Date(),
      })
      await revokeWorkspaceResourceGrantsForResourceDefault(params.resourceId)
      return true
    default:
      throw new Error(
        "Workspace resource deletion is not supported for this kind"
      )
  }
}
