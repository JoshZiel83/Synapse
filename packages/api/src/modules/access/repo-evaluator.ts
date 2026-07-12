import { sql } from "kysely"
import {
  ACCESS_BINDING_STATUS,
  CONVERSATION_KIND,
  SUBJECT_KIND,
  WORKSPACE_RESOURCE_GRANT_PERMISSION,
  WORKSPACE_RESOURCE_KIND,
  WORKSPACE_RESOURCE_STATUS,
  type WorkspaceResourceStatus,
} from "@synapse/shared"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import {
  liveConversations,
  liveDevices,
} from "../soft-delete/repo-live-reads.js"
import { upsertAccessSubject } from "./subject-registry.js"

type PermissionSubject = {
  type: "user" | "workspace_member" | "actor" | "remote_agent" | "workspace"
  id: string
}

export type WorkspaceMemberAccess = {
  id: string
  workspaceId: string
  userId: string
  trustLevel: string
  ownerId: string | null
  accessKeys: string[]
}

export type ActorRow = {
  id: string
  workspaceId: string
  ownerWorkspaceMemberId: string | null
  ownerSubjectId: string | null
  isActive: boolean
}

export type RemoteAgentRow = {
  id: string
  workspaceId: string
  ownerWorkspaceMemberId: string | null
  ownerSubjectId: string | null
  isActive: boolean
  isPublicShared: boolean
}

export type ConversationRow = {
  id: string
  workspaceId: string
  kind: "direct" | "group"
}

export type ResourceGrantRow = {
  resourceId: string
  subjectKind: string
  subjectWorkspaceIdViaJoin: string | null
  subjectWorkspaceMemberIdViaJoin: string | null
  subjectActorIdViaJoin: string | null
  subjectConversationIdViaJoin: string | null
}

export type WorkspaceResourceBindableResourceType =
  | "installed_skill"
  | "plugin_installation"
  | "runtime_capability"

type WorkspaceResourceGrantResourceType =
  | WorkspaceResourceBindableResourceType
  | "actor"
  | "remote_agent"
  | "automation_event_source"

export type WorkspaceResourceAccessRow = {
  id: string | null
  status: WorkspaceResourceStatus | null
}

export type WorkspaceResourceResourceAccessRow = {
  workspaceId: string
  ownerWorkspaceMemberId: string | null
  ownerSubjectId: string | null
  status: WorkspaceResourceStatus
}

export type DeviceAccessRow = {
  workspaceId: string
  ownerWorkspaceMemberId: string | null
}

export type MemorySpaceLoadedRow = {
  id: string
  workspaceId: string
  ownerSubjectId: string
  scopeSubjectId: string | null
  namespaceKey: string
  ownerKind: string
  ownerWorkspaceId: string | null
  ownerActorId: string | null
  ownerRemoteAgentId: string | null
  ownerWorkspaceMemberId: string | null
  ownerConversationId: string | null
  scopeKind: string | null
  scopeConversationId: string | null
}

const BINDABLE_WORKSPACE_RESOURCE_KIND: Record<
  WorkspaceResourceBindableResourceType,
  (typeof WORKSPACE_RESOURCE_KIND)[keyof typeof WORKSPACE_RESOURCE_KIND]
> = {
  installed_skill: WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL,
  plugin_installation: WORKSPACE_RESOURCE_KIND.PLUGIN_INSTALLATION,
  runtime_capability: WORKSPACE_RESOURCE_KIND.RUNTIME_CAPABILITY,
}

export async function loadWorkspaceMemberAccess(
  db: KyselyDb,
  workspaceMemberId: string
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
    .where("wm.id", "=", workspaceMemberId)
    .where("wm.status", "=", "active")
    .where("w.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()
  if (!row) return null

  const accessRows = await db
    .selectFrom("workspaceAccessBindings")
    .select("accessKey")
    .where("workspaceMemberId", "=", workspaceMemberId)
    .where("status", "=", ACCESS_BINDING_STATUS.ACTIVE)
    .execute()

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    trustLevel: row.trustLevel,
    ownerId: row.ownerId,
    accessKeys: accessRows.map((entry) => entry.accessKey),
  }
}

