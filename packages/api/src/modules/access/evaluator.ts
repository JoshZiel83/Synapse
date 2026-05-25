import { sql } from "kysely"
import { SUBJECT_KIND } from "@synapse/shared"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import { getWorkspaceCapabilityConversationTypePolicyMap } from "../capabilities/conversation-type-policies.js"
import {
  evaluatePlatformPermission,
  evaluateWorkspacePermission,
} from "./rbac-rules.js"
import { upsertAccessSubject } from "./subject-registry.js"

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
  | "relay_device"
  | "relay_exposure"
  | "relay_capability"
  | "device"
  | "device_exposure"
  | "device_capability"
  | "conversation_actor_context"
  | "conversation"
  | "memory_space"
  | "memory_item"
  | "model_group"
  | "model_profile"

type PermissionSubject = {
  type:
    | "user"
    | "workspace_member"
    | "actor"
    | "workspace"
    | "conversation_actor_context"
  id: string
}

const PLATFORM_RESOURCE_ID = "synapse"

type WorkspaceMemberAccess = {
  id: string
  workspaceId: string
  userId: string
  trustLevel: string
  ownerId: string | null
  accessKeys: string[]
}

type ActorRow = {
  id: string
  workspace_id: string
  created_by_workspace_member_id: string | null
  is_active: boolean
}

type RemoteAgentRow = {
  id: string
  workspace_id: string
  created_by_workspace_member_id: string | null
  is_active: boolean
  is_public_shared: boolean
}

type ConversationRow = {
  id: string
  workspace_id: string
  kind: "private" | "group" | "virtual"
  boundary: "internal" | "external"
}

type ConversationActorContextRow = {
  id: string
  actor_id: string
  conversation_id: string
  session_id: string | null
}

type ResourceGrantMatch = {
  resource_id: string
}

async function loadWorkspaceMemberAccess(
  db: KyselyDb,
  workspaceMemberId: string
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
    .where("wm.id", "=", workspaceMemberId)
    .limit(1)
    .executeTakeFirst()
  if (!row) return null

  const accessRows = await db
    .selectFrom("workspace_access_bindings")
    .select("access_key")
    .where("workspace_member_id", "=", workspaceMemberId)
    .execute()

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    trustLevel: row.trust_level,
    ownerId: row.owner_id,
    accessKeys: accessRows.map((entry) => entry.access_key),
  }
}

async function loadActorRow(
  db: KyselyDb,
  actorId: string
): Promise<ActorRow | null> {
  return (await db
    .selectFrom("actors")
    .select([
      "id",
      "workspace_id",
      "created_by_workspace_member_id",
      "is_active",
    ])
    .where("id", "=", actorId)
    .limit(1)
    .executeTakeFirst()) as ActorRow | null
}

async function loadRemoteAgentRow(
  db: KyselyDb,
  remoteAgentId: string
): Promise<RemoteAgentRow | null> {
  const result = await sql<RemoteAgentRow>`
    SELECT
      id,
      workspace_id,
      created_by_workspace_member_id,
      is_active,
      is_public_shared
    FROM remote_agents
    WHERE id = ${remoteAgentId}
    LIMIT 1
  `.execute(db)
  return result.rows[0] ?? null
}

async function loadConversationRow(
  db: KyselyDb,
  conversationId: string
): Promise<ConversationRow | null> {
  return (await db
    .selectFrom("conversations as conversation")
    .leftJoin(
      "workspace_members as creator_member",
      "creator_member.id",
      "conversation.created_by_workspace_member_id"
    )
    .select([
      "conversation.id as id",
      sql<string | null>`COALESCE(
        conversation.internal_workspace_id,
        creator_member.workspace_id
      )`.as("workspace_id"),
      "conversation.kind as kind",
      "conversation.boundary as boundary",
    ])
    .where("conversation.id", "=", conversationId)
    .limit(1)
    .executeTakeFirst()) as unknown as ConversationRow | null
}

async function loadConversationActorContext(
  db: KyselyDb,
  contextId: string
): Promise<ConversationActorContextRow | null> {
  return (await db
    .selectFrom("conversation_actor_contexts")
    .select(["id", "actor_id", "conversation_id", "session_id"])
    .where("id", "=", contextId)
    .limit(1)
    .executeTakeFirst()) as ConversationActorContextRow | null
}

async function loadPlatformAccessKeysForUser(db: KyselyDb, userId: string) {
  const rows = await db
    .selectFrom("platform_access_bindings")
    .select("access_key")
    .where("user_id", "=", userId)
    .execute()
  return rows.map((row) => row.access_key)
}

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

