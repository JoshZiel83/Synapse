import {
  CONVERSATION_PARTICIPANT_ROLE_KEY,
  MEMORY_PERMISSION,
  SUBJECT_KIND,
  WORKSPACE_RESOURCE_GRANT_PERMISSION,
  WORKSPACE_RESOURCE_STATUS,
} from "@synapse/shared"
import type { MemoryPermission, SubjectRef } from "@synapse/shared"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import { getWorkspaceCapabilityConversationTypePolicyMap } from "../capabilities/conversation-type-policies.js"
import {
  evaluatePlatformPermission,
  evaluateWorkspacePermission,
} from "./rbac-rules.js"
import { memoryGrantMatches } from "../memory/access-grant-storage.js"
import {
  hasActiveConversationMembership,
  listActorModelGroupIds,
  listOwnedActorIds,
  listOwnedRemoteAgentIds,
  listOwnedWorkspaceResourceAccessRows,
  listWorkspaceResourceAccessRows,
  listWorkspaceResourceAccessRowsByIds,
  listWorkspaceResourceGrantRows,
  listWorkspaceMemberModelGroupIds,
  loadDeviceAccessRow,
  loadDeviceCapabilityAccessRow,
  loadDeviceExposureDeviceId,
  loadActorRow,
  loadConversationRow,
  loadInstalledSkillAccessRow,
  loadMemoryItemSpaceRef,
  loadMemorySpaceWithSubjects,
  loadModelGroupAccessRow,
  loadPluginInstallationAccessRow,
  loadPlatformAccessKeysForUser,
  loadRemoteAgentRow,
  loadWorkspaceMemberAccess,
  type MemorySpaceLoadedRow,
  type WorkspaceMemberAccess,
  type WorkspaceResourceBindableResourceType,
  type WorkspaceResourceAccessRow,
} from "./repo-evaluator.js"
import { upsertAccessSubject } from "./subject-registry.js"

/**
 * Owner→subject migration (plan §4.2): resolve a non-member caller (actor /
 * remote_agent) to its access_subjects id so owner-equality can be matched BY
 * SUBJECT KIND against a resource's `owner_subject_id`. Members are matched by
 * the legacy member-id equality (`ownerWorkspaceMemberId === access.id`), so
 * this returns null for them. An actor/remote_agent owner gets implicit MANAGE
 * on its OWN resource only — never implicit contact_visible, never delegation.
 */
async function ownerSubjectIdForCaller(
  db: KyselyDb,
  subject: PermissionSubject
): Promise<string | null> {
  if (subject.type === "actor") {
    return upsertAccessSubject(db, {
      kind: SUBJECT_KIND.ACTOR,
      actorId: subject.id,
    })
  }
  if (subject.type === "remote_agent") {
    return upsertAccessSubject(db, {
      kind: SUBJECT_KIND.REMOTE_AGENT,
      remoteAgentId: subject.id,
    })
  }
  return null
}

/**
 * True iff the caller is an actor/remote_agent principal that OWNS the resource
 * (its subject id equals the resource owner_subject_id). Used to grant the
 * owner-implicit MANAGE on a self-owned workspace_resource resource.
 */
async function isNonMemberResourceOwner(
  db: KyselyDb,
  subject: PermissionSubject,
  ownerSubjectId: string | null
): Promise<boolean> {
  if (!ownerSubjectId) return false
  if (subject.type !== "actor" && subject.type !== "remote_agent") return false
  const callerSubjectId = await ownerSubjectIdForCaller(db, subject)
  return callerSubjectId != null && callerSubjectId === ownerSubjectId
}

type AccessResourceType =
  | "platform"
  | "workspace"
  | "workspace_member"
  | "user"
  | "actor"
  | "remote_agent"
  | "installed_skill"
  | "plugin_installation"
  | "automation_event_source"
  | "device"
  | "device_exposure"
  | "device_capability"
  | "conversation"
  | "memory_space"
  | "memory_item"
  | "model_group"

type PermissionSubject = {
  type: "user" | "workspace_member" | "actor" | "remote_agent" | "workspace"
  id: string
}

// PR3: re-export the runtime principal context shape so callers can pass it
// to scope-aware overloads of checkPermission / hasResourceGrant. The full
// builder lives in subject-resolution.ts; this is just the type surface
// evaluator consumers need.
export type { RuntimePrincipalContext } from "./subject-resolution.js"

const PLATFORM_RESOURCE_ID = "synapse"

function isWorkspaceOwnerOrAdmin(access: WorkspaceMemberAccess) {
  return access.ownerId === access.userId || access.trustLevel === "admin"
}

function hasWorkspaceAccessKey(
  access: WorkspaceMemberAccess,
  accessKey: string
) {
  return access.accessKeys.includes(accessKey)
}

async function hasPlatformPermission(
  db: KyselyDb,
  subject: PermissionSubject,
  permission: string
): Promise<boolean> {
  let userId: string | null = null
  if (subject.type === "user") {
    userId = subject.id
  } else if (subject.type === "workspace_member") {
    const access = await loadWorkspaceMemberAccess(db, subject.id)
    userId = access?.userId || null
  }
  if (!userId) {
    return false
  }

  const accessKeys = await loadPlatformAccessKeysForUser(db, userId)
  // P8: hardcoded switch replaced with rules table in ./rbac-rules.ts
  return evaluatePlatformPermission(permission, accessKeys)
}

function workspacePermissionFromAccess(
  access: WorkspaceMemberAccess,
  permission: string
) {
  // P8: hardcoded switch replaced with rules table in ./rbac-rules.ts
  return evaluateWorkspacePermission(permission, {
    isAdmin: isWorkspaceOwnerOrAdmin(access),
    accessKeys: access.accessKeys,
    trustLevel: access.trustLevel,
  })
}

async function hasWorkspacePermission(
  db: KyselyDb,
  subject: PermissionSubject,
  workspaceId: string,
  permission: string
): Promise<boolean> {
  if (subject.type === "workspace") {
    return subject.id === workspaceId
  }
  if (subject.type !== "workspace_member") {
    return false
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access || access.workspaceId !== workspaceId) {
    return false
  }

  return workspacePermissionFromAccess(access, permission)
}