export async function loadActorRow(
  db: KyselyDb,
  actorId: string
): Promise<ActorRow | null> {
  return (await db
    .selectFrom("actors as actor")
    .innerJoin("workspaceResources as resource", "resource.id", "actor.id")
    .leftJoin(
      "accessSubjects as owner_subject",
      "owner_subject.id",
      "resource.ownerSubjectId"
    )
    .select([
      "actor.id",
      "resource.workspaceId",
      "owner_subject.workspaceMemberId as ownerWorkspaceMemberId",
      "resource.ownerSubjectId",
      sql<boolean>`resource.status = 'active'`.as("isActive"),
    ])
    .where("actor.id", "=", actorId)
    .where("resource.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()) as ActorRow | null
}

export async function loadRemoteAgentRow(
  db: KyselyDb,
  remoteAgentId: string
): Promise<RemoteAgentRow | null> {
  const result = await sql<RemoteAgentRow>`
    SELECT
      agent.id,
      resource.workspace_id,
      owner_subject.workspace_member_id AS owner_workspace_member_id,
      resource.owner_subject_id,
      (resource.status = 'active') AS is_active,
      agent.is_public_shared
    FROM remote_agents agent
    INNER JOIN workspace_resources_live resource
      ON resource.id = agent.id
    LEFT JOIN access_subjects owner_subject
      ON owner_subject.id = resource.owner_subject_id
    WHERE agent.id = ${remoteAgentId}
      AND resource.deleted_at IS NULL
    LIMIT 1
  `.execute(db)
  return result.rows[0] ?? null
}

export async function loadConversationRow(
  db: KyselyDb,
  conversationId: string
): Promise<ConversationRow | null> {
  const row = await liveConversations(db)
    .select(["id", "workspaceId", "kind"])
    .where("id", "=", conversationId)
    .limit(1)
    .executeTakeFirst()
  if (
    !row?.id ||
    !row.workspaceId ||
    (row.kind !== CONVERSATION_KIND.DIRECT &&
      row.kind !== CONVERSATION_KIND.GROUP)
  ) {
    return null
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind,
  }
}

export async function loadPlatformAccessKeysForUser(
  db: KyselyDb,
  userId: string
): Promise<string[]> {
  const rows = await db
    .selectFrom("platformAccessBindings")
    .select("accessKey")
    .where("userId", "=", userId)
    .where("status", "=", "active")
    .execute()
  return rows.map((row) => row.accessKey)
}

export async function hasActiveConversationMembership(
  db: KyselyDb,
  params: {
    conversationId: string
    workspaceMemberId?: string | null
    actorId?: string | null
  }
): Promise<{ id: string; roleKey: string | null } | null> {
  let subjectId: string | null = null
  if (params.workspaceMemberId) {
    subjectId = await upsertAccessSubject(db, {
      kind: SUBJECT_KIND.WORKSPACE_MEMBER,
      workspaceMemberId: params.workspaceMemberId,
    })
  } else if (params.actorId) {
    subjectId = await upsertAccessSubject(db, {
      kind: SUBJECT_KIND.ACTOR,
      actorId: params.actorId,
    })
  } else {
    return null
  }
  return (
    (await db
      .selectFrom("conversationParticipants")
      .select(["id", "roleKey"])
      .where("conversationId", "=", params.conversationId)
      .where("state", "=", "active")
      .where("subjectId", "=", subjectId)
      .limit(1)
      .executeTakeFirst()) ?? null
  )
}

export async function listWorkspaceResourceGrantRows(
  db: KyselyDb,
  params: {
    resourceType: WorkspaceResourceGrantResourceType
    resourceId: string | null
    requiredGrantPermission: "use" | "contact_visible" | "manage"
    subject: PermissionSubject
    runtimeScopeSubjectIds?: readonly string[]
    runtimeSubjectIds?: readonly string[]
  }
): Promise<ResourceGrantRow[]> {
  let query = db
    .selectFrom("workspaceResourceGrants as resource_grant")
    .innerJoin(
      "workspaceResources as resource",
      "resource.id",
      "resource_grant.workspaceResourceId"
    )
    .innerJoin("accessSubjects as subj", "subj.id", "resource_grant.subjectId")
    .select([
      "resource_grant.workspaceResourceId as resourceId",
      sql<string>`subj.kind`.as("subjectKind"),
      sql<string | null>`subj.workspace_id`.as("subjectWorkspaceIdViaJoin"),
      sql<string | null>`subj.workspace_member_id`.as(
        "subjectWorkspaceMemberIdViaJoin"
      ),
      sql<string | null>`subj.actor_id`.as("subjectActorIdViaJoin"),
      sql<string | null>`subj.conversation_id`.as(
        "subjectConversationIdViaJoin"
      ),
    ])
    .where("resource_grant.status", "=", "active")
    .where("resource.kind", "=", params.resourceType)
    .where("resource.deletedAt", "is", null)
    .where(
      sql<boolean>`${params.requiredGrantPermission}::workspace_resource_grant_permission = ANY(resource_grant.permissions)`
    )

  query =
    params.requiredGrantPermission ===
    WORKSPACE_RESOURCE_GRANT_PERMISSION.MANAGE
      ? query.where("resource.status", "!=", WORKSPACE_RESOURCE_STATUS.ARCHIVED)
      : query.where("resource.status", "=", WORKSPACE_RESOURCE_STATUS.ACTIVE)

  const runtimeScopeSubjectIds = params.runtimeScopeSubjectIds ?? []
  if (runtimeScopeSubjectIds.length > 0) {
    query = query.where((eb) =>
      eb.or([
        eb("resource_grant.scopeSubjectId", "is", null),
        eb("resource_grant.scopeSubjectId", "in", [...runtimeScopeSubjectIds]),
      ])
    )
  } else {
    query = query.where("resource_grant.scopeSubjectId", "is", null)
  }

  if (params.resourceId) {
    query = query.where(
      "resource_grant.workspaceResourceId",
      "=",
      params.resourceId
    )
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
          eb("subj.workspaceId", "=", params.subject.id),
        ]),
        ...(extraRuntimeSubjectIds
          ? [eb("resource_grant.subjectId", "in", extraRuntimeSubjectIds)]
          : []),
      ])
    )
  } else if (params.subject.type === "actor") {
    query = query.where((eb) =>
      eb.or([
        eb.and([
          eb("subj.kind", "=", "actor"),
          eb("subj.actorId", "=", params.subject.id),
        ]),
        ...(extraRuntimeSubjectIds
          ? [eb("resource_grant.subjectId", "in", extraRuntimeSubjectIds)]
          : []),
      ])
    )
  } else if (params.subject.type === "remote_agent") {
    query = query.where((eb) =>
      eb.or([
        eb.and([
          eb("subj.kind", "=", "remote_agent"),
          eb("subj.remoteAgentId", "=", params.subject.id),
        ]),
        ...(extraRuntimeSubjectIds
          ? [eb("resource_grant.subjectId", "in", extraRuntimeSubjectIds)]
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
          eb("subj.workspaceId", "=", access.workspaceId),
        ]),
        eb.and([
          eb("subj.kind", "=", "workspace_member"),
          eb("subj.workspaceMemberId", "=", params.subject.id),
        ]),
        ...(extraRuntimeSubjectIds
          ? [eb("resource_grant.subjectId", "in", extraRuntimeSubjectIds)]
          : []),
      ])
    )
  } else {
    return []
  }

  return await query.execute()
}

