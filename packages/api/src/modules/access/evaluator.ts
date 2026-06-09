import { sql } from "kysely"
import {
  ACCESS_BINDING_STATUS,
  MEMORY_PERMISSION,
  SUBJECT_KIND,
  WORKSPACE_APP_GRANT_PERMISSION,
  WORKSPACE_APP_KIND,
  WORKSPACE_APP_STATUS,
} from "@synapse/shared"
import type { MemoryPermission, SubjectRef } from "@synapse/shared"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import { getWorkspaceCapabilityConversationTypePolicyMap } from "../capabilities/conversation-type-policies.js"
import {
  evaluatePlatformPermission,
  evaluateWorkspacePermission,
} from "./rbac-rules.js"
import { upsertAccessSubject } from "./subject-registry.js"
import { memoryGrantMatches } from "../memory/access-grant-storage.js"

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
  owner_workspace_member_id: string | null
  is_active: boolean
}

type RemoteAgentRow = {
  id: string
  workspace_id: string
  owner_workspace_member_id: string | null
  is_active: boolean
  is_public_shared: boolean
}

type ConversationRow = {
  id: string
  workspace_id: string
  kind: "direct" | "group"
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
    // Soft delete (§8.4): a left/removed member or a soft-deleted workspace
    // grants no access.
    .where("wm.status", "=", "active")
    .where("w.deleted_at", "is", null)
    .limit(1)
    .executeTakeFirst()
  if (!row) return null

  const accessRows = await db
    .selectFrom("workspace_access_bindings")
    .select("access_key")
    .where("workspace_member_id", "=", workspaceMemberId)
    .where("status", "=", ACCESS_BINDING_STATUS.ACTIVE)
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
    .selectFrom("actors as actor")
    .innerJoin("workspace_apps as app", "app.id", "actor.id")
    .select([
      "actor.id",
      "app.workspace_id",
      "app.owner_workspace_member_id",
      sql<boolean>`app.status = 'active'`.as("is_active"),
    ])
    .where("actor.id", "=", actorId)
    .where("app.deleted_at", "is", null)
    .limit(1)
    .executeTakeFirst()) as ActorRow | null
}