async function hasConversationPermission(
  db: KyselyDb,
  subject: PermissionSubject,
  conversationId: string,
  permission: string
): Promise<boolean> {
  const conversation = await loadConversationRow(db, conversationId)
  if (!conversation) {
    return false
  }

  if (subject.type === "workspace_member") {
    const access = await loadWorkspaceMemberAccess(db, subject.id)
    if (!access) {
      return false
    }
    const membership = await hasActiveConversationMembership(db, {
      conversationId,
      workspaceMemberId: subject.id,
    })
    const sameWorkspace =
      Boolean(conversation.workspaceId) &&
      access.workspaceId === conversation.workspaceId
    const isConversationAdmin =
      membership?.roleKey === CONVERSATION_PARTICIPANT_ROLE_KEY.OWNER ||
      membership?.roleKey === CONVERSATION_PARTICIPANT_ROLE_KEY.ADMIN
    const isWorkspaceConversationAdmin =
      sameWorkspace &&
      workspacePermissionFromAccess(access, "manage_conversations")

    switch (permission) {
      case "view":
        return Boolean(membership)
      case "send":
      case "memory_read":
        return Boolean(membership)
      case "memory_edit":
        return Boolean(membership)
      case "manage":
      case "manage_members":
      case "moderate":
      case "attach_resources":
      case "memory_retarget":
      case "memory_delete":
        return isConversationAdmin || isWorkspaceConversationAdmin
      default:
        return false
    }
  }

  if (subject.type === "actor") {
    const membership = await hasActiveConversationMembership(db, {
      conversationId,
      actorId: subject.id,
    })
    if (!membership) {
      return false
    }
    switch (permission) {
      case "view":
      case "send":
      case "memory_read":
      case "memory_edit":
        return true
      default:
        return false
    }
  }

  return false
}

async function hasActorPermission(
  db: KyselyDb,
  subject: PermissionSubject,
  actorId: string,
  permission: string,
  runtimeScopeSubjectIds?: readonly string[],
  runtimeSubjectIds?: readonly string[]
): Promise<boolean> {
  const actor = await loadActorRow(db, actorId)
  if (!actor || !actor.isActive) {
    return false
  }

  if (subject.type === "actor") {
    if (subject.id !== actorId) {
      // A different actor may still be the OWNER of this actor resource (owner→
      // subject migration §4.2): owner actor gets implicit MANAGE on its own
      // resource, no contact_visible / delegation.
      if (await isNonMemberResourceOwner(db, subject, actor.ownerSubjectId)) {
        switch (permission) {
          case "edit":
          case "grant":
          case "delete":
          case "memory_retarget":
          case "memory_delete":
            return true
          default:
            return false
        }
      }
      return false
    }
    switch (permission) {
      case "discover":
      case "view":
      case "invoke":
      case "receive_message":
      case "memory_read":
      case "memory_edit":
      case "memory_retarget":
      case "memory_delete":
        return true
      default:
        return false
    }
  }

  // remote_agent owner of this actor resource → implicit MANAGE on its own.
  if (subject.type === "remote_agent") {
    if (await isNonMemberResourceOwner(db, subject, actor.ownerSubjectId)) {
      switch (permission) {
        case "edit":
        case "grant":
        case "delete":
        case "memory_retarget":
        case "memory_delete":
          return true
        default:
          return false
      }
    }
    return false
  }

  if (subject.type !== "workspace_member") {
    return false
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access || access.workspaceId !== actor.workspaceId) {
    return false
  }

  const canManage =
    isWorkspaceOwnerOrAdmin(access) ||
    hasWorkspaceAccessKey(access, "actor_admin") ||
    actor.ownerWorkspaceMemberId === access.id ||
    (await hasWorkspaceResourceGrant(db, {
      resourceType: "actor",
      resourceId: actorId,
      requiredGrantPermission: "manage",
      subject: {
        type: "workspace_member",
        id: access.id,
      },
      runtimeScopeSubjectIds,
      runtimeSubjectIds,
    }))
  // P2: `canUse` is now derived purely from grants. The historical
  // actor visibility shortcut and friend_entries join have been replaced by
  // workspace_resource_grants rows:
  //   - owners stay implicitly visible to themselves, and
  //   - everyone else needs an explicit contact_visible grant.
  const canUse =
    actor.ownerWorkspaceMemberId === access.id ||
    (await hasWorkspaceResourceGrant(db, {
      resourceType: "actor",
      resourceId: actorId,
      requiredGrantPermission: "contact_visible",
      subject: {
        type: "workspace_member",
        id: access.id,
      },
      runtimeScopeSubjectIds,
      runtimeSubjectIds,
    }))

  switch (permission) {
    case "discover":
    case "view":
    case "invoke":
    case "receive_message":
    case "memory_read":
    case "memory_edit":
      return canUse
    case "edit":
    case "grant":
    case "delete":
    case "memory_retarget":
    case "memory_delete":
      return canManage
    default:
      return false
  }
}

async function hasRemoteAgentPermission(
  db: KyselyDb,
  subject: PermissionSubject,
  remoteAgentId: string,
  permission: string,
  runtimeScopeSubjectIds?: readonly string[],
  runtimeSubjectIds?: readonly string[]
): Promise<boolean> {
  const remoteAgent = await loadRemoteAgentRow(db, remoteAgentId)
  if (!remoteAgent || !remoteAgent.isActive) {
    return false
  }

  // owner→subject migration §4.2: an actor/remote_agent that OWNS this
  // remote_agent resource gets implicit MANAGE on its own resource only.
  if (subject.type === "actor" || subject.type === "remote_agent") {
    if (
      await isNonMemberResourceOwner(db, subject, remoteAgent.ownerSubjectId)
    ) {
      switch (permission) {
        case "edit":
        case "grant":
        case "delete":
          return true
        default:
          return false
      }
    }
    return false
  }

  if (subject.type !== "workspace_member") {
    return false
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access) {
    return false
  }

  const sameWorkspace = access.workspaceId === remoteAgent.workspaceId
  const canManage =
    sameWorkspace &&
    (isWorkspaceOwnerOrAdmin(access) ||
      hasWorkspaceAccessKey(access, "remote_agent_admin") ||
      remoteAgent.ownerWorkspaceMemberId === access.id ||
      (await hasWorkspaceResourceGrant(db, {
        resourceType: "remote_agent",
        resourceId: remoteAgentId,
        requiredGrantPermission: "manage",
        subject: {
          type: "workspace_member",
          id: access.id,
        },
        runtimeScopeSubjectIds,
        runtimeSubjectIds,
      })))
  // P2: same fold as hasActorPermission — grants are authoritative.
  // Cross-workspace `is_public_shared` still requires an explicit grant to
  // be granted; the publishing workspace's auto-write happens on create.
  const canUse =
    (sameWorkspace && remoteAgent.ownerWorkspaceMemberId === access.id) ||
    (await hasWorkspaceResourceGrant(db, {
      resourceType: "remote_agent",
      resourceId: remoteAgentId,
      requiredGrantPermission: "contact_visible",
      subject: {
        type: "workspace_member",
        id: access.id,
      },
      runtimeScopeSubjectIds,
      runtimeSubjectIds,
    }))

  switch (permission) {
    case "discover":
    case "view":
    case "invoke":
    case "receive_message":
      return canUse
    case "edit":
    case "grant":
    case "delete":
      return canManage
    default:
      return false
  }
}