export async function listWorkspaceResourceAccessRows(
  db: KyselyDb,
  params: {
    workspaceId: string
    resourceType: WorkspaceResourceBindableResourceType
  }
): Promise<WorkspaceResourceAccessRow[]> {
  return await db
    .selectFrom("workspaceResourcesLive as resource")
    .select(["resource.id", "resource.status"])
    .where("resource.workspaceId", "=", params.workspaceId)
    .where(
      "resource.kind",
      "=",
      BINDABLE_WORKSPACE_RESOURCE_KIND[params.resourceType]
    )
    .where("resource.deletedAt", "is", null)
    .orderBy("resource.createdAt", "desc")
    .execute()
}

export async function listOwnedWorkspaceResourceAccessRows(
  db: KyselyDb,
  params: {
    workspaceId: string
    resourceType: WorkspaceResourceBindableResourceType
    ownerWorkspaceMemberId: string
  }
): Promise<WorkspaceResourceAccessRow[]> {
  const ownerSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    workspaceMemberId: params.ownerWorkspaceMemberId,
  })
  return await db
    .selectFrom("workspaceResourcesLive as resource")
    .select(["resource.id", "resource.status"])
    .where("resource.workspaceId", "=", params.workspaceId)
    .where(
      "resource.kind",
      "=",
      BINDABLE_WORKSPACE_RESOURCE_KIND[params.resourceType]
    )
    .where("resource.deletedAt", "is", null)
    .where("resource.ownerSubjectId", "=", ownerSubjectId)
    .orderBy("resource.createdAt", "desc")
    .execute()
}