async function loadRemoteAgentRow(
  db: KyselyDb,
  remoteAgentId: string
): Promise<RemoteAgentRow | null> {
  const result = await sql<RemoteAgentRow>`
    SELECT
      agent.id,
      app.workspace_id,
      app.owner_workspace_member_id,
      (app.status = 'active') AS is_active,
      agent.is_public_shared
    FROM remote_agents agent
    INNER JOIN workspace_apps app
      ON app.id = agent.id
    WHERE agent.id = ${remoteAgentId}
      AND app.deleted_at IS NULL
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
    .select([
      "conversation.id as id",
      "conversation.workspace_id as workspace_id",
      "conversation.kind as kind",
    ])
    .where("conversation.id", "=", conversationId)
    .limit(1)
    .executeTakeFirst()) as unknown as ConversationRow | null
}

async function loadPlatformAccessKeysForUser(db: KyselyDb, userId: string) {
  const rows = await db
    .selectFrom("platform_access_bindings")
    .select("access_key")
    .where("user_id", "=", userId)
    .where("status", "=", "active")
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
  permission: string,
  runtimeScopeSubjectIds?: readonly string[],
  runtimeSubjectIds?: readonly string[]
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
    actor.owner_workspace_member_id === access.id ||
    (await hasWorkspaceAppGrant(db, {
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
  // workspace_app_grants rows:
  //   - owners stay implicitly visible to themselves, and
  //   - everyone else needs an explicit contact_visible grant.
  const canUse =
    actor.owner_workspace_member_id === access.id ||
    (await hasWorkspaceAppGrant(db, {
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
      remoteAgent.owner_workspace_member_id === access.id ||
      (await hasWorkspaceAppGrant(db, {
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
  // P2: same fold as hasActorPermission — bindings are authoritative.
  // Cross-workspace `is_public_shared` still requires an explicit binding to
  // be granted; the publishing workspace's auto-write happens on create.
  const canUse =
    (sameWorkspace && remoteAgent.owner_workspace_member_id === access.id) ||
    (await hasWorkspaceAppGrant(db, {
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

type ResourceGrantRow = {
  resource_id: string
  subject_kind: string
  subject_workspace_id_via_join: string | null
  subject_workspace_member_id_via_join: string | null
  subject_actor_id_via_join: string | null
  subject_conversation_id_via_join: string | null
}

type LegacyBindableResourceTypeLocal = "automation_event_source"

type WorkspaceAppBindableResourceTypeLocal =
  | "installed_skill"
  | "plugin_installation"
  | "device_capability"

const BINDABLE_WORKSPACE_APP_KIND: Record<
  WorkspaceAppBindableResourceTypeLocal,
  (typeof WORKSPACE_APP_KIND)[keyof typeof WORKSPACE_APP_KIND]
> = {
  installed_skill: WORKSPACE_APP_KIND.INSTALLED_SKILL,
  plugin_installation: WORKSPACE_APP_KIND.PLUGIN_INSTALLATION,
  device_capability: WORKSPACE_APP_KIND.DEVICE_CAPABILITY,
}

function bindableResourceIdColumn(
  resourceType: LegacyBindableResourceTypeLocal
) {
  return "automation_event_source_id"
}

async function listResourceGrantRows(
  db: KyselyDb,
  resourceType: LegacyBindableResourceTypeLocal,
  resourceId: string | null,
  subject: PermissionSubject,
  // PR3: optional scope context. When undefined → filter to scope_subject_id IS NULL
  // (legacy callers don't see scoped-subject grants). When non-null → filter
  // scope_subject_id IS NULL OR scope_subject_id ∈ runtimeScopeSubjectIds.
  runtimeScopeSubjectIds?: readonly string[],
  // P1 fix (post-D4): the per-principal `subject.type` branches below only
  // match bindings whose `subject_id` points at the principal itself
  // (workspace / actor / remote_agent / workspace_member subjects). They
  // don't surface grants written against group subjects the principal is
  // currently *inside* — most notably `subject=conversation C` grants when
  // the principal is an active participant of C. `runtimeSubjectIds` is the
  // full set of subject_ids the principal can claim under right now (from
  // `RuntimePrincipalContext`); we OR it into the matcher so those group
  // grants are surfaced. Without this parameter the function preserves the
  // legacy per-principal-only matching (which is still correct, just narrower).
  runtimeSubjectIds?: readonly string[]
): Promise<ResourceGrantRow[]> {
  const resourceIdColumn = bindableResourceIdColumn(resourceType)

  let query = db
    .selectFrom("resource_access_bindings as binding")
    .innerJoin("access_subjects as subj", "subj.id", "binding.subject_id")
    .select([
      sql<string>`binding.automation_event_source_id::text`.as("resource_id"),
      sql<string>`subj.kind`.as("subject_kind"),
      sql<string | null>`subj.workspace_id`.as("subject_workspace_id_via_join"),
      sql<string | null>`subj.workspace_member_id`.as(
        "subject_workspace_member_id_via_join"
      ),
      sql<string | null>`subj.actor_id`.as("subject_actor_id_via_join"),
      sql<string | null>`subj.conversation_id`.as(
        "subject_conversation_id_via_join"
      ),
    ])
    .where("binding.status", "=", "active")

  // PR3: scope filter — `subject_id ∈ runtime AND (scope_subject_id IS NULL OR
  // scope_subject_id ∈ runtimeScopeSubjectIds)`. When no scope context is
  // provided we keep the conservative "NULL scope only" filter so legacy
  // callers don't accidentally see scoped grants.
  if (runtimeScopeSubjectIds && runtimeScopeSubjectIds.length > 0) {
    query = query.where((eb) =>
      eb.or([
        eb("binding.scope_subject_id", "is", null),
        eb("binding.scope_subject_id", "in", [...runtimeScopeSubjectIds]),
      ])
    )
  } else {
    query = query.where("binding.scope_subject_id", "is", null)
  }

  if (resourceId) {
    query = query.where(`binding.${resourceIdColumn}` as any, "=", resourceId)
  }

  // P1 fix: combine the per-principal matcher (legacy) with a runtime-subject
  // matcher (post-D4) so group-subject bindings — most notably
  // `subject=conversation C` — match active participants.
  const extraRuntimeSubjectIds =
    runtimeSubjectIds && runtimeSubjectIds.length > 0
      ? [...runtimeSubjectIds]
      : null

  if (subject.type === "workspace") {
    query = query.where((eb) =>
      eb.or([
        eb.and([
          eb("subj.kind", "=", "workspace"),
          eb("subj.workspace_id", "=", subject.id),
        ]),
        ...(extraRuntimeSubjectIds
          ? [eb("binding.subject_id", "in", extraRuntimeSubjectIds)]
          : []),
      ])
    )
  } else if (subject.type === "actor") {
    query = query.where((eb) =>
      eb.or([
        eb.and([
          eb("subj.kind", "=", "actor"),
          eb("subj.actor_id", "=", subject.id),
        ]),
        ...(extraRuntimeSubjectIds
          ? [eb("binding.subject_id", "in", extraRuntimeSubjectIds)]
          : []),
      ])
    )
  } else if (subject.type === "remote_agent") {
    // PR4 fix: previously fell through to the `return []` below, which meant
    // a remote_agent principal never matched any binding even when the
    // binding's subject_id pointed at exactly that remote_agent.
    query = query.where((eb) =>
      eb.or([
        eb.and([
          eb("subj.kind", "=", "remote_agent"),
          eb("subj.remote_agent_id", "=", subject.id),
        ]),
        ...(extraRuntimeSubjectIds
          ? [eb("binding.subject_id", "in", extraRuntimeSubjectIds)]
          : []),
      ])
    )
  } else if (subject.type === "workspace_member") {
    const access = await loadWorkspaceMemberAccess(db, subject.id)
    if (!access) {
      return []
    }
    // P2 fix: a workspace_member subject matches BOTH
    //   (a) grants targeting the workspace they belong to (default workspace
    //       visibility + workspace-wide grants), AND
    //   (b) grants targeting them specifically (workspace_member-scoped
    //       approval grants — written by grantApprovedContactVisibility).
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
        ...(extraRuntimeSubjectIds
          ? [eb("binding.subject_id", "in", extraRuntimeSubjectIds)]
          : []),
      ])
    )
  } else {
    return []
  }

  return (await query.execute()) as unknown as ResourceGrantRow[]
}