async function hasWorkspaceResourceGrant(
  db: KyselyDb,
  params: {
    resourceType:
      | "installed_skill"
      | "plugin_installation"
      | "device_capability"
      | "actor"
      | "remote_agent"
      | "automation_event_source"
    resourceId: string
    requiredGrantPermission: "use" | "contact_visible" | "manage"
    subject: PermissionSubject
    runtimeScopeSubjectIds?: readonly string[]
    runtimeSubjectIds?: readonly string[]
  }
) {
  const rows = await listWorkspaceResourceGrantRows(db, {
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    requiredGrantPermission: params.requiredGrantPermission,
    subject: params.subject,
    runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
    runtimeSubjectIds: params.runtimeSubjectIds,
  })
  return rows.length > 0
}

async function listGrantedWorkspaceResourceIds(
  db: KyselyDb,
  params: {
    resourceType:
      | "installed_skill"
      | "plugin_installation"
      | "device_capability"
      | "actor"
      | "remote_agent"
      | "automation_event_source"
    requiredGrantPermission: "use" | "contact_visible"
    subject: PermissionSubject
    limit?: number
    runtimeScopeSubjectIds?: readonly string[]
    runtimeSubjectIds?: readonly string[]
  }
) {
  const rows = await listWorkspaceResourceGrantRows(db, {
    resourceType: params.resourceType,
    resourceId: null,
    requiredGrantPermission: params.requiredGrantPermission,
    subject: params.subject,
    runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
    runtimeSubjectIds: params.runtimeSubjectIds,
  })
  const ids = Array.from(new Set(rows.map((row) => row.resourceId)))
  return typeof params.limit === "number" && params.limit > 0
    ? ids.slice(0, params.limit)
    : ids
}

function isBindableWorkspaceResourceManagementVisible(status: string) {
  return status !== WORKSPACE_RESOURCE_STATUS.ARCHIVED
}

async function listManageableWorkspaceResourceIds(
  db: KyselyDb,
  params: {
    resourceType: WorkspaceResourceBindableResourceType
    manageAccessKey: string
    subject: PermissionSubject
    limit?: number
    runtimeScopeSubjectIds?: readonly string[]
    runtimeSubjectIds?: readonly string[]
  }
) {
  if (params.subject.type !== "workspace_member") {
    return []
  }

  const access = await loadWorkspaceMemberAccess(db, params.subject.id)
  if (!access) {
    return []
  }

  const manageableIds = (rows: WorkspaceResourceAccessRow[]) =>
    rows.flatMap((row) =>
      typeof row.id === "string" &&
      typeof row.status === "string" &&
      isBindableWorkspaceResourceManagementVisible(row.status)
        ? [row.id]
        : []
    )
  if (workspacePermissionFromAccess(access, params.manageAccessKey)) {
    const rows = await listWorkspaceResourceAccessRows(db, {
      workspaceId: access.workspaceId,
      resourceType: params.resourceType,
    })
    return finalizeResourceIdList([manageableIds(rows)], params.limit)
  }

  const [ownRows, grantRows] = await Promise.all([
    listOwnedWorkspaceResourceAccessRows(db, {
      workspaceId: access.workspaceId,
      resourceType: params.resourceType,
      ownerWorkspaceMemberId: access.id,
    }),
    listWorkspaceResourceGrantRows(db, {
      resourceType: params.resourceType,
      resourceId: null,
      requiredGrantPermission: WORKSPACE_RESOURCE_GRANT_PERMISSION.MANAGE,
      subject: params.subject,
      runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
      runtimeSubjectIds: params.runtimeSubjectIds,
    }),
  ])

  const grantedIds = Array.from(new Set(grantRows.map((row) => row.resourceId)))
  const grantedRows =
    grantedIds.length === 0
      ? []
      : await listWorkspaceResourceAccessRowsByIds(db, {
          ids: grantedIds,
          workspaceId: access.workspaceId,
          resourceType: params.resourceType,
        })

  return finalizeResourceIdList(
    [manageableIds(ownRows), manageableIds(grantedRows)],
    params.limit
  )
}

async function listBindableWorkspaceResourceIdsForPermission(
  db: KyselyDb,
  params: {
    resourceType: WorkspaceResourceBindableResourceType
    permission: string
    manageAccessKey: string
    subject: PermissionSubject
    limit?: number
    runtimeScopeSubjectIds?: readonly string[]
    runtimeSubjectIds?: readonly string[]
  }
) {
  if (params.permission === "use") {
    return listGrantedWorkspaceResourceIds(db, {
      resourceType: params.resourceType,
      requiredGrantPermission: WORKSPACE_RESOURCE_GRANT_PERMISSION.USE,
      subject: params.subject,
      limit: params.limit,
      runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
      runtimeSubjectIds: params.runtimeSubjectIds,
    })
  }

  if (params.permission === "request_runtime_authorization") {
    return params.resourceType === "device_capability"
      ? listGrantedWorkspaceResourceIds(db, {
          resourceType: params.resourceType,
          requiredGrantPermission: WORKSPACE_RESOURCE_GRANT_PERMISSION.USE,
          subject: params.subject,
          limit: params.limit,
          runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
          runtimeSubjectIds: params.runtimeSubjectIds,
        })
      : []
  }

  if (params.permission === "view") {
    return listGrantedWorkspaceResourceIds(db, {
      resourceType: params.resourceType,
      requiredGrantPermission: WORKSPACE_RESOURCE_GRANT_PERMISSION.USE,
      subject: params.subject,
      limit: params.limit,
      runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
      runtimeSubjectIds: params.runtimeSubjectIds,
    })
  }

  if (
    params.permission === "edit" ||
    params.permission === "grant" ||
    params.permission === "delete"
  ) {
    return listManageableWorkspaceResourceIds(db, {
      resourceType: params.resourceType,
      manageAccessKey: params.manageAccessKey,
      subject: params.subject,
      limit: params.limit,
      runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
      runtimeSubjectIds: params.runtimeSubjectIds,
    })
  }

  return []
}

function finalizeResourceIdList(groups: readonly string[][], limit?: number) {
  const merged: string[] = []
  const seen = new Set<string>()

  for (const group of groups) {
    for (const id of group) {
      if (!id || seen.has(id)) {
        continue
      }
      seen.add(id)
      merged.push(id)
      if (typeof limit === "number" && limit > 0 && merged.length >= limit) {
        return merged
      }
    }
  }

  return merged
}