export async function listWorkspaceResourceAccessRowsByIds(
  db: KyselyDb,
  params: {
    ids: readonly string[]
    workspaceId: string
    resourceType: WorkspaceResourceBindableResourceType
  }
): Promise<WorkspaceResourceAccessRow[]> {
  if (params.ids.length === 0) {
    return []
  }
  return await db
    .selectFrom("workspaceResourcesLive as resource")
    .select(["resource.id", "resource.status"])
    .where("resource.id", "in", [...params.ids])
    .where("resource.workspaceId", "=", params.workspaceId)
    .where(
      "resource.kind",
      "=",
      BINDABLE_WORKSPACE_RESOURCE_KIND[params.resourceType]
    )
    .where("resource.deletedAt", "is", null)
    .orderBy("resource.createdAt", "desc")
    .execute()
}

export async function loadInstalledSkillAccessRow(
  db: KyselyDb,
  skillId: string
): Promise<WorkspaceResourceResourceAccessRow | null> {
  return (
    (await db
      .selectFrom("installedSkills as skill")
      .innerJoin("workspaceResources as resource", "resource.id", "skill.id")
      .leftJoin(
        "accessSubjects as owner_subject",
        "owner_subject.id",
        "resource.ownerSubjectId"
      )
      .select([
        "resource.workspaceId",
        "owner_subject.workspaceMemberId as ownerWorkspaceMemberId",
        "resource.ownerSubjectId",
        "resource.status",
      ])
      .where("skill.id", "=", skillId)
      .where("resource.deletedAt", "is", null)
      .limit(1)
      .executeTakeFirst()) ?? null
  )
}

export async function loadPluginInstallationAccessRow(
  db: KyselyDb,
  installationId: string
): Promise<WorkspaceResourceResourceAccessRow | null> {
  return (
    (await db
      .selectFrom("pluginInstallations as installation")
      .innerJoin(
        "workspaceResources as resource",
        "resource.id",
        "installation.id"
      )
      .leftJoin(
        "accessSubjects as owner_subject",
        "owner_subject.id",
        "resource.ownerSubjectId"
      )
      .select([
        "resource.workspaceId",
        "owner_subject.workspaceMemberId as ownerWorkspaceMemberId",
        "resource.ownerSubjectId",
        "resource.status",
      ])
      .where("installation.id", "=", installationId)
      .where("resource.deletedAt", "is", null)
      .limit(1)
      .executeTakeFirst()) ?? null
  )
}

