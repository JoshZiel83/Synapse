import { sql } from "kysely"
import {
  ACCESS_BINDING_STATUS,
  SUBJECT_KIND,
  WORKSPACE_APP_GRANT_PERMISSION,
  WORKSPACE_APP_KIND,
  WORKSPACE_APP_STATUS,
  type WorkspaceAppStatus,
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
  isActive: boolean
}

export type RemoteAgentRow = {
  id: string
  workspaceId: string
  ownerWorkspaceMemberId: string | null
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

export type LegacyBindableResourceType = "automation_event_source"

export type WorkspaceAppBindableResourceType =
  | "installed_skill"
  | "plugin_installation"
  | "device_capability"

type WorkspaceAppGrantResourceType =
  | WorkspaceAppBindableResourceType
  | "actor"
  | "remote_agent"

export type WorkspaceAppAccessRow = {
  id: string | null
  status: WorkspaceAppStatus | null
}

export type WorkspaceAppResourceAccessRow = {
  workspaceId: string
  ownerWorkspaceMemberId: string | null
  status: WorkspaceAppStatus
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

const BINDABLE_WORKSPACE_APP_KIND: Record<
  WorkspaceAppBindableResourceType,
  (typeof WORKSPACE_APP_KIND)[keyof typeof WORKSPACE_APP_KIND]
> = {
  installed_skill: WORKSPACE_APP_KIND.INSTALLED_SKILL,
  plugin_installation: WORKSPACE_APP_KIND.PLUGIN_INSTALLATION,
  device_capability: WORKSPACE_APP_KIND.DEVICE_CAPABILITY,
}

function bindableResourceIdColumn(resourceType: LegacyBindableResourceType) {
  return "automationEventSourceId"
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
    .innerJoin("workspaceApps as app", "app.id", "actor.id")
    .select([
      "actor.id",
      "app.workspaceId",
      "app.ownerWorkspaceMemberId",
      sql<boolean>`app.status = 'active'`.as("isActive"),
    ])
    .where("actor.id", "=", actorId)
    .where("app.deletedAt", "is", null)
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
      app.workspace_id,
      app.owner_workspace_member_id,
      (app.status = 'active') AS is_active,
      agent.is_public_shared
    FROM remote_agents agent
    INNER JOIN workspace_apps_live app
      ON app.id = agent.id
    WHERE agent.id = ${remoteAgentId}
      AND app.deleted_at IS NULL
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
    (row.kind !== "direct" && row.kind !== "group")
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

export async function listResourceGrantRows(
  db: KyselyDb,
  resourceType: LegacyBindableResourceType,
  resourceId: string | null,
  subject: PermissionSubject,
  runtimeScopeSubjectIds?: readonly string[],
  runtimeSubjectIds?: readonly string[]
): Promise<ResourceGrantRow[]> {
  const resourceIdColumn = bindableResourceIdColumn(resourceType)

  let query = db
    .selectFrom("resourceAccessBindings as binding")
    .innerJoin("accessSubjects as subj", "subj.id", "binding.subjectId")
    .select([
      sql<string>`binding.automation_event_source_id::text`.as("resourceId"),
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
    .where("binding.status", "=", "active")

  if (runtimeScopeSubjectIds && runtimeScopeSubjectIds.length > 0) {
    query = query.where((eb) =>
      eb.or([
        eb("binding.scopeSubjectId", "is", null),
        eb("binding.scopeSubjectId", "in", [...runtimeScopeSubjectIds]),
      ])
    )
  } else {
    query = query.where("binding.scopeSubjectId", "is", null)
  }

  if (resourceId) {
    query = query.where(`binding.${resourceIdColumn}` as any, "=", resourceId)
  }

  const extraRuntimeSubjectIds =
    runtimeSubjectIds && runtimeSubjectIds.length > 0
      ? [...runtimeSubjectIds]
      : null

  if (subject.type === "workspace") {
    query = query.where((eb) =>
      eb.or([
        eb.and([
          eb("subj.kind", "=", "workspace"),
          eb("subj.workspaceId", "=", subject.id),
        ]),
        ...(extraRuntimeSubjectIds
          ? [eb("binding.subjectId", "in", extraRuntimeSubjectIds)]
          : []),
      ])
    )
  } else if (subject.type === "actor") {
    query = query.where((eb) =>
      eb.or([
        eb.and([
          eb("subj.kind", "=", "actor"),
          eb("subj.actorId", "=", subject.id),
        ]),
        ...(extraRuntimeSubjectIds
          ? [eb("binding.subjectId", "in", extraRuntimeSubjectIds)]
          : []),
      ])
    )
  } else if (subject.type === "remote_agent") {
    query = query.where((eb) =>
      eb.or([
        eb.and([
          eb("subj.kind", "=", "remote_agent"),
          eb("subj.remoteAgentId", "=", subject.id),
        ]),
        ...(extraRuntimeSubjectIds
          ? [eb("binding.subjectId", "in", extraRuntimeSubjectIds)]
          : []),
      ])
    )
  } else if (subject.type === "workspace_member") {
    const access = await loadWorkspaceMemberAccess(db, subject.id)
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
          eb("subj.workspaceMemberId", "=", subject.id),
        ]),
        ...(extraRuntimeSubjectIds
          ? [eb("binding.subjectId", "in", extraRuntimeSubjectIds)]
          : []),
      ])
    )
  } else {
    return []
  }

  return await query.execute()
}