/**
 * 3d: shared access skeleton for the workspace-bound, bindable, "manage-or-grant"
 * resources — installed_skill / plugin_installation / device_capability. Once
 * the resource row is loaded (which is the only genuinely per-resource step:
 * different table / columns / active predicate), all three resolved access
 * identically:
 *   1. for the "use"-like (grantable) permissions, an explicit
 *      workspace_resource_grants row short-circuits to allow;
 *   2. for the manage-only permissions, a workspace_member in
 *      the SAME workspace passes iff they hold the manage access key OR created
 *      the resource;
 *   3. any permission outside BOTH sets fail-closes — consistent with the
 *      `default: return false` arms in hasActorPermission / hasRemoteAgentPermission
 *      / hasDevicePermission. (The pre-refactor per-resource tails returned
 *      `canManage` for ANY permission, i.e. fail-OPEN to managers on an unknown
 *      permission string; the explicit `manageablePermissions` whitelist closes
 *      that asymmetry. All real call sites flow through actions.ts, so only a
 *      bug/typo could hit the unknown branch — now it denies instead of
 *      silently allowing managers.)
 * The callers differ ONLY in (table-loaded) workspaceId, the owner member id,
 * the manage access key, and which permissions are grantable / manageable — all
 * passed in.
 *
 * Actor / remote_agent are intentionally NOT routed through this: they carry a
 * canUse-vs-canManage permission split, an actor-acts-on-itself principal
 * branch, and (for remote_agent) a cross-workspace public-shared grant path
 * that fold workspace membership into canManage rather than gating on it — none
 * of which this skeleton models. Unifying them here would change their
 * semantics, so they keep their own bodies.
 */
async function resolveBindableResourceAccess(
  db: KyselyDb,
  params: {
    resourceType: WorkspaceResourceBindableResourceType
    resourceId: string
    workspaceId: string
    ownerWorkspaceMemberId: string | null
    ownerSubjectId: string | null
    manageAccessKey: string
    /** Permissions an explicit grant can satisfy (the "use"-like set). */
    grantablePermissions: readonly string[]
    /** Permissions the manage-key/creator path can satisfy. */
    manageablePermissions: readonly string[]
    requiredGrantPermission: "use"
    subject: PermissionSubject
    permission: string
    runtimeScopeSubjectIds?: readonly string[]
    runtimeSubjectIds?: readonly string[]
  }
): Promise<boolean> {
  const isGrantable = params.grantablePermissions.includes(params.permission)
  const isManageable = params.manageablePermissions.includes(params.permission)

  // Unknown permission (in neither set) → fail closed. Mirrors the
  // `default: return false` arms in the non-bindable helpers.
  if (!isGrantable && !isManageable) {
    return false
  }

  // (1) explicit-grant short-circuit for the use-like permissions.
  if (isGrantable) {
    if (
      await hasWorkspaceResourceGrant(db, {
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        requiredGrantPermission: params.requiredGrantPermission,
        subject: params.subject,
        runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
        runtimeSubjectIds: params.runtimeSubjectIds,
      })
    ) {
      return true
    }
  }

  if (!isManageable) {
    return false
  }

  // (2a) owner→subject migration §4.2: an actor/remote_agent that OWNS this
  // resource gets implicit MANAGE on its own resource only (no delegation, no
  // contact_visible). Computed by owner-equality; never written as a grant row.
  if (
    params.subject.type === "actor" ||
    params.subject.type === "remote_agent"
  ) {
    return isNonMemberResourceOwner(db, params.subject, params.ownerSubjectId)
  }

  // (2b) manage path — workspace_member in the same workspace, holding the
  // manage key or being the resource owner.
  if (params.subject.type !== "workspace_member") {
    return false
  }

  const access = await loadWorkspaceMemberAccess(db, params.subject.id)
  if (!access || access.workspaceId !== params.workspaceId) {
    return false
  }

  return (
    (await hasWorkspaceResourceGrant(db, {
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      requiredGrantPermission: "manage",
      subject: params.subject,
      runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
      runtimeSubjectIds: params.runtimeSubjectIds,
    })) ||
    workspacePermissionFromAccess(access, params.manageAccessKey) ||
    params.ownerWorkspaceMemberId === access.id
  )
}

async function hasInstalledSkillPermission(
  db: KyselyDb,
  subject: PermissionSubject,
  skillId: string,
  permission: string,
  runtimeScopeSubjectIds?: readonly string[],
  runtimeSubjectIds?: readonly string[]
): Promise<boolean> {
  const managementVisiblePermissions = ["edit", "grant", "delete"] as const
  const manageablePermissions = ["view", "edit", "grant", "delete"] as const
  const row = await loadInstalledSkillAccessRow(db, skillId)
  if (!row) {
    return false
  }

  const isManagementPermission = managementVisiblePermissions.includes(
    permission as any
  )
  if (
    (isManagementPermission &&
      !isBindableWorkspaceResourceManagementVisible(row.status)) ||
    (!isManagementPermission && row.status !== WORKSPACE_RESOURCE_STATUS.ACTIVE)
  ) {
    return false
  }

  return resolveBindableResourceAccess(db, {
    resourceType: "installed_skill",
    resourceId: skillId,
    workspaceId: row.workspaceId,
    ownerWorkspaceMemberId: row.ownerWorkspaceMemberId,
    ownerSubjectId: row.ownerSubjectId,
    manageAccessKey: "manage_skills",
    grantablePermissions: ["use", "view"],
    manageablePermissions,
    requiredGrantPermission: "use",
    subject,
    permission,
    runtimeScopeSubjectIds,
    runtimeSubjectIds,
  })
}

async function hasPluginInstallationPermission(
  db: KyselyDb,
  subject: PermissionSubject,
  installationId: string,
  permission: string,
  runtimeScopeSubjectIds?: readonly string[],
  runtimeSubjectIds?: readonly string[]
): Promise<boolean> {
  const managementVisiblePermissions = ["edit", "grant", "delete"] as const
  const manageablePermissions = ["view", "edit", "grant", "delete"] as const
  const row = await loadPluginInstallationAccessRow(db, installationId)
  if (!row) {
    return false
  }

  const isManagementPermission = managementVisiblePermissions.includes(
    permission as any
  )
  if (
    (isManagementPermission &&
      !isBindableWorkspaceResourceManagementVisible(row.status)) ||
    (!isManagementPermission && row.status !== WORKSPACE_RESOURCE_STATUS.ACTIVE)
  ) {
    return false
  }

  return resolveBindableResourceAccess(db, {
    resourceType: "plugin_installation",
    resourceId: installationId,
    workspaceId: row.workspaceId,
    ownerWorkspaceMemberId: row.ownerWorkspaceMemberId,
    ownerSubjectId: row.ownerSubjectId,
    manageAccessKey: "manage_plugins",
    grantablePermissions: ["use", "view"],
    manageablePermissions,
    requiredGrantPermission: "use",
    subject,
    permission,
    runtimeScopeSubjectIds,
    runtimeSubjectIds,
  })
}