export async function loadDeviceAccessRow(
  db: KyselyDb,
  deviceId: string
): Promise<DeviceAccessRow | null> {
  const row = await liveDevices(db)
    .select(["workspaceId", "ownerWorkspaceMemberId"])
    .where("id", "=", deviceId)
    .limit(1)
    .executeTakeFirst()
  if (!row?.workspaceId) {
    return null
  }
  return {
    workspaceId: row.workspaceId,
    ownerWorkspaceMemberId: row.ownerWorkspaceMemberId,
  }
}

export async function loadRuntimeExposureRuntimeId(
  db: KyselyDb,
  exposureId: string
): Promise<string | null> {
  const row = await db
    .selectFrom("runtimeExposures as exposure")
    // Generalized to the runtimes supertype (P2): a device-less sandbox runtime's
    // exposure resolves its runtime principal id. runtime.id === exposure.runtimeId
    // (=== device.id for a real device), so byte-identical for devices.
    .innerJoin("runtimes as runtime", "runtime.id", "exposure.runtimeId")
    .select(["runtime.id as runtimeId"])
    .where("exposure.id", "=", exposureId)
    .limit(1)
    .executeTakeFirst()
  return row?.runtimeId ?? null
}

export type RuntimeExposureOwnerRow = {
  runtimeId: string
  /** runtimes.kind — 'device' | 'sandbox' (the CTI discriminant). */
  runtimeKind: string
  /**
   * For a kind='sandbox' runtime: the owning session's actor id (the sandbox's
   * owning subject, via sandboxes.session_id → sessions.actor_id). NULL for a
   * device runtime, or for a sandbox with no session bound yet (pre-session
   * provisioning) — in which case the caller fails CLOSED via the sandbox branch.
   */
  sandboxOwnerActorId: string | null
}

/**
 * Resolve a runtime exposure to its owning runtime id + kind, and (for a sandbox)
 * the owning-subject actor. hasExposurePermission routes on `runtimeKind`: a
 * device exposure keeps the devices-table permission path; a sandbox exposure —
 * which has NO `devices` row and would ALWAYS deny under the device path — routes
 * through its owning actor instead. Existence join on `runtimes` (no device
 * columns selected), so a device-less sandbox resolves; byte-identical runtimeId
 * for a device (runtime.id === device.id). Mirrors loadRuntimeExposureRuntimeId
 * but carries the kind + sandbox owner needed for the supertype routing.
 */
export async function loadRuntimeExposureOwner(
  db: KyselyDb,
  exposureId: string
): Promise<RuntimeExposureOwnerRow | null> {
  const row = await db
    .selectFrom("runtimeExposures as exposure")
    .innerJoin("runtimes as runtime", "runtime.id", "exposure.runtimeId")
    // Detail + session are LEFT joins: a device runtime has neither; a sandbox
    // has a `sandboxes` detail (id === runtime.id) whose session_id → sessions
    // carries the owning actor. A sandbox without a bound session yields NULL
    // sandboxOwnerActorId → fail-closed in the evaluator's sandbox branch.
    .leftJoin("sandboxes as sandbox", "sandbox.id", "runtime.id")
    .leftJoin("sessions as session", "session.id", "sandbox.sessionId")
    .select([
      "runtime.id as runtimeId",
      "runtime.kind as runtimeKind",
      "session.actorId as sandboxOwnerActorId",
    ])
    .where("exposure.id", "=", exposureId)
    .limit(1)
    .executeTakeFirst()
  if (!row?.runtimeId) {
    return null
  }
  return {
    runtimeId: row.runtimeId as string,
    runtimeKind: row.runtimeKind as string,
    sandboxOwnerActorId: (row.sandboxOwnerActorId as string | null) ?? null,
  }
}