async function hasActiveConversationMembership(
  db: KyselyDb,
  params: {
    conversationId: string
    workspaceMemberId?: string | null
    actorId?: string | null
  }
) {
  // P1b: conversation_participants now stores subject_id; resolve the lookup
  // subject and filter by that id.
  let subjectId: string | null = null
  if (params.workspaceMemberId) {
    subjectId = await upsertAccessSubject(db, {
      kind: SUBJECT_KIND.WORKSPACE_MEMBER,
      memberId: params.workspaceMemberId,
    })
  } else if (params.actorId) {
    subjectId = await upsertAccessSubject(db, {
      kind: SUBJECT_KIND.ACTOR,
      actorId: params.actorId,
    })
  } else {
    return null
  }
  return db
    .selectFrom("conversation_participants")
    .select(["id", "role_key"])
    .where("conversation_id", "=", params.conversationId)
    .where("state", "=", "active")
    .where("subject_id", "=", subjectId)
    .limit(1)
    .executeTakeFirst()
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
      Boolean(conversation.workspace_id) &&
      access.workspaceId === conversation.workspace_id
    const isConversationAdmin =
      membership?.role_key === "owner" || membership?.role_key === "admin"
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
  permission: string
): Promise<boolean> {
  const actor = await loadActorRow(db, actorId)
  if (!actor || !actor.is_active) {
    return false
  }

  if (subject.type === "actor") {
    if (subject.id !== actorId) {
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

  if (subject.type !== "workspace_member") {
    return false
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access || access.workspaceId !== actor.workspace_id) {
    return false
  }

  const canManage =
    isWorkspaceOwnerOrAdmin(access) ||
    hasWorkspaceAccessKey(access, "actor_admin") ||
    actor.created_by_workspace_member_id === access.id
  // P2: `canUse` is now derived purely from bindings. The historical
  // `actor.access_policy === 'workspace_open'` shortcut and friend_entries
  // join have been replaced by binding rows:
  //   - "workspace_open" actors get a workspace-scoped binding (source=default_open)
  //     written on creation by relationship/service.ts.
  //   - "approval_required" actors get an actor-scoped or actor_in_conversation-scoped
  //     binding written by the approval flow.
  const canUse =
    canManage ||
    (await hasResourceGrant(db, "actor", actorId, {
      type: "workspace_member",
      id: access.id,
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
  permission: string
): Promise<boolean> {
  const remoteAgent = await loadRemoteAgentRow(db, remoteAgentId)
  if (!remoteAgent || !remoteAgent.is_active) {
    return false
  }

  if (subject.type !== "workspace_member") {
    return false
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access) {
    return false
  }

  const sameWorkspace = access.workspaceId === remoteAgent.workspace_id
  const canManage =
    sameWorkspace &&
    (isWorkspaceOwnerOrAdmin(access) ||
      hasWorkspaceAccessKey(access, "remote_agent_admin") ||
      remoteAgent.created_by_workspace_member_id === access.id)
  // P2: same fold as hasActorPermission — bindings are authoritative.
  // Cross-workspace `is_public_shared` still requires an explicit binding to
  // be granted; the publishing workspace's auto-write happens on create.
  const canUse =
    canManage ||
    (await hasResourceGrant(db, "remote_agent", remoteAgentId, {
      type: "workspace_member",
      id: access.id,
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

async function hasConversationActorContextPermission(
  db: KyselyDb,
  subject: PermissionSubject,
  contextId: string,
  permission: string
): Promise<boolean> {
  const context = await loadConversationActorContext(db, contextId)
  if (!context) {
    return false
  }

  if (subject.type === "actor") {
    const membership =
      subject.id === context.actor_id
        ? await hasActiveConversationMembership(db, {
            conversationId: context.conversation_id,
            actorId: subject.id,
          })
        : null

    if (!membership) {
      return false
    }

    switch (permission) {
      case "memory_read":
      case "memory_edit":
      case "memory_retarget":
      case "memory_delete":
        return true
      default:
        return false
    }
  }

  if (subject.type !== "workspace_member") {
    return false
  }

  const inConversation = await hasActiveConversationMembership(db, {
    conversationId: context.conversation_id,
    workspaceMemberId: subject.id,
  })
  if (!inConversation) {
    return false
  }

  switch (permission) {
    case "memory_read":
    case "memory_edit":
      return hasActorPermission(db, subject, context.actor_id, permission)
    case "memory_retarget":
    case "memory_delete":
      return hasActorPermission(db, subject, context.actor_id, permission)
    default:
      return false
  }
}

type ResourceGrantRow = {
  resource_id: string
  target_type:
    | "workspace"
    | "workspace_member"
    | "conversation"
    | "actor"
    | "actor_in_conversation"
  subject_workspace_id: string | null
  subject_workspace_member_id: string | null
  subject_actor_id: string | null
  subject_conversation_id: string | null
  subject_conversation_actor_context_id: string | null
}

type BindableResourceTypeLocal =
  | "installed_skill"
  | "plugin_installation"
  | "relay_capability"
  | "device_capability"
  | "automation_event_source"
  | "actor"
  | "remote_agent"

function bindableResourceIdColumn(
  resourceType: BindableResourceTypeLocal
):
  | "installed_skill_id"
  | "plugin_installation_id"
  | "relay_capability_id"
  | "device_capability_id"
  | "automation_event_source_id"
  | "actor_id"
  | "remote_agent_id" {
  switch (resourceType) {
    case "installed_skill":
      return "installed_skill_id"
    case "plugin_installation":
      return "plugin_installation_id"
    case "relay_capability":
      return "relay_capability_id"
    case "device_capability":
      return "device_capability_id"
    case "automation_event_source":
      return "automation_event_source_id"
    case "actor":
      return "actor_id"
    case "remote_agent":
      return "remote_agent_id"
  }
}

async function listResourceGrantRows(
  db: KyselyDb,
  resourceType: BindableResourceTypeLocal,
  resourceId: string | null,
  subject: PermissionSubject
): Promise<ResourceGrantRow[]> {
  const resourceIdColumn = bindableResourceIdColumn(resourceType)

  let query = db
    .selectFrom("resource_access_bindings as binding")
    .innerJoin("access_subjects as subj", "subj.id", "binding.subject_id")
    .leftJoin(
      "conversation_actor_contexts as cac",
      "cac.id",
      "subj.conversation_actor_context_id"
    )
    .select([
      sql<string>`COALESCE(
        binding.installed_skill_id::text,
        binding.plugin_installation_id::text,
        binding.relay_capability_id::text,
        binding.automation_event_source_id::text,
        binding.actor_id::text,
        binding.remote_agent_id::text
      )`.as("resource_id"),
      sql<
        | "workspace"
        | "workspace_member"
        | "conversation"
        | "actor"
        | "actor_in_conversation"
      >`CASE subj.kind
        WHEN 'workspace' THEN 'workspace'
        WHEN 'workspace_member' THEN 'workspace_member'
        WHEN 'conversation' THEN 'conversation'
        WHEN 'actor' THEN 'actor'
        WHEN 'conversation_actor_context' THEN 'actor_in_conversation'
      END`.as("target_type"),
      "subj.workspace_id as subject_workspace_id",
      "subj.workspace_member_id as subject_workspace_member_id",
      sql<string | null>`COALESCE(subj.actor_id, cac.actor_id)`.as(
        "subject_actor_id"
      ),
      sql<
        string | null
      >`COALESCE(subj.conversation_id, cac.conversation_id)`.as(
        "subject_conversation_id"
      ),
      "subj.conversation_actor_context_id as subject_conversation_actor_context_id",
    ])
    .where("binding.status", "=", "active")

  if (resourceId) {
    query = query.where(`binding.${resourceIdColumn}` as any, "=", resourceId)
  }

  if (subject.type === "workspace") {
    query = query
      .where("subj.kind", "=", "workspace")
      .where("subj.workspace_id", "=", subject.id)
  } else if (subject.type === "actor") {
    query = query
      .where("subj.kind", "=", "actor")
      .where("subj.actor_id", "=", subject.id)
  } else if (subject.type === "conversation_actor_context") {
    const context = await loadConversationActorContext(db, subject.id)
    if (!context) {
      return []
    }
    const membership = await hasActiveConversationMembership(db, {
      conversationId: context.conversation_id,
      actorId: context.actor_id,
    })
    if (!membership) {
      return []
    }
    const contextId = subject.id
    const conversationId = context.conversation_id
    query = query.where((eb) =>
      eb.or([
        eb.and([
          eb("subj.kind", "=", "conversation_actor_context"),
          eb("subj.conversation_actor_context_id", "=", contextId),
        ]),
        eb.and([
          eb("subj.kind", "=", "conversation"),
          eb("subj.conversation_id", "=", conversationId),
        ]),
      ])
    )
  } else if (subject.type === "workspace_member") {
    const access = await loadWorkspaceMemberAccess(db, subject.id)
    if (!access) {
      return []
    }
    // P2 fix: a workspace_member subject matches BOTH
    //   (a) bindings targeting the workspace they belong to (workspace_open
    //       default + workspace-wide grants), AND
    //   (b) bindings targeting them specifically (workspace_member-scoped
    //       approval grants — written by grantApprovedAccess).
    // Missing (b) was the bug: approval grants would silently fail because the
    // member would never match the workspace_member-scoped binding.
    query = query.where((eb) =>
      eb.or([
        eb.and([
          eb("subj.kind", "=", "workspace"),
          eb("subj.workspace_id", "=", access.workspaceId),
        ]),
        eb.and([
          eb("subj.kind", "=", "workspace_member"),
          eb("subj.workspace_member_id", "=", subject.id),
        ]),
      ])
    )
  } else {
    return []
  }

  return (await query.execute()) as unknown as ResourceGrantRow[]
}

async function hasResourceGrant(
  db: KyselyDb,
  resourceType: BindableResourceTypeLocal,
  resourceId: string,
  subject: PermissionSubject
) {
  const rows = await listResourceGrantRows(
    db,
    resourceType,
    resourceId,
    subject
  )
  return rows.length > 0
}

async function listGrantedResourceIds(
  db: KyselyDb,
  resourceType: BindableResourceTypeLocal,
  subject: PermissionSubject,
  limit?: number
) {
  const rows = await listResourceGrantRows(db, resourceType, null, subject)
  const ids = Array.from(new Set(rows.map((row) => row.resource_id)))
  return typeof limit === "number" && limit > 0 ? ids.slice(0, limit) : ids
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

async function listManageableInstalledSkillIds(
  db: KyselyDb,
  subject: PermissionSubject,
  limit?: number
) {
  if (subject.type !== "workspace_member") {
    return [] as string[]
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access) {
    return [] as string[]
  }

  let query = db
    .selectFrom("installed_skills")
    .select("id")
    .where("workspace_id", "=", access.workspaceId)
    .where("is_active", "=", true)
    .orderBy("updated_at", "desc")

  if (!workspacePermissionFromAccess(access, "manage_skills")) {
    query = query.where("created_by_workspace_member_id", "=", access.id)
  }

  const rows = await query.limit(limit && limit > 0 ? limit : 1000).execute()
  return rows.map((row) => row.id)
}

async function listManageablePluginInstallationIds(
  db: KyselyDb,
  subject: PermissionSubject,
  limit?: number
) {
  if (subject.type !== "workspace_member") {
    return [] as string[]
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access) {
    return [] as string[]
  }

  let query = db
    .selectFrom("plugin_installations")
    .select("id")
    .where("workspace_id", "=", access.workspaceId)
    .where("status", "=", "active")
    .orderBy("updated_at", "desc")

  if (!workspacePermissionFromAccess(access, "manage_plugins")) {
    query = query.where("installed_by_workspace_member_id", "=", access.id)
  }

  const rows = await query.limit(limit && limit > 0 ? limit : 1000).execute()
  return rows.map((row) => row.id)
}

async function listManageableRelayCapabilityIds(
  db: KyselyDb,
  subject: PermissionSubject,
  limit?: number
) {
  if (subject.type !== "workspace_member") {
    return [] as string[]
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access) {
    return [] as string[]
  }

  let query = db
    .selectFrom("relay_capabilities as capability")
    .innerJoin(
      "relay_exposures as exposure",
      "exposure.id",
      "capability.exposure_id"
    )
    .innerJoin("relay_devices as device", "device.id", "exposure.device_id")
    .select("capability.id")
    .where("capability.workspace_id", "=", access.workspaceId)
    .where("capability.status", "=", "active")
    .orderBy("capability.updated_at", "desc")

  if (!workspacePermissionFromAccess(access, "manage_relays")) {
    query = query.where("device.owner_workspace_member_id", "=", access.id)
  }

  const rows = await query.limit(limit && limit > 0 ? limit : 1000).execute()
  return rows.map((row) => row.id)
}

async function listManageableDeviceCapabilityIds(
  db: KyselyDb,
  subject: PermissionSubject,
  limit?: number
) {
  if (subject.type !== "workspace_member") {
    return [] as string[]
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access) {
    return [] as string[]
  }

  let query = db
    .selectFrom("device_capabilities as capability")
    .innerJoin(
      "device_exposures as exposure",
      "exposure.id",
      "capability.exposure_id"
    )
    .innerJoin("devices as device", "device.id", "exposure.device_id")
    .select("capability.id")
    .where("capability.workspace_id", "=", access.workspaceId)
    .where("capability.status", "=", "active")
    .orderBy("capability.updated_at", "desc")

  // device_admin (preferred) or relay_admin (legacy) can manage all device
  // capabilities in the workspace; otherwise only the device owner can.
  if (
    !workspacePermissionFromAccess(access, "manage_devices") &&
    !workspacePermissionFromAccess(access, "manage_relays")
  ) {
    query = query.where("device.owner_workspace_member_id", "=", access.id)
  }

  const rows = await query.limit(limit && limit > 0 ? limit : 1000).execute()
  return rows.map((row) => row.id)
}

async function hasInstalledSkillPermission(
  db: KyselyDb,
  subject: PermissionSubject,
  skillId: string,
  permission: string
): Promise<boolean> {
  const row = await db
    .selectFrom("installed_skills")
    .select(["workspace_id", "created_by_workspace_member_id", "is_active"])
    .where("id", "=", skillId)
    .limit(1)
    .executeTakeFirst()
  if (!row || !row.is_active) {
    return false
  }

  if (permission === "use" || permission === "view") {
    if (await hasResourceGrant(db, "installed_skill", skillId, subject)) {
      return true
    }
  }

  if (subject.type !== "workspace_member") {
    return false
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access || access.workspaceId !== row.workspace_id) {
    return false
  }

  const canManage =
    workspacePermissionFromAccess(access, "manage_skills") ||
    row.created_by_workspace_member_id === access.id
  if (permission === "view" || permission === "use") {
    return canManage
  }
  return canManage
}

async function hasPluginInstallationPermission(
  db: KyselyDb,
  subject: PermissionSubject,
  installationId: string,
  permission: string
): Promise<boolean> {
  const row = await db
    .selectFrom("plugin_installations")
    .select(["workspace_id", "installed_by_workspace_member_id", "status"])
    .where("id", "=", installationId)
    .limit(1)
    .executeTakeFirst()
  if (!row || row.status !== "active") {
    return false
  }

  if (permission === "use" || permission === "view") {
    if (
      await hasResourceGrant(db, "plugin_installation", installationId, subject)
    ) {
      return true
    }
  }

  if (subject.type !== "workspace_member") {
    return false
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access || access.workspaceId !== row.workspace_id) {
    return false
  }

  const canManage =
    workspacePermissionFromAccess(access, "manage_plugins") ||
    row.installed_by_workspace_member_id === access.id
  if (permission === "view" || permission === "use") {
    return canManage
  }
  return canManage
}

async function hasRelayDevicePermission(
  db: KyselyDb,
  subject: PermissionSubject,
  deviceId: string,
  permission: string
): Promise<boolean> {
  const row = await db
    .selectFrom("relay_devices")
    .select(["workspace_id", "owner_workspace_member_id"])
    .where("id", "=", deviceId)
    .limit(1)
    .executeTakeFirst()
  if (!row) {
    return false
  }

  if (subject.type === "user") {
    if (permission !== "authorize_relay_authorization") {
      return false
    }
    return hasPlatformPermission(db, subject, "manage")
  }

  if (subject.type !== "workspace_member") {
    return false
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access || access.workspaceId !== row.workspace_id) {
    return false
  }

  const canManage =
    workspacePermissionFromAccess(access, "manage_relays") ||
    row.owner_workspace_member_id === access.id

  switch (permission) {
    case "view":
    case "manage":
    case "delete":
    case "authorize_relay_authorization":
      return canManage
    default:
      return false
  }
}

async function hasRelayExposurePermission(
  db: KyselyDb,
  subject: PermissionSubject,
  exposureId: string,
  permission: string
): Promise<boolean> {
  const row = await db
    .selectFrom("relay_exposures as exposure")
    .innerJoin("relay_devices as device", "device.id", "exposure.device_id")
    .select(["device.id as device_id"])
    .where("exposure.id", "=", exposureId)
    .limit(1)
    .executeTakeFirst()
  if (!row?.device_id) {
    return false
  }
  return hasRelayDevicePermission(
    db,
    subject,
    row.device_id,
    permission === "view" ? "view" : "manage"
  )
}

async function hasRelayCapabilityPermission(
  db: KyselyDb,
  subject: PermissionSubject,
  capabilityId: string,
  permission: string
): Promise<boolean> {
  const row = await db
    .selectFrom("relay_capabilities as capability")
    .innerJoin(
      "relay_exposures as exposure",
      "exposure.id",
      "capability.exposure_id"
    )
    .innerJoin("relay_devices as device", "device.id", "exposure.device_id")
    .select([
      "capability.workspace_id",
      "capability.status",
      "device.id as device_id",
      "device.owner_workspace_member_id",
    ])
    .where("capability.id", "=", capabilityId)
    .limit(1)
    .executeTakeFirst()
  if (!row || row.status !== "active") {
    return false
  }

  if (
    permission === "use" ||
    permission === "view" ||
    permission === "request_relay_authorization"
  ) {
    if (await hasResourceGrant(db, "relay_capability", capabilityId, subject)) {
      return true
    }
  }

  if (subject.type !== "workspace_member") {
    return false
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access || access.workspaceId !== row.workspace_id) {
    return false
  }

  const canManage =
    workspacePermissionFromAccess(access, "manage_relays") ||
    row.owner_workspace_member_id === access.id

  if (
    permission === "view" ||
    permission === "use" ||
    permission === "request_relay_authorization"
  ) {
    return canManage
  }
  return canManage
}

async function hasDeviceCapabilityPermission(
  db: KyselyDb,
  subject: PermissionSubject,
  capabilityId: string,
  permission: string
): Promise<boolean> {
  const row = await db
    .selectFrom("device_capabilities as capability")
    .innerJoin(
      "device_exposures as exposure",
      "exposure.id",
      "capability.exposure_id"
    )
    .innerJoin("devices as device", "device.id", "exposure.device_id")
    .select([
      "capability.workspace_id",
      "capability.status",
      "device.id as device_id",
      "device.owner_workspace_member_id",
    ])
    .where("capability.id", "=", capabilityId)
    .limit(1)
    .executeTakeFirst()
  if (!row || row.status !== "active") {
    return false
  }

  if (
    permission === "use" ||
    permission === "view" ||
    permission === "request_runtime_authorization"
  ) {
    if (
      await hasResourceGrant(db, "device_capability", capabilityId, subject)
    ) {
      return true
    }
  }

  if (subject.type !== "workspace_member") {
    return false
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access || access.workspaceId !== row.workspace_id) {
    return false
  }

  // device_admin or relay_admin (legacy) can manage device capabilities.
  const canManage =
    workspacePermissionFromAccess(access, "manage_devices") ||
    workspacePermissionFromAccess(access, "manage_relays") ||
    row.owner_workspace_member_id === access.id
  return canManage
}

async function listActorIds(
  db: KyselyDb,
  subject: PermissionSubject,
  limit?: number
) {
  if (subject.type !== "workspace_member") {
    return subject.type === "actor" ? [subject.id] : []
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access) {
    return []
  }

  // Admins / actor_admins see every active actor in the workspace.
  if (
    isWorkspaceOwnerOrAdmin(access) ||
    hasWorkspaceAccessKey(access, "actor_admin")
  ) {
    const rows = await db
      .selectFrom("actors as a")
      .select("a.id")
      .where("a.workspace_id", "=", access.workspaceId)
      .where("a.is_active", "=", true)
      .orderBy("a.created_at", "desc")
      .limit(limit && limit > 0 ? limit : 1000)
      .execute()
    return rows.map((row) => row.id)
  }

  // Otherwise, visible actors = actors created by this member +
  // bindings reachable by the workspace_member subject. listResourceGrantRows's
  // workspace_member branch already matches both:
  //   (a) workspace-scoped bindings (default_open + workspace-wide grants), and
  //   (b) workspace_member-scoped approval grants for this specific member.
  // Passing the member subject directly is what makes (b) visible here.
  const [ownActors, grantedIds] = await Promise.all([
    db
      .selectFrom("actors as a")
      .select("a.id")
      .where("a.workspace_id", "=", access.workspaceId)
      .where("a.is_active", "=", true)
      .where("a.created_by_workspace_member_id", "=", access.id)
      .orderBy("a.created_at", "desc")
      .execute(),
    listGrantedResourceIds(db, "actor", subject),
  ])
  return finalizeResourceIdList(
    [ownActors.map((row) => row.id), grantedIds],
    limit
  )
}

async function listRemoteAgentIds(
  db: KyselyDb,
  subject: PermissionSubject,
  limit?: number
) {
  if (subject.type !== "workspace_member") {
    return []
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access) {
    return []
  }

  const isAdmin =
    isWorkspaceOwnerOrAdmin(access) ||
    hasWorkspaceAccessKey(access, "remote_agent_admin")

  // Admins see every active remote agent in their workspace (and any public
  // shared ones from other workspaces).
  if (isAdmin) {
    const rows = await db
      .selectFrom("remote_agents")
      .select("id")
      .where("is_active", "=", true)
      .where((eb) =>
        eb.or([
          eb("workspace_id", "=", access.workspaceId),
          eb("is_public_shared", "=", true),
        ])
      )
      .orderBy("created_at", "desc")
      .limit(limit && limit > 0 ? limit : 1000)
      .execute()
    return rows.map((row) => row.id)
  }

  // P2: bindings now drive visibility. Both same-workspace open agents and
  // cross-workspace public-shared agents get a workspace-scoped binding row
  // (source=default_open) on creation / publish.
  const [ownAgents, grantedIds] = await Promise.all([
    db
      .selectFrom("remote_agents")
      .select("id")
      .where("is_active", "=", true)
      .where("workspace_id", "=", access.workspaceId)
      .where("created_by_workspace_member_id", "=", access.id)
      .orderBy("created_at", "desc")
      .execute(),
    listGrantedResourceIds(db, "remote_agent", subject),
  ])
  return finalizeResourceIdList(
    [ownAgents.map((row) => row.id), grantedIds],
    limit
  )
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
    const rows = await db
      .selectFrom("model_groups as mg")
      .distinct()
      .leftJoin("model_group_grants as mgg", (join) =>
        join.onRef("mgg.group_id", "=", "mg.id").on("mgg.status", "=", "active")
      )
      .leftJoin("access_subjects as mgs", "mgs.id", "mgg.subject_id")
      .select("mg.id")
      .where("mg.is_enabled", "=", true)
      .where((eb) =>
        eb.or([
          eb.and([
            eb("mg.owner_type", "=", "workspace"),
            eb("mg.owner_workspace_id", "=", actor.workspace_id),
          ]),
          eb("mgs.kind", "=", "system"),
          eb.and([
            eb("mgs.kind", "=", "workspace"),
            eb("mgs.workspace_id", "=", actor.workspace_id),
          ]),
          eb.and([
            eb("mgs.kind", "=", "actor"),
            eb("mgs.workspace_id", "=", actor.workspace_id),
            eb("mgs.actor_id", "=", subject.id),
          ]),
        ])
      )
      .limit(limit && limit > 0 ? limit : 1000)
      .execute()
    return rows.map((row) => row.id)
  }

  if (subject.type !== "workspace_member") {
    return []
  }

  const access = await loadWorkspaceMemberAccess(db, subject.id)
  if (!access) {
    return []
  }

  const rows = await db
    .selectFrom("model_groups as mg")
    .distinct()
    .leftJoin("model_group_grants as mgg", (join) =>
      join.onRef("mgg.group_id", "=", "mg.id").on("mgg.status", "=", "active")
    )
    .leftJoin("access_subjects as mgs", "mgs.id", "mgg.subject_id")
    .select("mg.id")
    .where("mg.is_enabled", "=", true)
    .where((eb) =>
      eb.or([
        eb.and([
          eb("mg.owner_type", "=", "workspace"),
          eb("mg.owner_workspace_id", "=", access.workspaceId),
        ]),
        eb.and([
          eb("mg.owner_type", "=", "workspace_member"),
          eb("mg.owner_workspace_member_id", "=", access.id),
        ]),
        eb("mgs.kind", "=", "system"),
        eb.and([
          eb("mgs.kind", "=", "workspace"),
          eb("mgs.workspace_id", "=", access.workspaceId),
        ]),
        eb.and([
          eb("mgs.kind", "=", "workspace_member"),
          eb("mgs.workspace_member_id", "=", access.id),
        ]),
      ])
    )
    .limit(limit && limit > 0 ? limit : 1000)
    .execute()
  return rows.map((row) => row.id)
}

async function hasModelGroupPermission(
  db: KyselyDb,
  subject: PermissionSubject,
  groupId: string,
  permission: string
): Promise<boolean> {
  const row = await db
    .selectFrom("model_groups")
    .select([
      "id",
      "owner_type",
      "owner_workspace_id",
      "owner_workspace_member_id",
      "is_enabled",
    ])
    .where("id", "=", groupId)
    .limit(1)
    .executeTakeFirst()
  if (!row || !row.is_enabled) {
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
      row.owner_type === "workspace_member" &&
      row.owner_workspace_member_id === access.id
    ) {
      return true
    }

    if (
      row.owner_type === "workspace" &&
      row.owner_workspace_id === access.workspaceId &&
      workspacePermissionFromAccess(access, "manage_models")
    ) {
      return true
    }

    if (row.owner_type === "platform") {
      return hasPlatformPermission(
        db,
        { type: "workspace_member", id: access.id },
        "manage_models"
      )
    }
  }

  return false
}

async function hasModelProfilePermission(
  db: KyselyDb,
  subject: PermissionSubject,
  profileId: string,
  permission: string
): Promise<boolean> {
  const groups = await db
    .selectFrom("model_group_profiles")
    .select("group_id")
    .where("profile_id", "=", profileId)
    .execute()
  if (groups.length === 0) {
    return false
  }

  const mappedPermission =
    permission === "use" || permission === "view"
      ? permission
      : permission === "attach"
        ? "edit"
        : permission

  for (const group of groups) {
    if (
      await hasModelGroupPermission(
        db,
        subject,
        group.group_id,
        mappedPermission
      )
    ) {
      return true
    }
  }

  return false
}

async function hasMemoryItemPermission(
  db: KyselyDb,
  subject: PermissionSubject,
  memoryItemId: string,
  permission: string
): Promise<boolean> {
  const row = await db
    .selectFrom("memory_items as mi")
    .innerJoin("memory_spaces as ms", "ms.id", "mi.memory_space_id")
    .leftJoin(
      "conversation_actor_contexts as cac",
      "cac.id",
      "ms.anchor_conversation_actor_context_id"
    )
    .select([
      "mi.workspace_id",
      "ms.space_type",
      "ms.anchor_conversation_id",
      "ms.anchor_actor_id",
      "ms.anchor_workspace_member_id",
      "ms.anchor_conversation_actor_context_id",
      "cac.actor_id as context_actor_id",
      "cac.conversation_id as context_conversation_id",
    ])
    .where("mi.id", "=", memoryItemId)
    .limit(1)
    .executeTakeFirst()
  if (!row) {
    return false
  }

  switch (row.space_type) {
    case "workspace_shared":
      if (subject.type === "actor") {
        const actor = await loadActorRow(db, subject.id)
        if (!actor || actor.workspace_id !== row.workspace_id) {
          return false
        }
        return (
          permission === "read" ||
          permission === "recall" ||
          permission === "edit"
        )
      }
      return hasWorkspacePermission(
        db,
        subject,
        row.workspace_id,
        permission === "read" || permission === "recall"
          ? "view"
          : "manage_memories"
      )
    case "conversation_shared":
      if (!row.anchor_conversation_id) {
        return false
      }
      return hasConversationPermission(
        db,
        subject,
        row.anchor_conversation_id,
        permission === "read" || permission === "recall"
          ? "memory_read"
          : permission === "edit"
            ? "memory_edit"
            : permission === "retarget"
              ? "memory_retarget"
              : "memory_delete"
      )
    case "actor_private":
      if (!row.anchor_actor_id) {
        return false
      }
      return hasActorPermission(
        db,
        subject,
        row.anchor_actor_id,
        permission === "read" || permission === "recall"
          ? "memory_read"
          : permission === "edit"
            ? "memory_edit"
            : permission === "retarget"
              ? "memory_retarget"
              : "memory_delete"
      )
    case "participant_private":
      if (!row.anchor_conversation_actor_context_id) {
        return false
      }
      return hasConversationActorContextPermission(
        db,
        subject,
        row.anchor_conversation_actor_context_id,
        permission === "read" || permission === "recall"
          ? "memory_read"
          : permission === "edit"
            ? "memory_edit"
            : permission === "retarget"
              ? "memory_retarget"
              : "memory_delete"
      )
    case "user_private":
      if (subject.type === "workspace_member") {
        if (row.anchor_workspace_member_id === subject.id) {
          return true
        }
      }
      return hasWorkspacePermission(
        db,
        subject,
        row.workspace_id,
        "manage_memories"
      )
    default:
      return false
  }
}

export async function checkPermission(
  db: KyselyDb,
  params: {
    resourceType: AccessResourceType
    resourceId: string
    permission: string
    subject: PermissionSubject
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
        params.permission
      )
    case "remote_agent":
      return hasRemoteAgentPermission(
        db,
        params.subject,
        params.resourceId,
        params.permission
      )
    case "conversation_actor_context":
      return hasConversationActorContextPermission(
        db,
        params.subject,
        params.resourceId,
        params.permission
      )
    case "memory_item":
      return hasMemoryItemPermission(
        db,
        params.subject,
        params.resourceId,
        params.permission
      )
    case "installed_skill":
      return hasInstalledSkillPermission(
        db,
        params.subject,
        params.resourceId,
        params.permission
      )
    case "plugin_installation":
      return hasPluginInstallationPermission(
        db,
        params.subject,
        params.resourceId,
        params.permission
      )
    case "relay_device":
      return hasRelayDevicePermission(
        db,
        params.subject,
        params.resourceId,
        params.permission
      )
    case "relay_exposure":
      return hasRelayExposurePermission(
        db,
        params.subject,
        params.resourceId,
        params.permission
      )
    case "relay_capability":
      return hasRelayCapabilityPermission(
        db,
        params.subject,
        params.resourceId,
        params.permission
      )
    case "device_capability":
      return hasDeviceCapabilityPermission(
        db,
        params.subject,
        params.resourceId,
        params.permission
      )
    case "model_group":
      return hasModelGroupPermission(
        db,
        params.subject,
        params.resourceId,
        params.permission
      )
    case "model_profile":
      return hasModelProfilePermission(
        db,
        params.subject,
        params.resourceId,
        params.permission
      )
    default:
      return false
  }
}

export async function lookupResources(
  db: KyselyDb,
  params: {
    resourceType: AccessResourceType
    permission: string
    subject: PermissionSubject
    limit?: number
  }
) {
  switch (params.resourceType) {
    case "actor":
      return params.permission === "view" ||
        params.permission === "discover" ||
        params.permission === "invoke"
        ? listActorIds(db, params.subject, params.limit)
        : []
    case "remote_agent":
      return params.permission === "view" ||
        params.permission === "discover" ||
        params.permission === "invoke"
        ? listRemoteAgentIds(db, params.subject, params.limit)
        : []
    case "model_group":
      return params.permission === "use" || params.permission === "view"
        ? listModelGroupIds(db, params.subject, params.limit)
        : []
    case "installed_skill":
      return params.permission === "use" || params.permission === "view"
        ? finalizeResourceIdList(
            [
              await listGrantedResourceIds(
                db,
                "installed_skill",
                params.subject,
                params.limit
              ),
              await listManageableInstalledSkillIds(
                db,
                params.subject,
                params.limit
              ),
            ],
            params.limit
          )
        : []
    case "plugin_installation":
      return params.permission === "use" || params.permission === "view"
        ? finalizeResourceIdList(
            [
              await listGrantedResourceIds(
                db,
                "plugin_installation",
                params.subject,
                params.limit
              ),
              await listManageablePluginInstallationIds(
                db,
                params.subject,
                params.limit
              ),
            ],
            params.limit
          )
        : []
    case "relay_capability":
      return params.permission === "use" ||
        params.permission === "view" ||
        params.permission === "request_relay_authorization"
        ? finalizeResourceIdList(
            [
              await listGrantedResourceIds(
                db,
                "relay_capability",
                params.subject,
                params.limit
              ),
              await listManageableRelayCapabilityIds(
                db,
                params.subject,
                params.limit
              ),
            ],
            params.limit
          )
        : []
    case "device_capability":
      return params.permission === "use" ||
        params.permission === "view" ||
        params.permission === "request_runtime_authorization"
        ? finalizeResourceIdList(
            [
              await listGrantedResourceIds(
                db,
                "device_capability",
                params.subject,
                params.limit
              ),
              await listManageableDeviceCapabilityIds(
                db,
                params.subject,
                params.limit
              ),
            ],
            params.limit
          )
        : []
    case "automation_event_source":
      return params.permission === "use" || params.permission === "view"
        ? listGrantedResourceIds(
            db,
            "automation_event_source",
            params.subject,
            params.limit
          )
        : []
    default:
      return []
  }
}

export { PLATFORM_RESOURCE_ID, type AccessResourceType, type PermissionSubject }