async function listWorkspaceAppGrantRows(
  db: KyselyDb,
  params: {
    resourceType:
      | "installed_skill"
      | "plugin_installation"
      | "device_capability"
      | "actor"
      | "remote_agent"
    resourceId: string | null
    requiredGrantPermission: "use" | "contact_visible" | "manage"
    subject: PermissionSubject
    runtimeScopeSubjectIds?: readonly string[]
    runtimeSubjectIds?: readonly string[]
  }
): Promise<ResourceGrantRow[]> {
  let query = db
    .selectFrom("workspace_app_grants as app_grant")
    .innerJoin("workspace_apps as app", "app.id", "app_grant.workspace_app_id")
    .innerJoin("access_subjects as subj", "subj.id", "app_grant.subject_id")
    .select([
      "app_grant.workspace_app_id as resource_id",
      sql<string>`subj.kind`.as("subject_kind"),
      sql<string | null>`subj.workspace_id`.as("subject_workspace_id_via_join"),
      sql<string | null>`subj.workspace_member_id`.as(
        "subject_workspace_member_id_via_join"
      ),
      sql<string | null>`subj.actor_id`.as("subject_actor_id_via_join"),
      sql<string | null>`subj.conversation_id`.as(
        "subject_conversation_id_via_join"
      ),
    ])
    .where("app_grant.status", "=", "active")
    .where("app.kind", "=", params.resourceType)
    .where("app.deleted_at", "is", null)
    .where("app.status", "=", "active")
    .where(
      sql<boolean>`${params.requiredGrantPermission}::workspace_app_grant_permission = ANY(app_grant.permissions)`
    )

  const runtimeScopeSubjectIds = params.runtimeScopeSubjectIds ?? []
  if (runtimeScopeSubjectIds.length > 0) {
    query = query.where((eb) =>
      eb.or([
        eb("app_grant.scope_subject_id", "is", null),
        eb("app_grant.scope_subject_id", "in", [...runtimeScopeSubjectIds]),
      ])
    )
  } else {
    query = query.where("app_grant.scope_subject_id", "is", null)
  }

  if (params.resourceId) {
    query = query.where("app_grant.workspace_app_id", "=", params.resourceId)
  }

  const extraRuntimeSubjectIds =
    params.runtimeSubjectIds && params.runtimeSubjectIds.length > 0
      ? [...params.runtimeSubjectIds]
      : null

  if (params.subject.type === "workspace") {
    query = query.where((eb) =>
      eb.or([
        eb.and([
          eb("subj.kind", "=", "workspace"),
          eb("subj.workspace_id", "=", params.subject.id),
        ]),
        ...(extraRuntimeSubjectIds
          ? [eb("app_grant.subject_id", "in", extraRuntimeSubjectIds)]
          : []),
      ])
    )
  } else if (params.subject.type === "actor") {
    query = query.where((eb) =>
      eb.or([
        eb.and([
          eb("subj.kind", "=", "actor"),
          eb("subj.actor_id", "=", params.subject.id),
        ]),
        ...(extraRuntimeSubjectIds
          ? [eb("app_grant.subject_id", "in", extraRuntimeSubjectIds)]
          : []),
      ])
    )
  } else if (params.subject.type === "remote_agent") {
    query = query.where((eb) =>
      eb.or([
        eb.and([
          eb("subj.kind", "=", "remote_agent"),
          eb("subj.remote_agent_id", "=", params.subject.id),
        ]),
        ...(extraRuntimeSubjectIds
          ? [eb("app_grant.subject_id", "in", extraRuntimeSubjectIds)]
          : []),
      ])
    )
  } else if (params.subject.type === "workspace_member") {
    const access = await loadWorkspaceMemberAccess(db, params.subject.id)
    if (!access) {
      return []
    }
    query = query.where((eb) =>
      eb.or([
        eb.and([
          eb("subj.kind", "=", "workspace"),
          eb("subj.workspace_id", "=", access.workspaceId),
        ]),
        eb.and([
          eb("subj.kind", "=", "workspace_member"),
          eb("subj.workspace_member_id", "=", params.subject.id),
        ]),
        ...(extraRuntimeSubjectIds
          ? [eb("app_grant.subject_id", "in", extraRuntimeSubjectIds)]
          : []),
      ])
    )
  } else {
    return []
  }

  return (await query.execute()) as unknown as ResourceGrantRow[]
}