async function hasDevicePermission(
  db: KyselyDb,
  subject: PermissionSubject,
  deviceId: string,
  permission: string
): Promise<boolean> {
  const managementVisiblePermissions = ["edit", "grant", "delete"] as const
  const row = await loadDeviceAccessRow(db, deviceId)
  if (!row) {
    return false
  }

  if (subject.type === "user") {
    if (permission !== "authorize_runtime_authorization") {
      return false
    }
    return hasPlatformPermission(db, subject, "manage")
  }

  if (subject.type !== "workspace_member") {
    return false
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access || access.workspaceId !== row.workspaceId) {
    return false
  }

  const canManage =
    workspacePermissionFromAccess(access, "manage_devices") ||
    row.ownerWorkspaceMemberId === access.id

  switch (permission) {
    case "view":
    case "manage":
    case "delete":
    case "authorize_runtime_authorization":
      return canManage
    default:
      return false
  }
}

async function hasExposurePermission(
  db: KyselyDb,
  subject: PermissionSubject,
  exposureId: string,
  permission: string
): Promise<boolean> {
  const managementVisiblePermissions = ["edit", "grant", "delete"] as const
  const deviceId = await loadDeviceExposureDeviceId(db, exposureId)
  if (!deviceId) {
    return false
  }
  return hasDevicePermission(
    db,
    subject,
    deviceId,
    permission === "view" ? "view" : "manage"
  )
}

async function hasCapabilityPermission(
  db: KyselyDb,
  subject: PermissionSubject,
  capabilityId: string,
  permission: string,
  runtimeScopeSubjectIds?: readonly string[],
  runtimeSubjectIds?: readonly string[]
): Promise<boolean> {
  const managementVisiblePermissions = ["edit", "grant", "delete"] as const
  const row = await loadDeviceCapabilityAccessRow(db, capabilityId)
  if (!row) {
    return false
  }

  const isManagementPermission = managementVisiblePermissions.includes(
    permission as any
  )
  if (
    (isManagementPermission &&
      !isBindableWorkspaceResourceManagementVisible(row.status)) ||
    (!isManagementPermission && row.status !== WORKSPACE_RESOURCE_STATUS.ACTIVE)
  ) {
    return false
  }

  return resolveBindableResourceAccess(db, {
    resourceType: "device_capability",
    resourceId: capabilityId,
    workspaceId: row.workspaceId,
    ownerWorkspaceMemberId: row.ownerWorkspaceMemberId,
    ownerSubjectId: row.ownerSubjectId,
    manageAccessKey: "manage_devices",
    grantablePermissions: ["use", "view", "request_runtime_authorization"],
    manageablePermissions: [
      "view",
      "request_runtime_authorization",
      "edit",
      "grant",
      "delete",
    ],
    requiredGrantPermission: "use",
    subject,
    permission,
    runtimeScopeSubjectIds,
    runtimeSubjectIds,
  })
}

async function listActorIds(
  db: KyselyDb,
  subject: PermissionSubject,
  limit?: number,
  runtimeScopeSubjectIds?: readonly string[],
  runtimeSubjectIds?: readonly string[]
) {
  if (subject.type !== "workspace_member") {
    return subject.type === "actor" ? [subject.id] : []
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access) {
    return []
  }

  // Visible actors = actors created by this member +
  // grants reachable by the workspace_member subject. listResourceGrantRows's
  // workspace_member branch already matches both:
  //   (a) workspace-scoped grants, and
  //   (b) workspace_member-scoped approval grants for this specific member.
  // Passing the member subject directly is what makes (b) visible here.
  const [ownActorIds, grantedIds] = await Promise.all([
    listOwnedActorIds(db, {
      workspaceId: access.workspaceId,
      ownerWorkspaceMemberId: access.id,
    }),
    listGrantedWorkspaceResourceIds(db, {
      resourceType: "actor",
      requiredGrantPermission: "contact_visible",
      subject,
      runtimeScopeSubjectIds,
      runtimeSubjectIds,
    }),
  ])
  return finalizeResourceIdList([ownActorIds, grantedIds], limit)
}

async function listRemoteAgentIds(
  db: KyselyDb,
  subject: PermissionSubject,
  limit?: number,
  runtimeScopeSubjectIds?: readonly string[],
  runtimeSubjectIds?: readonly string[]
) {
  if (subject.type !== "workspace_member") {
    return []
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access) {
    return []
  }

  // P2: same-workspace remote-agent visibility now comes from
  // workspace_resource_grants. Cross-workspace public-shared discovery remains in
  // the relationship/friend model and is handled outside this grant lookup.
  const [ownAgentIds, grantedIds] = await Promise.all([
    listOwnedRemoteAgentIds(db, {
      workspaceId: access.workspaceId,
      ownerWorkspaceMemberId: access.id,
    }),
    listGrantedWorkspaceResourceIds(db, {
      resourceType: "remote_agent",
      requiredGrantPermission: "contact_visible",
      subject,
      runtimeScopeSubjectIds,
      runtimeSubjectIds,
    }),
  ])
  return finalizeResourceIdList([ownAgentIds, grantedIds], limit)
}

async function listModelGroupIds(
  db: KyselyDb,
  subject: PermissionSubject,
  limit?: number
) {
  if (subject.type === "actor") {
    const actor = await loadActorRow(db, subject.id)
    if (!actor) {
      return []
    }
    return listActorModelGroupIds(db, {
      workspaceId: actor.workspaceId,
      actorId: subject.id,
      limit,
    })
  }

  if (subject.type !== "workspace_member") {
    return []
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access) {
    return []
  }

  return listWorkspaceMemberModelGroupIds(db, {
    workspaceId: access.workspaceId,
    workspaceMemberId: access.id,
    limit,
  })
}

async function hasModelGroupPermission(
  db: KyselyDb,
  subject: PermissionSubject,
  groupId: string,
  permission: string
): Promise<boolean> {
  const row = await loadModelGroupAccessRow(db, groupId)
  if (!row || !row.isEnabled) {
    return false
  }

  if (permission === "use" || permission === "view") {
    const allowedIds = new Set(await listModelGroupIds(db, subject))
    if (allowedIds.has(groupId)) {
      return true
    }
  }

  if (subject.type === "workspace_member") {
    const access = await loadWorkspaceMemberAccess(db, subject.id)
    if (!access) {
      return false
    }

    if (
      row.ownerType === "workspace_member" &&
      row.ownerWorkspaceMemberId === access.id
    ) {
      return true
    }

    if (
      row.ownerType === "workspace" &&
      row.ownerWorkspaceId === access.workspaceId &&
      workspacePermissionFromAccess(access, "manage_models")
    ) {
      return true
    }

    if (row.ownerType === "platform") {
      return hasPlatformPermission(
        db,
        { type: "workspace_member", id: access.id },
        "manage_models"
      )
    }
  }

  return false
}