export async function listWorkspaceAppGrantRows(
  db: KyselyDb,
  params: {
    resourceType: WorkspaceAppGrantResourceType
    resourceId: string | null
    requiredGrantPermission: "use" | "contact_visible" | "manage"
    subject: PermissionSubject
    runtimeScopeSubjectIds?: readonly string[]
    runtimeSubjectIds?: readonly string[]
  }
): Promise<ResourceGrantRow[]> {
  let query = db
    .selectFrom("workspaceAppGrants as app_grant")
    .innerJoin("workspaceApps as app", "app.id", "app_grant.workspaceAppId")
    .innerJoin("accessSubjects as subj", "subj.id", "app_grant.subjectId")
    .select([
      "app_grant.workspaceAppId as resourceId",
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
    .where("app_grant.status", "=", "active")
    .where("app.kind", "=", params.resourceType)
    .where("app.deletedAt", "is", null)
    .where(
      sql<boolean>`${params.requiredGrantPermission}::workspace_app_grant_permission = ANY(app_grant.permissions)`
    )

  query =
    params.requiredGrantPermission === WORKSPACE_APP_GRANT_PERMISSION.MANAGE
      ? query.where("app.status", "!=", WORKSPACE_APP_STATUS.ARCHIVED)
      : query.where("app.status", "=", WORKSPACE_APP_STATUS.ACTIVE)

  const runtimeScopeSubjectIds = params.runtimeScopeSubjectIds ?? []
  if (runtimeScopeSubjectIds.length > 0) {
    query = query.where((eb) =>
      eb.or([
        eb("app_grant.scopeSubjectId", "is", null),
        eb("app_grant.scopeSubjectId", "in", [...runtimeScopeSubjectIds]),
      ])
    )
  } else {
    query = query.where("app_grant.scopeSubjectId", "is", null)
  }

  if (params.resourceId) {
    query = query.where("app_grant.workspaceAppId", "=", params.resourceId)
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
          ? [eb("app_grant.subjectId", "in", extraRuntimeSubjectIds)]
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
          ? [eb("app_grant.subjectId", "in", extraRuntimeSubjectIds)]
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
          ? [eb("app_grant.subjectId", "in", extraRuntimeSubjectIds)]
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
          ? [eb("app_grant.subjectId", "in", extraRuntimeSubjectIds)]
          : []),
      ])
    )
  } else {
    return []
  }

  return await query.execute()
}

export async function listWorkspaceAppAccessRows(
  db: KyselyDb,
  params: {
    workspaceId: string
    resourceType: WorkspaceAppBindableResourceType
  }
): Promise<WorkspaceAppAccessRow[]> {
  return await db
    .selectFrom("workspaceAppsLive as app")
    .select(["app.id", "app.status"])
    .where("app.workspaceId", "=", params.workspaceId)
    .where("app.kind", "=", BINDABLE_WORKSPACE_APP_KIND[params.resourceType])
    .where("app.deletedAt", "is", null)
    .orderBy("app.createdAt", "desc")
    .execute()
}