export async function loadRuntimeCapabilityAccessRow(
  db: KyselyDb,
  capabilityId: string
): Promise<WorkspaceResourceResourceAccessRow | null> {
  return (
    (await db
      .selectFrom("runtimeCapabilities as capability")
      .innerJoin(
        "workspaceResources as resource",
        "resource.id",
        "capability.id"
      )
      .innerJoin(
        "runtimeExposures as exposure",
        "exposure.id",
        "capability.exposureId"
      )
      // Generalized to the runtimes supertype (P2): existence-only join (no
      // device columns selected), so a device-less sandbox runtime's capability
      // access row resolves. Byte-identical for a real device.
      .innerJoin("runtimes as runtime", "runtime.id", "exposure.runtimeId")
      .leftJoin(
        "accessSubjects as owner_subject",
        "owner_subject.id",
        "resource.ownerSubjectId"
      )
      .select([
        "resource.workspaceId",
        "resource.status",
        "owner_subject.workspaceMemberId as ownerWorkspaceMemberId",
        "resource.ownerSubjectId",
      ])
      .where("capability.id", "=", capabilityId)
      .where("resource.deletedAt", "is", null)
      .limit(1)
      .executeTakeFirst()) ?? null
  )
}

export async function listOwnedActorIds(
  db: KyselyDb,
  params: {
    workspaceId: string
    ownerWorkspaceMemberId: string
  }
): Promise<string[]> {
  const ownerSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    workspaceMemberId: params.ownerWorkspaceMemberId,
  })
  const rows = await db
    .selectFrom("actors as a")
    .innerJoin("workspaceResources as resource", "resource.id", "a.id")
    .select("a.id")
    .where("resource.workspaceId", "=", params.workspaceId)
    .where("resource.deletedAt", "is", null)
    .where("resource.status", "=", "active")
    .where("resource.ownerSubjectId", "=", ownerSubjectId)
    .orderBy("a.createdAt", "desc")
    .execute()
  return rows.map((row) => row.id)
}

export async function listOwnedRemoteAgentIds(
  db: KyselyDb,
  params: {
    workspaceId: string
    ownerWorkspaceMemberId: string
  }
): Promise<string[]> {
  const ownerSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    workspaceMemberId: params.ownerWorkspaceMemberId,
  })
  const rows = await db
    .selectFrom("remoteAgents as agent")
    .innerJoin("workspaceResources as resource", "resource.id", "agent.id")
    .select("agent.id")
    .where("resource.status", "=", "active")
    .where("resource.deletedAt", "is", null)
    .where("resource.workspaceId", "=", params.workspaceId)
    .where("resource.ownerSubjectId", "=", ownerSubjectId)
    .orderBy("agent.createdAt", "desc")
    .execute()
  return rows.map((row) => row.id)
}

export async function listActorModelGroupIds(
  db: KyselyDb,
  params: {
    workspaceId: string
    actorId: string
    limit?: number
  }
): Promise<string[]> {
  const rows = await db
    .selectFrom("modelGroups as mg")
    .distinct()
    .leftJoin("modelGroupGrants as mgg", (join) =>
      join.onRef("mgg.groupId", "=", "mg.id").on("mgg.status", "=", "active")
    )
    .leftJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
    .select("mg.id")
    .where("mg.isEnabled", "=", true)
    .where((eb) =>
      eb.or([
        eb.and([
          eb("mg.ownerType", "=", "workspace"),
          eb("mg.ownerWorkspaceId", "=", params.workspaceId),
        ]),
        eb("mgs.kind", "=", "platform"),
        eb.and([
          eb("mgs.kind", "=", "workspace"),
          eb("mgs.workspaceId", "=", params.workspaceId),
        ]),
        eb.and([
          eb("mgs.kind", "=", "actor"),
          eb("mgs.workspaceId", "=", params.workspaceId),
          eb("mgs.actorId", "=", params.actorId),
        ]),
      ])
    )
    .limit(params.limit && params.limit > 0 ? params.limit : 1000)
    .execute()
  return rows.map((row) => row.id)
}