/**
 * D4: owner-implicit permission for a memory_space, given the loaded space
 * row. The rule per the plan:
 *   - owner=workspace_member  -> ALL permissions {read, recall, write, edit, delete, manage}
 *   - owner=actor             -> {read, recall, write, edit, delete} (no manage)
 *   - owner=remote_agent      -> {read, recall, write, edit} (no delete, no manage)
 *   - owner=workspace         -> view-grants-read/recall; manage_memories-grants-write/edit/delete/manage
 *   - owner=conversation      -> active participant grants {read, recall, write, edit}
 *
 * `scope_subject_id` is a strong constraint and gates ALL owner kinds — when
 * a space is scoped to conversation C, callers outside C cannot read/recall/
 * write/edit it regardless of owner kind or workspace permissions. The single
 * exception is the workspace-admin manage override (`manage_memories`), which
 * only unlocks `manage` / `delete` so an admin can clean up scoped spaces
 * without being able to silently view their contents.
 *
 * Asymmetric admin/creator path (post-D4 round 3 review fix, narrowed
 * further in round 4 review): for `actor` and `remote_agent` owners,
 * **write only** admits a curation path — workspace admins /
 * `actor_admin` / `remote_agent_admin` / the resource's creator can
 * author new content into the space. Read/recall stay strictly private,
 * AND `edit` / `delete` are NOT in the curation path either: edit on an
 * existing item lets the caller PUT and read back the contents, which
 * would defeat the "admin can curate seed memories without later being
 * able to read what accumulated" invariant. Removed-edit is a deliberate
 * narrowing — admin who needs to amend a private memory must hold an
 * explicit memory_access_grant. The strict allowlist is enforced by
 * routing through `hasActorPermission(... "edit")` / `hasRemoteAgentPermission(... "edit")`
 * which return only `canManage` (admin / *_admin / creator) — not the
 * `canUse` superset that would have admitted any caller with an
 * `actor.memory_edit` grant.
 */
async function hasMemorySpaceOwnerImplicitPermission(
  db: KyselyDb,
  subject: PermissionSubject,
  space: MemorySpaceLoadedRow,
  permission: string,
  runtimeContext?: {
    runtimeSubjectIds?: readonly string[]
    runtimeScopeSubjectIds?: readonly string[]
  }
): Promise<boolean> {
  const inRuntime = (subjectId: string) =>
    runtimeContext?.runtimeSubjectIds?.includes(subjectId) ?? false

  const scopeOk =
    !space.scopeSubjectId ||
    (runtimeContext?.runtimeScopeSubjectIds?.includes(space.scopeSubjectId) ??
      false)

  const adminManageOverride = async (): Promise<boolean> => {
    if (permission !== "manage" && permission !== "delete") return false
    return hasWorkspacePermission(
      db,
      subject,
      space.workspaceId,
      "manage_memories"
    )
  }

  if (!scopeOk) {
    return adminManageOverride()
  }

  switch (space.ownerKind) {
    case "workspace_member":
      if (inRuntime(space.ownerSubjectId)) {
        return true // all permissions
      }
      return adminManageOverride()
    case "actor":
      if (inRuntime(space.ownerSubjectId)) {
        return permission !== "manage"
      }
      // Curation path (post-D4 round 4 narrowing): admins / actor_admin /
      // actor creator can author NEW content (write only) into the
      // actor's private memory space. `edit` and `delete` are NOT in
      // this allowlist — edit on an existing item lets the caller PUT
      // and read back the contents (defeats the read-isolation invariant)
      // and delete should require an explicit memory_access_grant or the
      // workspace manage_memories override below. Calling
      // `hasActorPermission(actor, "edit")` returns the strict canManage
      // (admin/*_admin/creator) — not `canUse`, which would have admitted
      // anyone with an `actor.memory_edit` grant.
      if (
        space.ownerActorId &&
        permission === "write" &&
        (await hasActorPermission(db, subject, space.ownerActorId, "edit"))
      ) {
        return true
      }
      return adminManageOverride()
    case "remote_agent":
      if (inRuntime(space.ownerSubjectId)) {
        return (
          permission === "read" ||
          permission === "recall" ||
          permission === "write" ||
          permission === "edit"
        )
      }
      // Same write-only curation pattern as actor — see comment above.
      if (
        space.ownerRemoteAgentId &&
        permission === "write" &&
        (await hasRemoteAgentPermission(
          db,
          subject,
          space.ownerRemoteAgentId,
          "edit"
        ))
      ) {
        return true
      }
      return adminManageOverride()
    case "workspace":
      if (permission === "read" || permission === "recall") {
        if (subject.type === "actor") {
          const actor = await loadActorRow(db, subject.id)
          return Boolean(
            actor && actor.workspaceId === space.workspaceId && actor.isActive
          )
        }
        return hasWorkspacePermission(db, subject, space.workspaceId, "view")
      }
      return hasWorkspacePermission(
        db,
        subject,
        space.workspaceId,
        "manage_memories"
      )
    case "conversation":
      if (!space.ownerConversationId) return false
      if (permission === "manage" || permission === "delete") {
        return hasConversationPermission(
          db,
          subject,
          space.ownerConversationId,
          permission === "manage" ? "manage" : "memory_delete"
        )
      }
      return hasConversationPermission(
        db,
        subject,
        space.ownerConversationId,
        permission === "read" || permission === "recall"
          ? "memory_read"
          : "memory_edit"
      )
    default:
      return false
  }
}

async function hasMemoryItemPermission(
  db: KyselyDb,
  subject: PermissionSubject,
  memoryItemId: string,
  permission: string,
  runtimeContext?: {
    runtimeSubjectIds?: readonly string[]
    runtimeScopeSubjectIds?: readonly string[]
  }
): Promise<boolean> {
  const row = await loadMemoryItemSpaceRef(db, memoryItemId)
  if (!row) return false

  // Space-level permission (owner-implicit OR space-level grant).
  if (
    await hasMemorySpacePermission(
      db,
      subject,
      row.memorySpaceId,
      permission,
      runtimeContext
    )
  ) {
    return true
  }

  // Item-level grant overlay — only honored when caller provided a runtime
  // context.
  if (
    runtimeContext?.runtimeSubjectIds &&
    runtimeContext.runtimeSubjectIds.length > 0
  ) {
    const grantPermission = mapEvaluatorPermissionToMemoryPermission(permission)
    if (grantPermission) {
      const granted = await memoryGrantMatches(db, {
        memorySpaceId: row.memorySpaceId,
        memoryItemId: row.memoryItemId,
        permission: grantPermission,
        runtimeSubjectIds: runtimeContext.runtimeSubjectIds,
        runtimeScopeSubjectIds: runtimeContext.runtimeScopeSubjectIds ?? [],
        mode: "with-item",
      })
      if (granted) return true
    }
  }

  return false
}