export async function listOwnedWorkspaceAppAccessRows(
  db: KyselyDb,
  params: {
    workspaceId: string
    resourceType: WorkspaceAppBindableResourceType
    ownerWorkspaceMemberId: string
  }
): Promise<WorkspaceAppAccessRow[]> {
  return await db
    .selectFrom("workspaceAppsLive as app")
    .select(["app.id", "app.status"])
    .where("app.workspaceId", "=", params.workspaceId)
    .where("app.kind", "=", BINDABLE_WORKSPACE_APP_KIND[params.resourceType])
    .where("app.deletedAt", "is", null)
    .where("app.ownerWorkspaceMemberId", "=", params.ownerWorkspaceMemberId)
    .orderBy("app.createdAt", "desc")
    .execute()
}

export async function listWorkspaceAppAccessRowsByIds(
  db: KyselyDb,
  params: {
    ids: readonly string[]
    workspaceId: string
    resourceType: WorkspaceAppBindableResourceType
  }
): Promise<WorkspaceAppAccessRow[]> {
  if (params.ids.length === 0) {
    return []
  }
  return await db
    .selectFrom("workspaceAppsLive as app")
    .select(["app.id", "app.status"])
    .where("app.id", "in", [...params.ids])
    .where("app.workspaceId", "=", params.workspaceId)
    .where("app.kind", "=", BINDABLE_WORKSPACE_APP_KIND[params.resourceType])
    .where("app.deletedAt", "is", null)
    .orderBy("app.createdAt", "desc")
    .execute()
}

export async function loadInstalledSkillAccessRow(
  db: KyselyDb,
  skillId: string
): Promise<WorkspaceAppResourceAccessRow | null> {
  return (
    (await db
      .selectFrom("installedSkills as skill")
      .innerJoin("workspaceApps as app", "app.id", "skill.id")
      .select(["app.workspaceId", "app.ownerWorkspaceMemberId", "app.status"])
      .where("skill.id", "=", skillId)
      .where("app.deletedAt", "is", null)
      .limit(1)
      .executeTakeFirst()) ?? null
  )
}

export async function loadPluginInstallationAccessRow(
  db: KyselyDb,
  installationId: string
): Promise<WorkspaceAppResourceAccessRow | null> {
  return (
    (await db
      .selectFrom("pluginInstallations as installation")
      .innerJoin("workspaceApps as app", "app.id", "installation.id")
      .select(["app.workspaceId", "app.ownerWorkspaceMemberId", "app.status"])
      .where("installation.id", "=", installationId)
      .where("app.deletedAt", "is", null)
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

export async function loadDeviceExposureDeviceId(
  db: KyselyDb,
  exposureId: string
): Promise<string | null> {
  const row = await db
    .selectFrom("deviceExposures as exposure")
    .innerJoin("devices as device", "device.id", "exposure.deviceId")
    .select(["device.id as deviceId"])
    .where("exposure.id", "=", exposureId)
    .limit(1)
    .executeTakeFirst()
  return row?.deviceId ?? null
}

export async function loadDeviceCapabilityAccessRow(
  db: KyselyDb,
  capabilityId: string
): Promise<WorkspaceAppResourceAccessRow | null> {
  return (
    (await db
      .selectFrom("deviceCapabilities as capability")
      .innerJoin("workspaceApps as app", "app.id", "capability.id")
      .innerJoin(
        "deviceExposures as exposure",
        "exposure.id",
        "capability.exposureId"
      )
      .innerJoin("devices as device", "device.id", "exposure.deviceId")
      .select([
        "app.workspaceId",
        "app.status",
        "device.ownerWorkspaceMemberId",
      ])
      .where("capability.id", "=", capabilityId)
      .where("app.deletedAt", "is", null)
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
  const rows = await db
    .selectFrom("actors as a")
    .innerJoin("workspaceApps as app", "app.id", "a.id")
    .select("a.id")
    .where("app.workspaceId", "=", params.workspaceId)
    .where("app.deletedAt", "is", null)
    .where("app.status", "=", "active")
    .where("app.ownerWorkspaceMemberId", "=", params.ownerWorkspaceMemberId)
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
  const rows = await db
    .selectFrom("remoteAgents as agent")
    .innerJoin("workspaceApps as app", "app.id", "agent.id")
    .select("agent.id")
    .where("app.status", "=", "active")
    .where("app.deletedAt", "is", null)
    .where("app.workspaceId", "=", params.workspaceId)
    .where("app.ownerWorkspaceMemberId", "=", params.ownerWorkspaceMemberId)
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