export async function listWorkspaceMemberModelGroupIds(
  db: KyselyDb,
  params: {
    workspaceId: string
    workspaceMemberId: string
    limit?: number
  }
): Promise<string[]> {
  const rows = await db
    .selectFrom("modelGroups as mg")
    .distinct()
    .leftJoin("modelGroupGrants as mgg", (join) =>
      join.onRef("mgg.groupId", "=", "mg.id").on("mgg.status", "=", "active")
    )
    .leftJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
    .select("mg.id")
    .where("mg.isEnabled", "=", true)
    .where((eb) =>
      eb.or([
        eb.and([
          eb("mg.ownerType", "=", "workspace"),
          eb("mg.ownerWorkspaceId", "=", params.workspaceId),
        ]),
        eb.and([
          eb("mg.ownerType", "=", "workspace_member"),
          eb("mg.ownerWorkspaceMemberId", "=", params.workspaceMemberId),
        ]),
        eb("mgs.kind", "=", "platform"),
        eb.and([
          eb("mgs.kind", "=", "workspace"),
          eb("mgs.workspaceId", "=", params.workspaceId),
        ]),
        eb.and([
          eb("mgs.kind", "=", "workspace_member"),
          eb("mgs.workspaceMemberId", "=", params.workspaceMemberId),
        ]),
      ])
    )
    .limit(params.limit && params.limit > 0 ? params.limit : 1000)
    .execute()
  return rows.map((row) => row.id)
}

export async function loadModelGroupAccessRow(
  db: KyselyDb,
  groupId: string
): Promise<{
  id: string
  ownerType: string
  ownerWorkspaceId: string | null
  ownerWorkspaceMemberId: string | null
  isEnabled: boolean | null
} | null> {
  return (
    (await db
      .selectFrom("modelGroups")
      .select([
        "id",
        "ownerType",
        "ownerWorkspaceId",
        "ownerWorkspaceMemberId",
        "isEnabled",
      ])
      .where("id", "=", groupId)
      .limit(1)
      .executeTakeFirst()) ?? null
  )
}

export async function loadMemorySpaceWithSubjects(
  db: KyselyDb,
  memorySpaceId: string
): Promise<MemorySpaceLoadedRow | null> {
  return (
    (await db
      .selectFrom("memorySpaces as ms")
      .innerJoin(
        "accessSubjects as owner_subj",
        "owner_subj.id",
        "ms.ownerSubjectId"
      )
      .leftJoin(
        "accessSubjects as scope_subj",
        "scope_subj.id",
        "ms.scopeSubjectId"
      )
      .select([
        "ms.id as id",
        "ms.workspaceId as workspaceId",
        "ms.ownerSubjectId as ownerSubjectId",
        "ms.scopeSubjectId as scopeSubjectId",
        "ms.namespaceKey as namespaceKey",
        "owner_subj.kind as ownerKind",
        "owner_subj.workspaceId as ownerWorkspaceId",
        "owner_subj.actorId as ownerActorId",
        "owner_subj.remoteAgentId as ownerRemoteAgentId",
        "owner_subj.workspaceMemberId as ownerWorkspaceMemberId",
        "owner_subj.conversationId as ownerConversationId",
        "scope_subj.kind as scopeKind",
        "scope_subj.conversationId as scopeConversationId",
      ])
      .where("ms.id", "=", memorySpaceId)
      .limit(1)
      .executeTakeFirst()) ?? null
  )
}

export async function loadMemoryItemSpaceRef(
  db: KyselyDb,
  memoryItemId: string
): Promise<{ memoryItemId: string; memorySpaceId: string } | null> {
  return (
    (await db
      .selectFrom("memoryItems as mi")
      .select(["mi.id as memoryItemId", "mi.memorySpaceId as memorySpaceId"])
      .where("mi.id", "=", memoryItemId)
      .limit(1)
      .executeTakeFirst()) ?? null
  )
}