function mapEvaluatorPermissionToMemoryPermission(
  permission: string
): MemoryPermission | null {
  switch (permission) {
    case "read":
      return MEMORY_PERMISSION.READ
    case "recall":
      return MEMORY_PERMISSION.RECALL
    case "edit":
      return MEMORY_PERMISSION.EDIT
    case "write":
      return MEMORY_PERMISSION.WRITE
    case "delete":
      return MEMORY_PERMISSION.DELETE
    case "manage":
      return MEMORY_PERMISSION.MANAGE
    default:
      return null
  }
}

/**
 * D4: space-level permission. Either:
 *   - owner-implicit (owner_subject_id ∈ runtimeSubjectIds AND scope match),
 *     subject to the per-owner-kind matrix in hasMemorySpaceOwnerImplicitPermission,
 *   - or an active space-level memory_access_grants row matches.
 *
 * Item-level grants are NOT considered here — they only count when an item id
 * is also supplied (see hasMemoryItemPermission).
 */
async function hasMemorySpacePermission(
  db: KyselyDb,
  subject: PermissionSubject,
  memorySpaceId: string,
  permission: string,
  runtimeContext?: {
    runtimeSubjectIds?: readonly string[]
    runtimeScopeSubjectIds?: readonly string[]
  }
): Promise<boolean> {
  const space = await loadMemorySpaceWithSubjects(db, memorySpaceId)
  if (!space) return false

  // Owner-implicit first — cheap and covers the common case.
  if (
    await hasMemorySpaceOwnerImplicitPermission(
      db,
      subject,
      space,
      permission,
      runtimeContext
    )
  ) {
    return true
  }

  // Space-level grant overlay.
  if (
    runtimeContext?.runtimeSubjectIds &&
    runtimeContext.runtimeSubjectIds.length > 0
  ) {
    const grantPermission = mapEvaluatorPermissionToMemoryPermission(permission)
    if (grantPermission) {
      const granted = await memoryGrantMatches(db, {
        memorySpaceId: space.id,
        permission: grantPermission,
        runtimeSubjectIds: runtimeContext.runtimeSubjectIds,
        runtimeScopeSubjectIds: runtimeContext.runtimeScopeSubjectIds ?? [],
        mode: "space-only",
      })
      if (granted) return true
    }
  }

  return false
}

/**
 * Post-D4 round 3 review: evaluate the owner-implicit memory_space
 * permission against a (workspace_id, owner_subject_id + decoded fields,
 * scope_subject_id) tuple WITHOUT requiring an existing space row. Used
 * by the create / move auth gate so we can decide allowance before
 * INSERTing a placeholder space (the previous flow created an empty
 * orphan row on every denied write).
 *
 * No grant overlay is consulted — by definition the space doesn't exist
 * yet, so no `memory_access_grants` row can target it. The caller path
 * uses this only for the "space not yet in DB" branch; existing spaces
 * still go through `checkPermission(memory_space, id, ...)` which
 * applies the full owner-implicit + grant matrix.
 */
export async function hasMemorySpaceOwnerImplicitPermissionForTuple(
  db: KyselyDb,
  subject: PermissionSubject,
  tuple: {
    workspaceId: string
    owner: SubjectRef
    scope?: SubjectRef
    ownerSubjectId: string
    scopeSubjectId: string | null
  },
  permission: string,
  runtimeContext?: {
    runtimeSubjectIds?: readonly string[]
    runtimeScopeSubjectIds?: readonly string[]
  }
): Promise<boolean> {
  // Build a synthetic MemorySpaceLoadedRow from the decomposed inputs.
  // owner_kind drives the per-kind branch in hasMemorySpaceOwnerImplicitPermission;
  // owner_*_id fields are filled from the SubjectRef so the curation
  // (admin/creator) paths can resolve the underlying resource.
  const synthetic: MemorySpaceLoadedRow = {
    id: "(synthetic-not-in-db)",
    workspaceId: tuple.workspaceId,
    ownerSubjectId: tuple.ownerSubjectId,
    scopeSubjectId: tuple.scopeSubjectId,
    namespaceKey: "(synthetic)",
    ownerKind: tuple.owner.kind,
    ownerWorkspaceId:
      tuple.owner.kind === SUBJECT_KIND.WORKSPACE
        ? tuple.owner.workspaceId
        : null,
    ownerActorId:
      tuple.owner.kind === SUBJECT_KIND.ACTOR ? tuple.owner.actorId : null,
    ownerRemoteAgentId:
      tuple.owner.kind === SUBJECT_KIND.REMOTE_AGENT
        ? tuple.owner.remoteAgentId
        : null,
    ownerWorkspaceMemberId:
      tuple.owner.kind === SUBJECT_KIND.WORKSPACE_MEMBER
        ? tuple.owner.workspaceMemberId
        : null,
    ownerConversationId:
      tuple.owner.kind === SUBJECT_KIND.CONVERSATION
        ? tuple.owner.conversationId
        : null,
    scopeKind: tuple.scope?.kind ?? null,
    scopeConversationId:
      tuple.scope?.kind === SUBJECT_KIND.CONVERSATION
        ? tuple.scope.conversationId
        : null,
  }
  return hasMemorySpaceOwnerImplicitPermission(
    db,
    subject,
    synthetic,
    permission,
    runtimeContext
  )
}