async function hasResourceGrant(
  db: KyselyDb,
  resourceType: LegacyBindableResourceTypeLocal,
  resourceId: string,
  subject: PermissionSubject,
  runtimeScopeSubjectIds?: readonly string[],
  runtimeSubjectIds?: readonly string[]
) {
  const rows = await listResourceGrantRows(
    db,
    resourceType,
    resourceId,
    subject,
    runtimeScopeSubjectIds,
    runtimeSubjectIds
  )
  return rows.length > 0
}

async function hasWorkspaceAppGrant(
  db: KyselyDb,
  params: {
    resourceType:
      | "installed_skill"
      | "plugin_installation"
      | "device_capability"
      | "actor"
      | "remote_agent"
    resourceId: string
    requiredGrantPermission: "use" | "contact_visible" | "manage"
    subject: PermissionSubject
    runtimeScopeSubjectIds?: readonly string[]
    runtimeSubjectIds?: readonly string[]
  }
) {
  const rows = await listWorkspaceAppGrantRows(db, {
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    requiredGrantPermission: params.requiredGrantPermission,
    subject: params.subject,
    runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
    runtimeSubjectIds: params.runtimeSubjectIds,
  })
  return rows.length > 0
}

async function listGrantedResourceIds(
  db: KyselyDb,
  resourceType: LegacyBindableResourceTypeLocal,
  subject: PermissionSubject,
  limit?: number,
  runtimeScopeSubjectIds?: readonly string[],
  runtimeSubjectIds?: readonly string[]
) {
  const rows = await listResourceGrantRows(
    db,
    resourceType,
    null,
    subject,
    runtimeScopeSubjectIds,
    runtimeSubjectIds
  )
  const ids = Array.from(new Set(rows.map((row) => row.resource_id)))
  return typeof limit === "number" && limit > 0 ? ids.slice(0, limit) : ids
}

async function listGrantedWorkspaceAppIds(
  db: KyselyDb,
  params: {
    resourceType:
      | "installed_skill"
      | "plugin_installation"
      | "device_capability"
      | "actor"
      | "remote_agent"
    requiredGrantPermission: "use" | "contact_visible"
    subject: PermissionSubject
    limit?: number
    runtimeScopeSubjectIds?: readonly string[]
    runtimeSubjectIds?: readonly string[]
  }
) {
  const rows = await listWorkspaceAppGrantRows(db, {
    resourceType: params.resourceType,
    resourceId: null,
    requiredGrantPermission: params.requiredGrantPermission,
    subject: params.subject,
    runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
    runtimeSubjectIds: params.runtimeSubjectIds,
  })
  const ids = Array.from(new Set(rows.map((row) => row.resource_id)))
  return typeof params.limit === "number" && params.limit > 0
    ? ids.slice(0, params.limit)
    : ids
}

async function listManageableWorkspaceAppIds(
  db: KyselyDb,
  params: {
    resourceType: WorkspaceAppBindableResourceTypeLocal
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

  const appKind = BINDABLE_WORKSPACE_APP_KIND[params.resourceType]
  if (workspacePermissionFromAccess(access, params.manageAccessKey)) {
    const rows = await db
      .selectFrom("workspace_apps as app")
      .select("app.id")
      .where("app.workspace_id", "=", access.workspaceId)
      .where("app.kind", "=", appKind)
      .where("app.deleted_at", "is", null)
      .where("app.status", "=", WORKSPACE_APP_STATUS.ACTIVE)
      .orderBy("app.created_at", "desc")
      .execute()
    return finalizeResourceIdList([rows.map((row) => row.id)], params.limit)
  }

  const [ownRows, grantRows] = await Promise.all([
    db
      .selectFrom("workspace_apps as app")
      .select("app.id")
      .where("app.workspace_id", "=", access.workspaceId)
      .where("app.kind", "=", appKind)
      .where("app.deleted_at", "is", null)
      .where("app.status", "=", WORKSPACE_APP_STATUS.ACTIVE)
      .where("app.owner_workspace_member_id", "=", access.id)
      .orderBy("app.created_at", "desc")
      .execute(),
    listWorkspaceAppGrantRows(db, {
      resourceType: params.resourceType,
      resourceId: null,
      requiredGrantPermission: WORKSPACE_APP_GRANT_PERMISSION.MANAGE,
      subject: params.subject,
      runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
      runtimeSubjectIds: params.runtimeSubjectIds,
    }),
  ])

  const grantedIds = Array.from(
    new Set(grantRows.map((row) => row.resource_id))
  )
  const grantedRows =
    grantedIds.length === 0
      ? []
      : await db
          .selectFrom("workspace_apps as app")
          .select("app.id")
          .where("app.id", "in", grantedIds)
          .where("app.workspace_id", "=", access.workspaceId)
          .where("app.kind", "=", appKind)
          .where("app.deleted_at", "is", null)
          .where("app.status", "=", WORKSPACE_APP_STATUS.ACTIVE)
          .orderBy("app.created_at", "desc")
          .execute()

  return finalizeResourceIdList(
    [ownRows.map((row) => row.id), grantedRows.map((row) => row.id)],
    params.limit
  )
}

async function listBindableWorkspaceAppIdsForPermission(
  db: KyselyDb,
  params: {
    resourceType: WorkspaceAppBindableResourceTypeLocal
    permission: string
    manageAccessKey: string
    subject: PermissionSubject
    limit?: number
    runtimeScopeSubjectIds?: readonly string[]
    runtimeSubjectIds?: readonly string[]
  }
) {
  if (params.permission === "use") {
    return listGrantedWorkspaceAppIds(db, {
      resourceType: params.resourceType,
      requiredGrantPermission: WORKSPACE_APP_GRANT_PERMISSION.USE,
      subject: params.subject,
      limit: params.limit,
      runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
      runtimeSubjectIds: params.runtimeSubjectIds,
    })
  }

  if (params.permission === "request_runtime_authorization") {
    return params.resourceType === "device_capability"
      ? listGrantedWorkspaceAppIds(db, {
          resourceType: params.resourceType,
          requiredGrantPermission: WORKSPACE_APP_GRANT_PERMISSION.USE,
          subject: params.subject,
          limit: params.limit,
          runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
          runtimeSubjectIds: params.runtimeSubjectIds,
        })
      : []
  }

  if (params.permission === "view") {
    return listGrantedWorkspaceAppIds(db, {
      resourceType: params.resourceType,
      requiredGrantPermission: WORKSPACE_APP_GRANT_PERMISSION.USE,
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
    return listManageableWorkspaceAppIds(db, {
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
 *      workspace_app_grants row short-circuits to allow;
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
    resourceType: WorkspaceAppBindableResourceTypeLocal
    resourceId: string
    workspaceId: string
    ownerWorkspaceMemberId: string | null
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
      await hasWorkspaceAppGrant(db, {
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

  // (2) manage path — workspace_member in the same workspace, holding the
  // manage key or being the app owner.
  if (params.subject.type !== "workspace_member") {
    return false
  }

  const access = await loadWorkspaceMemberAccess(db, params.subject.id)
  if (!access || access.workspaceId !== params.workspaceId) {
    return false
  }

  return (
    (await hasWorkspaceAppGrant(db, {
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
  const row = await db
    .selectFrom("installed_skills as skill")
    .innerJoin("workspace_apps as app", "app.id", "skill.id")
    .select(["app.workspace_id", "app.owner_workspace_member_id", "app.status"])
    .where("skill.id", "=", skillId)
    .where("app.deleted_at", "is", null)
    .limit(1)
    .executeTakeFirst()
  if (!row || row.status !== "active") {
    return false
  }

  return resolveBindableResourceAccess(db, {
    resourceType: "installed_skill",
    resourceId: skillId,
    workspaceId: row.workspace_id,
    ownerWorkspaceMemberId: row.owner_workspace_member_id,
    manageAccessKey: "manage_skills",
    grantablePermissions: ["use", "view"],
    manageablePermissions: ["view", "edit", "grant", "delete"],
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
  const row = await db
    .selectFrom("plugin_installations as installation")
    .innerJoin("workspace_apps as app", "app.id", "installation.id")
    .select(["app.workspace_id", "app.owner_workspace_member_id", "app.status"])
    .where("installation.id", "=", installationId)
    .where("app.deleted_at", "is", null)
    .limit(1)
    .executeTakeFirst()
  if (!row || row.status !== "active") {
    return false
  }

  return resolveBindableResourceAccess(db, {
    resourceType: "plugin_installation",
    resourceId: installationId,
    workspaceId: row.workspace_id,
    ownerWorkspaceMemberId: row.owner_workspace_member_id,
    manageAccessKey: "manage_plugins",
    grantablePermissions: ["use", "view"],
    manageablePermissions: ["view", "edit", "grant", "delete"],
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
  const row = await db
    .selectFrom("devices")
    .select(["workspace_id", "owner_workspace_member_id"])
    .where("id", "=", deviceId)
    // Soft delete (§8): a soft-deleted/closed device is never authorizable.
    .where("deleted_at", "is", null)
    .limit(1)
    .executeTakeFirst()
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
  if (!access || access.workspaceId !== row.workspace_id) {
    return false
  }

  const canManage =
    workspacePermissionFromAccess(access, "manage_devices") ||
    row.owner_workspace_member_id === access.id

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
  const row = await db
    .selectFrom("device_exposures as exposure")
    .innerJoin("devices as device", "device.id", "exposure.device_id")
    .select(["device.id as device_id"])
    .where("exposure.id", "=", exposureId)
    .limit(1)
    .executeTakeFirst()
  if (!row?.device_id) {
    return false
  }
  return hasDevicePermission(
    db,
    subject,
    row.device_id,
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
  const row = await db
    .selectFrom("device_capabilities as capability")
    .innerJoin("workspace_apps as app", "app.id", "capability.id")
    .innerJoin(
      "device_exposures as exposure",
      "exposure.id",
      "capability.exposure_id"
    )
    .innerJoin("devices as device", "device.id", "exposure.device_id")
    .select([
      "app.workspace_id",
      "app.status",
      "device.id as device_id",
      "device.owner_workspace_member_id",
    ])
    .where("capability.id", "=", capabilityId)
    .where("app.deleted_at", "is", null)
    .limit(1)
    .executeTakeFirst()
  if (!row || row.status !== "active") {
    return false
  }

  return resolveBindableResourceAccess(db, {
    resourceType: "device_capability",
    resourceId: capabilityId,
    workspaceId: row.workspace_id,
    ownerWorkspaceMemberId: row.owner_workspace_member_id,
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
  const [ownActors, grantedIds] = await Promise.all([
    db
      .selectFrom("actors as a")
      .innerJoin("workspace_apps as app", "app.id", "a.id")
      .select("a.id")
      .where("app.workspace_id", "=", access.workspaceId)
      .where("app.deleted_at", "is", null)
      .where("app.status", "=", "active")
      .where("app.owner_workspace_member_id", "=", access.id)
      .orderBy("a.created_at", "desc")
      .execute(),
    listGrantedWorkspaceAppIds(db, {
      resourceType: "actor",
      requiredGrantPermission: "contact_visible",
      subject,
      runtimeScopeSubjectIds,
      runtimeSubjectIds,
    }),
  ])
  return finalizeResourceIdList(
    [ownActors.map((row) => row.id), grantedIds],
    limit
  )
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
  // workspace_app_grants. Cross-workspace public-shared discovery remains in
  // the relationship/friend model and is handled outside this grant lookup.
  const [ownAgents, grantedIds] = await Promise.all([
    db
      .selectFrom("remote_agents as agent")
      .innerJoin("workspace_apps as app", "app.id", "agent.id")
      .select("agent.id")
      .where("app.status", "=", "active")
      .where("app.deleted_at", "is", null)
      .where("app.workspace_id", "=", access.workspaceId)
      .where("app.owner_workspace_member_id", "=", access.id)
      .orderBy("agent.created_at", "desc")
      .execute(),
    listGrantedWorkspaceAppIds(db, {
      resourceType: "remote_agent",
      requiredGrantPermission: "contact_visible",
      subject,
      runtimeScopeSubjectIds,
      runtimeSubjectIds,
    }),
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
          eb("mgs.kind", "=", "platform"),
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
        eb("mgs.kind", "=", "platform"),
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

type MemorySpaceLoadedRow = {
  id: string
  workspace_id: string
  owner_subject_id: string
  scope_subject_id: string | null
  namespace_key: string
  owner_kind: string
  owner_workspace_id: string | null
  owner_actor_id: string | null
  owner_remote_agent_id: string | null
  owner_workspace_member_id: string | null
  owner_conversation_id: string | null
  scope_kind: string | null
  scope_conversation_id: string | null
}

async function loadMemorySpaceWithSubjects(
  db: KyselyDb,
  memorySpaceId: string
): Promise<MemorySpaceLoadedRow | null> {
  const row = await db
    .selectFrom("memory_spaces as ms")
    .innerJoin(
      "access_subjects as owner_subj",
      "owner_subj.id",
      "ms.owner_subject_id"
    )
    .leftJoin(
      "access_subjects as scope_subj",
      "scope_subj.id",
      "ms.scope_subject_id"
    )
    .select([
      "ms.id as id",
      "ms.workspace_id as workspace_id",
      "ms.owner_subject_id as owner_subject_id",
      "ms.scope_subject_id as scope_subject_id",
      "ms.namespace_key as namespace_key",
      "owner_subj.kind as owner_kind",
      "owner_subj.workspace_id as owner_workspace_id",
      "owner_subj.actor_id as owner_actor_id",
      "owner_subj.remote_agent_id as owner_remote_agent_id",
      "owner_subj.workspace_member_id as owner_workspace_member_id",
      "owner_subj.conversation_id as owner_conversation_id",
      "scope_subj.kind as scope_kind",
      "scope_subj.conversation_id as scope_conversation_id",
    ])
    .where("ms.id", "=", memorySpaceId)
    .limit(1)
    .executeTakeFirst()
  return (row as unknown as MemorySpaceLoadedRow | undefined) ?? null
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
    !space.scope_subject_id ||
    (runtimeContext?.runtimeScopeSubjectIds?.includes(space.scope_subject_id) ??
      false)

  const adminManageOverride = async (): Promise<boolean> => {
    if (permission !== "manage" && permission !== "delete") return false
    return hasWorkspacePermission(
      db,
      subject,
      space.workspace_id,
      "manage_memories"
    )
  }

  if (!scopeOk) {
    return adminManageOverride()
  }

  switch (space.owner_kind) {
    case "workspace_member":
      if (inRuntime(space.owner_subject_id)) {
        return true // all permissions
      }
      return adminManageOverride()
    case "actor":
      if (inRuntime(space.owner_subject_id)) {
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
        space.owner_actor_id &&
        permission === "write" &&
        (await hasActorPermission(db, subject, space.owner_actor_id, "edit"))
      ) {
        return true
      }
      return adminManageOverride()
    case "remote_agent":
      if (inRuntime(space.owner_subject_id)) {
        return (
          permission === "read" ||
          permission === "recall" ||
          permission === "write" ||
          permission === "edit"
        )
      }
      // Same write-only curation pattern as actor — see comment above.
      if (
        space.owner_remote_agent_id &&
        permission === "write" &&
        (await hasRemoteAgentPermission(
          db,
          subject,
          space.owner_remote_agent_id,
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
            actor &&
            actor.workspace_id === space.workspace_id &&
            actor.is_active
          )
        }
        return hasWorkspacePermission(db, subject, space.workspace_id, "view")
      }
      return hasWorkspacePermission(
        db,
        subject,
        space.workspace_id,
        "manage_memories"
      )
    case "conversation":
      if (!space.owner_conversation_id) return false
      if (permission === "manage" || permission === "delete") {
        return hasConversationPermission(
          db,
          subject,
          space.owner_conversation_id,
          permission === "manage" ? "manage" : "memory_delete"
        )
      }
      return hasConversationPermission(
        db,
        subject,
        space.owner_conversation_id,
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
  const row = await db
    .selectFrom("memory_items as mi")
    .select([
      "mi.id as memory_item_id",
      "mi.memory_space_id as memory_space_id",
    ])
    .where("mi.id", "=", memoryItemId)
    .limit(1)
    .executeTakeFirst()
  if (!row) return false

  // Space-level permission (owner-implicit OR space-level grant).
  if (
    await hasMemorySpacePermission(
      db,
      subject,
      row.memory_space_id,
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
        memorySpaceId: row.memory_space_id,
        memoryItemId: row.memory_item_id,
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
    workspace_id: tuple.workspaceId,
    owner_subject_id: tuple.ownerSubjectId,
    scope_subject_id: tuple.scopeSubjectId,
    namespace_key: "(synthetic)",
    owner_kind: tuple.owner.kind,
    owner_workspace_id:
      tuple.owner.kind === SUBJECT_KIND.WORKSPACE
        ? tuple.owner.workspaceId
        : null,
    owner_actor_id:
      tuple.owner.kind === SUBJECT_KIND.ACTOR ? tuple.owner.actorId : null,
    owner_remote_agent_id:
      tuple.owner.kind === SUBJECT_KIND.REMOTE_AGENT
        ? tuple.owner.remoteAgentId
        : null,
    owner_workspace_member_id:
      tuple.owner.kind === SUBJECT_KIND.WORKSPACE_MEMBER
        ? tuple.owner.memberId
        : null,
    owner_conversation_id:
      tuple.owner.kind === SUBJECT_KIND.CONVERSATION
        ? tuple.owner.conversationId
        : null,
    scope_kind: tuple.scope?.kind ?? null,
    scope_conversation_id:
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
      return listBindableWorkspaceAppIdsForPermission(db, {
        resourceType: "installed_skill",
        permission: params.permission,
        manageAccessKey: "manage_skills",
        subject: params.subject,
        limit: params.limit,
        runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
        runtimeSubjectIds: params.runtimeSubjectIds,
      })
    case "plugin_installation":
      return listBindableWorkspaceAppIdsForPermission(db, {
        resourceType: "plugin_installation",
        permission: params.permission,
        manageAccessKey: "manage_plugins",
        subject: params.subject,
        limit: params.limit,
        runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
        runtimeSubjectIds: params.runtimeSubjectIds,
      })
    case "device_capability":
      return listBindableWorkspaceAppIdsForPermission(db, {
        resourceType: "device_capability",
        permission: params.permission,
        manageAccessKey: "manage_devices",
        subject: params.subject,
        limit: params.limit,
        runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
        runtimeSubjectIds: params.runtimeSubjectIds,
      })
    case "automation_event_source":
      return params.permission === "use" || params.permission === "view"
        ? listGrantedResourceIds(
            db,
            "automation_event_source",
            params.subject,
            params.limit,
            params.runtimeScopeSubjectIds,
            params.runtimeSubjectIds
          )
        : []
    default:
      return []
  }
}

export { PLATFORM_RESOURCE_ID, type AccessResourceType, type PermissionSubject }