export async function checkPermission(
  db: KyselyDb,
  params: {
    resourceType: AccessResourceType
    resourceId: string
    permission: string
    subject: PermissionSubject
    /**
     * PR3: optional scope context. When provided, scope-aware visibility
     * filtering kicks in (subject ∈ runtime AND (scope IS NULL OR scope ∈
     * runtimeScopeSubjectIds)). When omitted, the legacy filter applies
     * (scope IS NULL only). Callers that build a RuntimePrincipalContext
     * via `buildRuntimePrincipalContext` should pass its
     * `runtimeScopeSubjectIds` through here.
     */
    runtimeScopeSubjectIds?: readonly string[]
    /**
     * PR5: subject_id set the principal can claim under (the same field on
     * RuntimePrincipalContext). Required for memory_access_grants matching
     * — the grant table's subject_id is matched against this set. Callers
     * that don't pass it get the legacy memory permission decision tree
     * only (no explicit grants honored).
     */
    runtimeSubjectIds?: readonly string[]
  }
) {
  if (!params.resourceId) {
    return false
  }

  switch (params.resourceType) {
    case "platform":
      return (
        params.resourceId === PLATFORM_RESOURCE_ID &&
        hasPlatformPermission(db, params.subject, params.permission)
      )
    case "workspace":
      return hasWorkspacePermission(
        db,
        params.subject,
        params.resourceId,
        params.permission
      )
    case "conversation":
      return hasConversationPermission(
        db,
        params.subject,
        params.resourceId,
        params.permission
      )
    case "actor":
      return hasActorPermission(
        db,
        params.subject,
        params.resourceId,
        params.permission,
        params.runtimeScopeSubjectIds,
        params.runtimeSubjectIds
      )
    case "remote_agent":
      return hasRemoteAgentPermission(
        db,
        params.subject,
        params.resourceId,
        params.permission,
        params.runtimeScopeSubjectIds,
        params.runtimeSubjectIds
      )
    case "memory_item":
      return hasMemoryItemPermission(
        db,
        params.subject,
        params.resourceId,
        params.permission,
        {
          runtimeSubjectIds: params.runtimeSubjectIds,
          runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
        }
      )
    case "memory_space":
      return hasMemorySpacePermission(
        db,
        params.subject,
        params.resourceId,
        params.permission,
        {
          runtimeSubjectIds: params.runtimeSubjectIds,
          runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
        }
      )
    case "installed_skill":
      return hasInstalledSkillPermission(
        db,
        params.subject,
        params.resourceId,
        params.permission,
        params.runtimeScopeSubjectIds,
        params.runtimeSubjectIds
      )
    case "plugin_installation":
      return hasPluginInstallationPermission(
        db,
        params.subject,
        params.resourceId,
        params.permission,
        params.runtimeScopeSubjectIds,
        params.runtimeSubjectIds
      )
    case "device":
      return hasDevicePermission(
        db,
        params.subject,
        params.resourceId,
        params.permission
      )
    case "device_exposure":
      return hasExposurePermission(
        db,
        params.subject,
        params.resourceId,
        params.permission
      )
    case "device_capability":
      return hasCapabilityPermission(
        db,
        params.subject,
        params.resourceId,
        params.permission,
        params.runtimeScopeSubjectIds,
        params.runtimeSubjectIds
      )
    case "model_group":
      return hasModelGroupPermission(
        db,
        params.subject,
        params.resourceId,
        params.permission
      )
    case "automation_event_source":
      return hasAutomationEventSourcePermission(
        db,
        params.subject,
        params.resourceId,
        params.permission,
        params.runtimeScopeSubjectIds,
        params.runtimeSubjectIds
      )
    default:
      return false
  }
}

/**
 * Automation event sources are the 6th workspace_resource kind; their authorization
 * folds into workspace_resource_grants with an implicit `use` permission. This serves
 * the list/lookup surface (the runtime fire-time matcher stays bespoke in
 * automation/service.ts and is intentionally NOT a checkPermission call — plan
 * §13: fire path remains access-free).
 */
async function hasAutomationEventSourcePermission(
  db: KyselyDb,
  subject: PermissionSubject,
  eventSourceId: string,
  permission: string,
  runtimeScopeSubjectIds?: readonly string[],
  runtimeSubjectIds?: readonly string[]
): Promise<boolean> {
  if (permission !== "use" && permission !== "view") {
    return false
  }
  return hasWorkspaceResourceGrant(db, {
    resourceType: "automation_event_source",
    resourceId: eventSourceId,
    requiredGrantPermission: "use",
    subject,
    runtimeScopeSubjectIds,
    runtimeSubjectIds,
  })
}

export async function lookupResources(
  db: KyselyDb,
  params: {
    resourceType: AccessResourceType
    permission: string
    subject: PermissionSubject
    limit?: number
    /**
     * PR-fix-round-3: scope-aware visibility. Without these, the underlying
     * `listGrantedResourceIds` defaults to the conservative
     * "scope_subject_id IS NULL only" filter, so a scoped grant
     * (e.g. subject=actor + scope=conversation) never appears in any
     * tool/skill/plugin listing — `checkPermission` could pass but the
     * resource wouldn't be enumerated. Callers that already built a
     * RuntimePrincipalContext should pass these through.
     */
    runtimeScopeSubjectIds?: readonly string[]
    /**
     * P1 fix (post-D4): runtime subject_ids the principal can claim. When
     * provided, bindings whose subject_id ∈ runtimeSubjectIds match too
     * (covers `subject=conversation C` bindings for active participants).
     * Callers with a RuntimePrincipalContext should pass this through.
     */
    runtimeSubjectIds?: readonly string[]
  }
) {
  switch (params.resourceType) {
    case "actor":
      return params.permission === "view" ||
        params.permission === "discover" ||
        params.permission === "invoke"
        ? listActorIds(
            db,
            params.subject,
            params.limit,
            params.runtimeScopeSubjectIds,
            params.runtimeSubjectIds
          )
        : []
    case "remote_agent":
      return params.permission === "view" ||
        params.permission === "discover" ||
        params.permission === "invoke"
        ? listRemoteAgentIds(
            db,
            params.subject,
            params.limit,
            params.runtimeScopeSubjectIds,
            params.runtimeSubjectIds
          )
        : []
    case "model_group":
      return params.permission === "use" || params.permission === "view"
        ? listModelGroupIds(db, params.subject, params.limit)
        : []
    case "installed_skill":
      return listBindableWorkspaceResourceIdsForPermission(db, {
        resourceType: "installed_skill",
        permission: params.permission,
        manageAccessKey: "manage_skills",
        subject: params.subject,
        limit: params.limit,
        runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
        runtimeSubjectIds: params.runtimeSubjectIds,
      })
    case "plugin_installation":
      return listBindableWorkspaceResourceIdsForPermission(db, {
        resourceType: "plugin_installation",
        permission: params.permission,
        manageAccessKey: "manage_plugins",
        subject: params.subject,
        limit: params.limit,
        runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
        runtimeSubjectIds: params.runtimeSubjectIds,
      })
    case "device_capability":
      return listBindableWorkspaceResourceIdsForPermission(db, {
        resourceType: "device_capability",
        permission: params.permission,
        manageAccessKey: "manage_devices",
        subject: params.subject,
        limit: params.limit,
        runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
        runtimeSubjectIds: params.runtimeSubjectIds,
      })
    case "automation_event_source":
      // Folded into workspace_resource_grants: an event source carries an implicit
      // `use` permission. List/lookup goes through the unified grant path.
      return params.permission === "use" || params.permission === "view"
        ? listGrantedWorkspaceResourceIds(db, {
            resourceType: "automation_event_source",
            requiredGrantPermission: "use",
            subject: params.subject,
            limit: params.limit,
            runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
            runtimeSubjectIds: params.runtimeSubjectIds,
          })
        : []
    default:
      return []
  }
}

export { PLATFORM_RESOURCE_ID, type AccessResourceType, type PermissionSubject }
