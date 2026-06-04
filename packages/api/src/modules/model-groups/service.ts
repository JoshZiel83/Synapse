import {
  resolveModelEngineKind,
  validateModelProviderConfig,
} from "@synapse/shared"
import type {
  ModelGroupsOwnerType,
  ModelGroupsRoutingStrategy,
} from "../../infrastructure/database/generated/db.js"
import { db, type TableInsert } from "../../infrastructure/database/kysely.js"
import { MODEL_GROUP_GRANT_SCOPE } from "@synapse/shared/constants"
import type { ModelGroupGrantScope } from "@synapse/shared/types"
import { SUBJECT_KIND, type SubjectRef } from "@synapse/shared"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { logProviderStep, logRuntimeEvent } from "../execution/service.js"
import { sql } from "kysely"

type JsonMap = Record<string, unknown>
type ModelGroupOwnerType = ModelGroupsOwnerType

/**
 * P1b helpers: translate (grantScope, ids) ↔ SubjectRef. The dropped
 * `grant_scope` column is now inferred from `access_subjects.kind`.
 */
function buildModelGroupGrantSubjectRef(input: {
  grantScope: ModelGroupGrantScope
  workspaceId?: string | null
  workspaceMemberId?: string | null
  actorId?: string | null
}): SubjectRef {
  switch (input.grantScope) {
    case MODEL_GROUP_GRANT_SCOPE.PLATFORM:
      return { kind: SUBJECT_KIND.PLATFORM }
    case MODEL_GROUP_GRANT_SCOPE.WORKSPACE:
      if (!input.workspaceId) {
        throw new Error("workspaceId required for workspace grant scope")
      }
      return { kind: SUBJECT_KIND.WORKSPACE, workspaceId: input.workspaceId }
    case MODEL_GROUP_GRANT_SCOPE.WORKSPACE_MEMBER:
      if (!input.workspaceMemberId) {
        throw new Error(
          "workspaceMemberId required for workspace_member grant scope"
        )
      }
      return {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: input.workspaceMemberId,
      }
    case MODEL_GROUP_GRANT_SCOPE.ACTOR:
      if (!input.actorId) {
        throw new Error("actorId required for actor grant scope")
      }
      return { kind: SUBJECT_KIND.ACTOR, actorId: input.actorId }
  }
}

function subjectKindToModelGroupGrantScope(
  kind: SubjectRef["kind"]
): ModelGroupGrantScope {
  switch (kind) {
    case SUBJECT_KIND.PLATFORM:
      return MODEL_GROUP_GRANT_SCOPE.PLATFORM
    case SUBJECT_KIND.WORKSPACE:
      return MODEL_GROUP_GRANT_SCOPE.WORKSPACE
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      return MODEL_GROUP_GRANT_SCOPE.WORKSPACE_MEMBER
    case SUBJECT_KIND.ACTOR:
      return MODEL_GROUP_GRANT_SCOPE.ACTOR
    default:
      throw new Error(
        `Unsupported subject kind for model_group_grants: ${kind}`
      )
  }
}

type ModelGroupRow = {
  id: string
  owner_type: ModelGroupOwnerType
  owner_workspace_id: string | null
  owner_workspace_member_id: string | null
  name: string
  description: string | null
  routing_strategy: ModelGroupsRoutingStrategy
  attempt_policy: Record<string, unknown> | null
  is_default: boolean
  is_enabled: boolean
  created_by_workspace_member_id: string | null
  created_at: string | Date
  updated_at: string | Date
}

type ModelGroupGrantRow = {
  id?: string
  group_id?: string
  // P1b: derived from the joined access_subjects row, not a column.
  grant_scope: ModelGroupGrantScope
  workspace_id: string | null
  workspace_member_id: string | null
  actor_id: string | null
  status: "active" | "revoked"
  granted_by_workspace_member_id?: string | null
  reason?: string | null
  created_at?: string | Date
  revoked_at?: string | Date | null
}

type ModelGroupGrantDbRow = {
  id: string
  group_id: string
  status: "active" | "revoked"
  reason: string | null
  created_at: Date | null
  revoked_at: Date | null
  subject_id: string
  granted_by_workspace_member_id: string | null
  // From joined access_subjects (aliased mgs)
  mgs_kind?: string | null
  mgs_workspace_id?: string | null
  mgs_workspace_member_id?: string | null
  mgs_actor_id?: string | null
}

function dbRowToGrantRow(
  row: ModelGroupGrantDbRow
): ModelGroupGrantRow & { id: string; group_id: string } {
  return {
    id: row.id,
    group_id: row.group_id,
    grant_scope: row.mgs_kind
      ? subjectKindToModelGroupGrantScope(row.mgs_kind as SubjectRef["kind"])
      : MODEL_GROUP_GRANT_SCOPE.PLATFORM,
    workspace_id: row.mgs_workspace_id ?? null,
    workspace_member_id: row.mgs_workspace_member_id ?? null,
    actor_id: row.mgs_actor_id ?? null,
    status: row.status,
    granted_by_workspace_member_id: row.granted_by_workspace_member_id,
    reason: row.reason,
    created_at: row.created_at || undefined,
    revoked_at: row.revoked_at,
  }
}

export class ModelGroupError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message)
  }
}

function asObject(value: unknown): JsonMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as JsonMap
}

function toIsoString(value: string | Date | null | undefined) {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : value
}

function withEngineKind(
  extraConfig: JsonMap | undefined,
  engineKind?: string
): JsonMap | undefined {
  const next = { ...(extraConfig || {}) }
  if (engineKind) {
    next.engine_kind = engineKind
  }
  return Object.keys(next).length > 0 ? next : undefined
}

function assertValidModelRevisionInput(input: {
  providerType: string
  engineKind?: string
  modelName: string
  maxTokens?: number
  extraConfig?: JsonMap
}) {
  const engineKind =
    input.engineKind ||
    resolveModelEngineKind(input.providerType, input.extraConfig)
  const issues = validateModelProviderConfig({
    providerType: input.providerType,
    engineKind,
    modelName: input.modelName,
    maxTokens: input.maxTokens,
  })

  if (issues.length > 0) {
    throw new ModelGroupError(400, issues[0].message)
  }

  return {
    engineKind,
  }
}

function mapGroupRow(row: ModelGroupRow) {
  return {
    id: row.id,
    owner_type: row.owner_type,
    owner_workspace_id: row.owner_workspace_id,
    owner_workspace_member_id: row.owner_workspace_member_id,
    workspace_id: row.owner_workspace_id,
    scope: row.owner_type,
    name: row.name,
    description: row.description || "",
    routing_strategy: row.routing_strategy,
    attempt_policy: asObject(row.attempt_policy),
    is_default: Boolean(row.is_default),
    is_active: Boolean(row.is_enabled),
    createdByWorkspaceMemberId: row.created_by_workspace_member_id || null,
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at),
  }
}

function mapGroupItem(row: any) {
  const extraConfig = asObject(row.extra_config)
  const engineKind = resolveModelEngineKind(
    row.provider_type || "anthropic",
    extraConfig
  )

  return {
    id: row.item_id ?? row.id,
    group_id: row.group_id,
    profile_id: row.profile_id,
    current_revision_id: row.current_revision_id || null,
    display_name: row.display_name,
    priority: row.priority,
    weight: row.weight,
    is_enabled: Boolean(row.item_enabled ?? row.is_enabled),
    version: row.version || null,
    provider_type: row.provider_type || null,
    engine_kind: engineKind,
    base_url: row.base_url || null,
    model_name: row.model_name || null,
    max_tokens: row.max_tokens || null,
    capability_tags: row.capability_tags || [],
    extra_config: extraConfig,
    request_timeout_ms: row.request_timeout_ms ?? null,
    max_retries: row.max_retries ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function mapGrantRow(
  row: ModelGroupGrantRow & { id: string; group_id: string }
) {
  return {
    id: row.id,
    group_id: row.group_id,
    grant_scope: row.grant_scope,
    workspace_id: row.workspace_id,
    workspace_member_id: row.workspace_member_id,
    actor_id: row.actor_id,
    status: row.status,
    grantedByWorkspaceMemberId: row.granted_by_workspace_member_id || null,
    reason: row.reason || null,
    created_at: toIsoString(row.created_at),
    revoked_at: toIsoString(row.revoked_at),
  }
}

async function clearExistingDefault(
  ownerType: ModelGroupOwnerType,
  ownerWorkspaceId?: string | null,
  ownerWorkspaceMemberId?: string | null
) {
  if (ownerType === "platform") {
    await db
      .updateTable("model_groups")
      .set({
        is_default: false,
      })
      .where("owner_type", "=", "platform")
      .where("is_default", "=", true)
      .execute()
    return
  }

  if (ownerType === "workspace") {
    if (!ownerWorkspaceId) {
      throw new ModelGroupError(
        400,
        "ownerWorkspaceId is required for workspace defaults"
      )
    }
    await db
      .updateTable("model_groups")
      .set({
        is_default: false,
      })
      .where("owner_type", "=", "workspace")
      .where("owner_workspace_id", "=", ownerWorkspaceId)
      .where("is_default", "=", true)
      .execute()
    return
  }

  if (!ownerWorkspaceMemberId) {
    throw new ModelGroupError(
      400,
      "ownerWorkspaceMemberId is required for workspace_member defaults"
    )
  }
  await db
    .updateTable("model_groups")
    .set({
      is_default: false,
    })
    .where("owner_type", "=", "workspace_member")
    .where("owner_workspace_member_id", "=", ownerWorkspaceMemberId)
    .where("is_default", "=", true)
    .execute()
}

async function getGroupRow(groupId: string) {
  const row = (await db
    .selectFrom("model_groups")
    .selectAll()
    .where("id", "=", groupId)
    .limit(1)
    .executeTakeFirst()) as ModelGroupRow | undefined
  if (!row) {
    throw new ModelGroupError(404, "Model group not found")
  }
  return row
}

async function createProfileRevision(input: {
  profileId: string
  version: number
  providerType: string
  engineKind?: string
  apiKey: string
  baseUrl: string
  modelName: string
  maxTokens?: number
  capabilityTags?: string[]
  extraConfig?: JsonMap
  requestTimeoutMs?: number
  maxRetries?: number
}) {
  const validated = assertValidModelRevisionInput({
    providerType: input.providerType,
    engineKind: input.engineKind,
    modelName: input.modelName,
    maxTokens: input.maxTokens,
    extraConfig: input.extraConfig,
  })
  const effectiveMaxTokens = input.maxTokens ?? 4096

  return db
    .insertInto("model_profile_revisions")
    .values({
      profile_id: input.profileId,
      version: input.version,
      provider_type: input.providerType,
      api_key: input.apiKey,
      base_url: input.baseUrl,
      model_name: input.modelName,
      max_tokens: effectiveMaxTokens,
      capability_tags: input.capabilityTags || [],
      extra_config: (withEngineKind(input.extraConfig, validated.engineKind) ||
        {}) as TableInsert<"model_profile_revisions">["extra_config"],
      request_timeout_ms: input.requestTimeoutMs ?? null,
      max_retries: input.maxRetries ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

async function createDefaultGroupGrant(
  groupId: string,
  ownerType: ModelGroupOwnerType,
  ownerWorkspaceId?: string | null,
  ownerWorkspaceMemberId?: string | null,
  grantedByWorkspaceMemberId?: string | null
) {
  const subjectRef = buildModelGroupGrantSubjectRef({
    grantScope:
      ownerType === "platform"
        ? MODEL_GROUP_GRANT_SCOPE.PLATFORM
        : ownerType === "workspace"
          ? MODEL_GROUP_GRANT_SCOPE.WORKSPACE
          : MODEL_GROUP_GRANT_SCOPE.WORKSPACE_MEMBER,
    workspaceId: ownerWorkspaceId,
    workspaceMemberId: ownerWorkspaceMemberId,
  })
  const subjectId = await upsertAccessSubject(db, subjectRef)
  return (await db
    .insertInto("model_group_grants")
    .values({
      group_id: groupId,
      subject_id: subjectId,
      status: "active",
      granted_by_workspace_member_id: grantedByWorkspaceMemberId || null,
      reason: "default_group_scope",
    })
    .returningAll()
    .executeTakeFirstOrThrow()) as { id: string }
}

async function ensureWorkspaceExists(workspaceId: string) {
  const row = await db
    .selectFrom("workspaces")
    .select("id")
    .where("id", "=", workspaceId)
    .limit(1)
    .executeTakeFirst()
  if (!row) {
    throw new ModelGroupError(404, "Workspace not found")
  }
}

async function ensureWorkspaceMember(
  workspaceMemberId: string,
  workspaceId?: string
) {
  const row = await db
    .selectFrom("workspace_members")
    .select(["id", "workspace_id"])
    .where("id", "=", workspaceMemberId)
    .limit(1)
    .executeTakeFirst()
  if (!row || (workspaceId && row.workspace_id !== workspaceId)) {
    throw new ModelGroupError(
      400,
      "Workspace member is not valid for the target workspace"
    )
  }
}

async function ensureActorInWorkspace(actorId: string, workspaceId: string) {
  const row = await db
    .selectFrom("actors")
    .select("id")
    .where("id", "=", actorId)
    .where("workspace_id", "=", workspaceId)
    .limit(1)
    .executeTakeFirst()
  if (!row) {
    throw new ModelGroupError(404, "Actor not found")
  }
}

async function validateGrantTarget(input: {
  grantScope: ModelGroupGrantScope
  workspaceId?: string
  workspaceMemberId?: string
  actorId?: string
}) {
  switch (input.grantScope) {
    case "platform":
      return
    case "workspace":
      if (!input.workspaceId) {
        throw new ModelGroupError(
          400,
          "workspaceId is required for workspace grants"
        )
      }
      await ensureWorkspaceExists(input.workspaceId)
      return
    case "workspace_member":
      if (!input.workspaceMemberId) {
        throw new ModelGroupError(
          400,
          "workspaceMemberId is required for workspace_member grants"
        )
      }
      await ensureWorkspaceMember(input.workspaceMemberId, input.workspaceId)
      return
    case "actor":
      if (!input.workspaceId || !input.actorId) {
        throw new ModelGroupError(
          400,
          "workspaceId and actorId are required for actor grants"
        )
      }
      await ensureWorkspaceExists(input.workspaceId)
      await ensureActorInWorkspace(input.actorId, input.workspaceId)
      return
    default:
      return
  }
}

async function ensureNoDuplicateActiveGrant(
  groupId: string,
  input: {
    grantScope: ModelGroupGrantScope
    workspaceId?: string
    workspaceMemberId?: string
    actorId?: string
  }
) {
  // P1b: resolve the SubjectRef the new grant would target, then look up
  // whether any active row already points at the same access_subjects id.
  const subjectRef = buildModelGroupGrantSubjectRef({
    grantScope: input.grantScope,
    workspaceId: input.workspaceId,
    workspaceMemberId: input.workspaceMemberId,
    actorId: input.actorId,
  })
  const subjectId = await upsertAccessSubject(db, subjectRef)
  const row = await db
    .selectFrom("model_group_grants")
    .select("group_id")
    .where("group_id", "=", groupId)
    .where("status", "=", "active")
    .where("subject_id", "=", subjectId)
    .limit(1)
    .executeTakeFirst()
  if (row) {
    throw new ModelGroupError(409, "An identical active grant already exists")
  }
}

export async function listPlatformModelGroups() {
  const result = await db
    .selectFrom("model_groups")
    .selectAll()
    .where("owner_type", "=", "platform")
    .where("is_enabled", "=", true)
    .orderBy("is_default", "desc")
    .orderBy("name")
    .execute()
  return result.map((row) => mapGroupRow(row as ModelGroupRow))
}

/**
 * List ALL platform model groups for the declarative importer — including
 * DISABLED (soft-deleted) ones. The importer uses this to build its name→group
 * dedupe table so it never recreates (or revives) a group an operator removed
 * in the UI.
 *
 * Deliberately does NOT reuse mapGroupRow: that mapper renames `is_enabled` to
 * `is_active`, which would make the importer's enabled-check read undefined.
 * Returns the raw columns the importer actually needs.
 */
export async function listPlatformModelGroupsForImport(): Promise<
  Array<{ id: string; name: string; is_default: boolean; is_enabled: boolean }>
> {
  const rows = await db
    .selectFrom("model_groups")
    .select(["id", "name", "is_default", "is_enabled"])
    .where("owner_type", "=", "platform")
    .execute()
  return rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    is_default: Boolean(row.is_default),
    is_enabled: Boolean(row.is_enabled),
  }))
}

export async function listWorkspaceModelGroups(workspaceId: string) {
  const result = await db
    .selectFrom("model_groups as mg")
    .distinct()
    .leftJoin("model_group_grants as mgg", (join) =>
      join.onRef("mgg.group_id", "=", "mg.id").on("mgg.status", "=", "active")
    )
    .leftJoin("access_subjects as mgs", "mgs.id", "mgg.subject_id")
    .selectAll("mg")
    .select(
      sql<number>`CASE mg.owner_type
        WHEN 'workspace' THEN 0
        WHEN 'platform' THEN 1
        ELSE 2
      END`.as("owner_rank")
    )
    .where("mg.is_enabled", "=", true)
    .where((eb) =>
      eb.or([
        eb.and([
          eb("mg.owner_type", "=", "workspace"),
          eb("mg.owner_workspace_id", "=", workspaceId),
        ]),
        eb("mgs.kind", "=", "platform"),
        eb.and([
          eb("mgs.kind", "=", "workspace"),
          eb("mgs.workspace_id", "=", workspaceId),
        ]),
        eb.and([
          eb("mgs.kind", "=", "workspace_member"),
          sql<boolean>`EXISTS (
            SELECT 1
            FROM workspace_members wm
            WHERE wm.id = mgs.workspace_member_id
              AND wm.workspace_id = ${workspaceId}
          )`,
        ]),
        eb.and([
          eb("mgs.kind", "=", "actor"),
          eb("mgs.workspace_id", "=", workspaceId),
        ]),
      ])
    )
    .orderBy("owner_rank")
    .orderBy("mg.is_default", "desc")
    .orderBy("mg.name")
    .execute()
  return result.map((row) => mapGroupRow(row as ModelGroupRow))
}

export async function listWorkspaceMemberOwnedModelGroups(
  workspaceMemberId: string
) {
  const result = await db
    .selectFrom("model_groups")
    .selectAll()
    .where("owner_type", "=", "workspace_member")
    .where("owner_workspace_member_id", "=", workspaceMemberId)
    .where("is_enabled", "=", true)
    .orderBy("is_default", "desc")
    .orderBy("name")
    .execute()
  return result.map((row) => mapGroupRow(row as ModelGroupRow))
}

export async function listModelGroups(workspaceId: string | null) {
  return workspaceId
    ? listWorkspaceModelGroups(workspaceId)
    : listPlatformModelGroups()
}

export async function getModelGroup(groupId: string) {
  const group = await getGroupRow(groupId)

  const [itemsResult, grantsResult] = await Promise.all([
    db
      .selectFrom("model_group_profiles as mgp")
      .innerJoin("model_profiles as mp", "mp.id", "mgp.profile_id")
      .leftJoin(
        "model_profile_revisions as r",
        "r.id",
        "mp.current_revision_id"
      )
      .select([
        "mgp.id as item_id",
        "mgp.group_id",
        "mgp.priority",
        "mgp.weight",
        "mgp.is_enabled as item_enabled",
        "mgp.created_at",
        "mgp.updated_at",
        "mp.id as profile_id",
        "mp.display_name",
        "mp.current_revision_id",
        "r.version",
        "r.provider_type",
        "r.base_url",
        "r.model_name",
        "r.max_tokens",
        "r.capability_tags",
        "r.extra_config",
        "r.request_timeout_ms",
        "r.max_retries",
      ])
      .where("mgp.group_id", "=", groupId)
      .orderBy("mgp.priority", "asc")
      .orderBy("mp.display_name")
      .execute(),
    db
      .selectFrom("model_group_grants as mgg")
      .leftJoin("access_subjects as mgs", "mgs.id", "mgg.subject_id")
      .select([
        "mgg.id",
        "mgg.group_id",
        "mgg.status",
        "mgg.reason",
        "mgg.created_at",
        "mgg.revoked_at",
        "mgg.subject_id",
        "mgg.granted_by_workspace_member_id",
        "mgs.kind as mgs_kind",
        "mgs.workspace_id as mgs_workspace_id",
        "mgs.workspace_member_id as mgs_workspace_member_id",
        "mgs.actor_id as mgs_actor_id",
      ])
      .where("mgg.group_id", "=", groupId)
      .orderBy("mgg.created_at", "desc")
      .execute(),
  ])

  return {
    ...mapGroupRow(group),
    items: itemsResult.map(mapGroupItem),
    grants: (grantsResult as ModelGroupGrantDbRow[])
      .map(dbRowToGrantRow)
      .map(mapGrantRow),
  }
}

export async function isModelGroupAvailableInWorkspace(
  groupId: string,
  workspaceId: string
) {
  const row = await db
    .selectFrom("model_groups as mg")
    .leftJoin("model_group_grants as mgg", (join) =>
      join.onRef("mgg.group_id", "=", "mg.id").on("mgg.status", "=", "active")
    )
    .leftJoin("access_subjects as mgs", "mgs.id", "mgg.subject_id")
    .select("mg.id")
    .where("mg.id", "=", groupId)
    .where("mg.is_enabled", "=", true)
    .where((eb) =>
      eb.or([
        eb.and([
          eb("mg.owner_type", "=", "workspace"),
          eb("mg.owner_workspace_id", "=", workspaceId),
        ]),
        eb("mgs.kind", "=", "platform"),
        eb.and([
          eb("mgs.kind", "=", "workspace"),
          eb("mgs.workspace_id", "=", workspaceId),
        ]),
        eb.and([
          eb("mgs.kind", "=", "workspace_member"),
          sql<boolean>`EXISTS (
            SELECT 1
            FROM workspace_members wm
            WHERE wm.id = mgs.workspace_member_id
              AND wm.workspace_id = ${workspaceId}
          )`,
        ]),
        eb.and([
          eb("mgs.kind", "=", "actor"),
          eb("mgs.workspace_id", "=", workspaceId),
        ]),
      ])
    )
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

export async function createModelGroup(data: {
  ownerType?: ModelGroupOwnerType
  workspaceId?: string
  ownerWorkspaceMemberId?: string
  name: string
  description?: string
  routingStrategy?: ModelGroupsRoutingStrategy
  attemptPolicy?: JsonMap
  isDefault?: boolean
  createdByWorkspaceMemberId?: string
}) {
  const ownerType =
    data.ownerType ||
    (data.workspaceId
      ? "workspace"
      : data.ownerWorkspaceMemberId
        ? "workspace_member"
        : "platform")

  if (ownerType === "workspace" && !data.workspaceId) {
    throw new ModelGroupError(
      400,
      "workspaceId is required for workspace-owned groups"
    )
  }
  if (ownerType === "workspace_member" && !data.ownerWorkspaceMemberId) {
    throw new ModelGroupError(
      400,
      "ownerWorkspaceMemberId is required for workspace_member-owned groups"
    )
  }

  if (data.isDefault) {
    await clearExistingDefault(
      ownerType,
      data.workspaceId || null,
      data.ownerWorkspaceMemberId || null
    )
  }

  const row = (await db
    .insertInto("model_groups")
    .values({
      owner_type: ownerType,
      owner_workspace_id:
        ownerType === "workspace" ? data.workspaceId || null : null,
      owner_workspace_member_id:
        ownerType === "workspace_member"
          ? data.ownerWorkspaceMemberId || null
          : null,
      name: data.name,
      description: data.description || "",
      routing_strategy: data.routingStrategy || "priority_failover",
      attempt_policy: (data.attemptPolicy ||
        {}) as TableInsert<"model_groups">["attempt_policy"],
      is_default: data.isDefault || false,
      is_enabled: true,
      created_by_workspace_member_id: data.createdByWorkspaceMemberId || null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()) as ModelGroupRow
  await createDefaultGroupGrant(
    row.id,
    row.owner_type,
    row.owner_workspace_id,
    row.owner_workspace_member_id,
    data.createdByWorkspaceMemberId || null
  )

  return mapGroupRow(row)
}

export async function updateModelGroup(
  groupId: string,
  data: {
    name?: string
    description?: string
    routingStrategy?: ModelGroupsRoutingStrategy
    attemptPolicy?: JsonMap
    isDefault?: boolean
    isActive?: boolean
  }
) {
  const group = await getGroupRow(groupId)

  if (data.isDefault === true && data.isActive !== false) {
    await clearExistingDefault(
      group.owner_type,
      group.owner_workspace_id,
      group.owner_workspace_member_id
    )
  }

  const updateData: Record<string, unknown> = {
    updated_at: sql`NOW()`,
  }

  if (data.name !== undefined) {
    updateData.name = data.name
  }
  if (data.description !== undefined) {
    updateData.description = data.description
  }
  if (data.routingStrategy !== undefined) {
    updateData.routing_strategy = data.routingStrategy
  }
  if (data.attemptPolicy !== undefined) {
    updateData.attempt_policy =
      data.attemptPolicy as TableInsert<"model_groups">["attempt_policy"]
  }
  if (data.isDefault !== undefined) {
    updateData.is_default = data.isDefault
  }
  if (data.isActive !== undefined) {
    updateData.is_enabled = data.isActive
  }
  if (data.isActive === false) {
    updateData.is_default = false
  }

  if (Object.keys(updateData).length === 1) {
    return getModelGroup(groupId)
  }

  const updatedRow = (await db
    .updateTable("model_groups")
    .set(updateData as any)
    .where("id", "=", groupId)
    .returningAll()
    .executeTakeFirst()) as ModelGroupRow | undefined
  if (!updatedRow) {
    throw new ModelGroupError(404, "Model group not found")
  }

  return mapGroupRow(updatedRow)
}

export async function deleteModelGroup(groupId: string) {
  await db
    .updateTable("model_groups")
    .set({
      is_enabled: false,
      is_default: false,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", groupId)
    .execute()
  await db
    .updateTable("model_group_profiles")
    .set({
      is_enabled: false,
      updated_at: sql`NOW()`,
    })
    .where("group_id", "=", groupId)
    .execute()
  await db
    .updateTable("model_profiles")
    .set({
      is_enabled: false,
      updated_at: sql`NOW()`,
    })
    .where(
      "id",
      "in",
      db
        .selectFrom("model_group_profiles")
        .select("profile_id")
        .where("group_id", "=", groupId)
    )
    .execute()
  await db
    .deleteFrom("actor_model_group_assignments")
    .where("group_id", "=", groupId)
    .execute()
}

export async function addModelItem(
  groupId: string,
  data: {
    displayName: string
    priority?: number
    weight?: number
    providerType: string
    engineKind?: string
    apiKey: string
    baseUrl: string
    modelName: string
    maxTokens?: number
    capabilityTags?: string[]
    extraConfig?: JsonMap
    requestTimeoutMs?: number
    maxRetries?: number
    installedByWorkspaceMemberId?: string
  }
) {
  const group = await getGroupRow(groupId)

  const profile = await db
    .insertInto("model_profiles")
    .values({
      workspace_id:
        group.owner_type === "workspace" ? group.owner_workspace_id : null,
      display_name: data.displayName,
      is_enabled: true,
      installed_by_workspace_member_id:
        data.installedByWorkspaceMemberId ||
        group.created_by_workspace_member_id ||
        null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  const revision = await createProfileRevision({
    profileId: profile.id as string,
    version: 1,
    providerType: data.providerType,
    engineKind: data.engineKind,
    apiKey: data.apiKey,
    baseUrl: data.baseUrl,
    modelName: data.modelName,
    maxTokens: data.maxTokens,
    capabilityTags: data.capabilityTags,
    extraConfig: data.extraConfig,
    requestTimeoutMs: data.requestTimeoutMs,
    maxRetries: data.maxRetries,
  })

  await db
    .updateTable("model_profiles")
    .set({
      current_revision_id: revision.id,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", profile.id)
    .execute()

  const item = await db
    .insertInto("model_group_profiles")
    .values({
      group_id: groupId,
      profile_id: profile.id,
      priority: data.priority ?? 0,
      weight: data.weight ?? 100,
      is_enabled: true,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return mapGroupItem({
    ...item,
    group_id: groupId,
    profile_id: profile.id,
    display_name: profile.display_name,
    current_revision_id: revision.id,
    version: revision.version,
    provider_type: revision.provider_type,
    base_url: revision.base_url,
    model_name: revision.model_name,
    max_tokens: revision.max_tokens,
    capability_tags: revision.capability_tags,
    extra_config: revision.extra_config,
    request_timeout_ms: revision.request_timeout_ms,
    max_retries: revision.max_retries,
  })
}

export async function updateModelItem(
  groupId: string,
  itemId: string,
  data: {
    displayName?: string
    priority?: number
    weight?: number
    isEnabled?: boolean
    providerType?: string
    engineKind?: string
    apiKey?: string
    baseUrl?: string
    modelName?: string
    maxTokens?: number
    capabilityTags?: string[]
    extraConfig?: JsonMap
    requestTimeoutMs?: number
    maxRetries?: number
  }
) {
  const item = await db
    .selectFrom("model_group_profiles as mgp")
    .innerJoin("model_groups as mg", "mg.id", "mgp.group_id")
    .innerJoin("model_profiles as mp", "mp.id", "mgp.profile_id")
    .leftJoin("model_profile_revisions as r", "r.id", "mp.current_revision_id")
    .select([
      "mgp.id as item_id",
      "mgp.group_id",
      "mgp.priority",
      "mgp.weight",
      "mgp.is_enabled as item_enabled",
      "mp.id as profile_id",
      "mp.workspace_id as profile_workspace_id",
      "mp.display_name",
      "mp.current_revision_id",
      "mp.is_enabled as profile_enabled",
      "mp.installed_by_workspace_member_id",
      "mg.is_enabled as group_enabled",
      "r.version",
      "r.provider_type",
      "r.api_key",
      "r.base_url",
      "r.model_name",
      "r.max_tokens",
      "r.capability_tags",
      "r.extra_config",
      "r.request_timeout_ms",
      "r.max_retries",
    ])
    .where("mgp.id", "=", itemId)
    .where("mgp.group_id", "=", groupId)
    .limit(1)
    .executeTakeFirst()
  if (!item) {
    throw new ModelGroupError(404, "Model group item not found")
  }
  const itemUpdate: Record<string, unknown> = {}
  if (data.priority !== undefined) {
    itemUpdate.priority = data.priority
  }
  if (data.weight !== undefined) {
    itemUpdate.weight = data.weight
  }
  if (data.isEnabled !== undefined) {
    itemUpdate.is_enabled = data.isEnabled
  }

  if (Object.keys(itemUpdate).length > 0) {
    await db
      .updateTable("model_group_profiles")
      .set({
        ...(itemUpdate as any),
        updated_at: sql`NOW()`,
      })
      .where("id", "=", itemId)
      .execute()
  }

  if (data.isEnabled !== undefined) {
    await db
      .updateTable("model_profiles")
      .set({
        is_enabled: data.isEnabled,
        updated_at: sql`NOW()`,
      })
      .where("id", "=", item.profile_id as string)
      .execute()
  }

  if (data.displayName !== undefined) {
    await db
      .updateTable("model_profiles")
      .set({
        display_name: data.displayName,
        updated_at: sql`NOW()`,
      })
      .where("id", "=", item.profile_id as string)
      .execute()
  }

  const hasConfigChange =
    data.providerType !== undefined ||
    data.engineKind !== undefined ||
    data.apiKey !== undefined ||
    data.baseUrl !== undefined ||
    data.modelName !== undefined ||
    data.maxTokens !== undefined ||
    data.capabilityTags !== undefined ||
    data.extraConfig !== undefined ||
    data.requestTimeoutMs !== undefined ||
    data.maxRetries !== undefined

  if (hasConfigChange) {
    const nextVersion = Number(item.version || 0) + 1
    const revision = await createProfileRevision({
      profileId: item.profile_id as string,
      version: nextVersion,
      providerType: data.providerType || (item.provider_type as string),
      engineKind:
        data.engineKind ||
        resolveModelEngineKind(
          data.providerType || (item.provider_type as string),
          data.extraConfig ?? asObject(item.extra_config)
        ),
      apiKey: data.apiKey || (item.api_key as string),
      baseUrl: data.baseUrl || (item.base_url as string),
      modelName: data.modelName || (item.model_name as string),
      maxTokens:
        data.maxTokens ?? (item.max_tokens as number | null) ?? undefined,
      capabilityTags:
        data.capabilityTags || (item.capability_tags as string[] | null) || [],
      extraConfig: data.extraConfig ?? asObject(item.extra_config),
      requestTimeoutMs:
        data.requestTimeoutMs ??
        (item.request_timeout_ms as number | null) ??
        undefined,
      maxRetries:
        data.maxRetries ?? (item.max_retries as number | null) ?? undefined,
    })
    await db
      .updateTable("model_profiles")
      .set({
        current_revision_id: revision.id,
        updated_at: sql`NOW()`,
      })
      .where("id", "=", item.profile_id as string)
      .execute()
  }

  const updated = await db
    .selectFrom("model_group_profiles as mgp")
    .innerJoin("model_groups as mg", "mg.id", "mgp.group_id")
    .innerJoin("model_profiles as mp", "mp.id", "mgp.profile_id")
    .leftJoin("model_profile_revisions as r", "r.id", "mp.current_revision_id")
    .select([
      "mgp.id as item_id",
      "mgp.group_id",
      "mgp.priority",
      "mgp.weight",
      "mgp.is_enabled as item_enabled",
      "mgp.created_at",
      "mgp.updated_at",
      "mp.id as profile_id",
      "mp.display_name",
      "mp.current_revision_id",
      "mp.is_enabled as profile_enabled",
      "mg.is_enabled as group_enabled",
      "r.version",
      "r.provider_type",
      "r.base_url",
      "r.model_name",
      "r.max_tokens",
      "r.capability_tags",
      "r.extra_config",
      "r.request_timeout_ms",
      "r.max_retries",
    ])
    .where("mgp.id", "=", itemId)
    .limit(1)
    .executeTakeFirstOrThrow()

  return mapGroupItem(updated)
}

export async function deleteModelItem(groupId: string, itemId: string) {
  const item = await db
    .selectFrom("model_group_profiles as mgp")
    .innerJoin("model_groups as mg", "mg.id", "mgp.group_id")
    .innerJoin("model_profiles as mp", "mp.id", "mgp.profile_id")
    .select([
      "mgp.profile_id",
      "mgp.is_enabled as item_enabled",
      "mg.is_enabled as group_enabled",
      "mp.is_enabled as profile_enabled",
    ])
    .where("mgp.id", "=", itemId)
    .where("mgp.group_id", "=", groupId)
    .limit(1)
    .executeTakeFirst()
  if (!item) {
    throw new ModelGroupError(404, "Model group item not found")
  }
  await db
    .updateTable("model_group_profiles")
    .set({
      is_enabled: false,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", itemId)
    .where("group_id", "=", groupId)
    .execute()
  await db
    .updateTable("model_profiles")
    .set({
      is_enabled: false,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", item.profile_id as string)
    .execute()
}

async function ensureAssignableModelGroups(
  workspaceId: string,
  groupIds: string[],
  actorId?: string
) {
  if (groupIds.length === 0) return

  const result = await db
    .selectFrom("model_groups as mg")
    .distinct()
    .leftJoin("model_group_grants as mgg", (join) =>
      join.onRef("mgg.group_id", "=", "mg.id").on("mgg.status", "=", "active")
    )
    .leftJoin("access_subjects as mgs", "mgs.id", "mgg.subject_id")
    .select("mg.id")
    .where("mg.id", "in", groupIds)
    .where("mg.is_enabled", "=", true)
    .where((eb) =>
      eb.or([
        eb.and([
          eb("mg.owner_type", "=", "workspace"),
          eb("mg.owner_workspace_id", "=", workspaceId),
        ]),
        eb("mgs.kind", "=", "platform"),
        eb.and([
          eb("mgs.kind", "=", "workspace"),
          eb("mgs.workspace_id", "=", workspaceId),
        ]),
        eb.and([
          eb("mgs.kind", "=", "workspace_member"),
          sql<boolean>`EXISTS (
            SELECT 1
            FROM workspace_members wm
            WHERE wm.id = mgs.workspace_member_id
              AND wm.workspace_id = ${workspaceId}
          )`,
        ]),
        eb.and([
          eb("mgs.kind", "=", "actor"),
          eb("mgs.workspace_id", "=", workspaceId),
          actorId ? eb("mgs.actor_id", "=", actorId) : sql<boolean>`TRUE`,
        ]),
      ])
    )
    .execute()

  if (result.length !== groupIds.length) {
    throw new ModelGroupError(
      400,
      "One or more model groups are invalid for this workspace"
    )
  }
}

export async function getItemVersions(itemId: string, groupId?: string) {
  let itemLookup = db
    .selectFrom("model_group_profiles")
    .select("profile_id")
    .where("id", "=", itemId)
  if (groupId) {
    itemLookup = itemLookup.where("group_id", "=", groupId)
  }
  const itemRow = await itemLookup.limit(1).executeTakeFirst()
  if (!itemRow) {
    throw new ModelGroupError(404, "Model group item not found")
  }
  const profileId = itemRow.profile_id as string

  return db
    .selectFrom("model_profile_revisions as r")
    .select([
      "r.id",
      "r.profile_id",
      "r.version",
      "r.provider_type",
      sql<string | null>`r.extra_config->>'engine_kind'`.as("engine_kind"),
      "r.base_url",
      "r.model_name",
      "r.max_tokens",
      "r.capability_tags",
      "r.extra_config",
      "r.request_timeout_ms",
      "r.max_retries",
      "r.created_at",
    ])
    .where("r.profile_id", "=", profileId)
    .orderBy("r.version", "desc")
    .execute()
}

export async function getActorModelGroups(
  actorId: string,
  workspaceId?: string
) {
  if (workspaceId) {
    await ensureActorInWorkspace(actorId, workspaceId)
  }

  let statement = db
    .selectFrom("actor_model_group_assignments as amga")
    .innerJoin("model_groups as mg", "mg.id", "amga.group_id")
    .select([
      "amga.actor_id",
      "amga.group_id",
      "amga.priority",
      "amga.created_at",
      "mg.name as group_name",
      "mg.routing_strategy",
      "mg.is_default",
      "mg.owner_workspace_id as workspace_id",
      "mg.owner_type",
      "mg.owner_workspace_member_id",
    ])
    .where("amga.actor_id", "=", actorId)
    .where("mg.is_enabled", "=", true)

  if (workspaceId) {
    statement = statement.where((eb) =>
      eb.or([
        eb.and([
          eb("mg.owner_type", "=", "workspace"),
          eb("mg.owner_workspace_id", "=", workspaceId),
        ]),
        sql<boolean>`EXISTS (
          SELECT 1
          FROM model_group_grants mgg
          JOIN access_subjects mgs2 ON mgs2.id = mgg.subject_id
          WHERE mgg.group_id = mg.id
            AND mgg.status = 'active'
            AND (
              mgs2.kind = 'platform'
              OR (mgs2.kind = 'workspace' AND mgs2.workspace_id = ${workspaceId})
              OR (
                mgs2.kind = 'workspace_member'
                AND EXISTS (
                  SELECT 1
                  FROM workspace_members wm
                  WHERE wm.id = mgs2.workspace_member_id
                    AND wm.workspace_id = ${workspaceId}
                )
              )
              OR (mgs2.kind = 'actor' AND mgs2.workspace_id = ${workspaceId})
            )
        )`,
      ])
    )
  }

  return statement.orderBy("amga.priority", "asc").execute()
}

export async function setActorModelGroups(
  actorId: string,
  workspaceId: string,
  groups: { groupId: string; priority: number }[]
) {
  await ensureActorInWorkspace(actorId, workspaceId)
  await ensureAssignableModelGroups(
    workspaceId,
    groups.map((group) => group.groupId),
    actorId
  )

  await db
    .deleteFrom("actor_model_group_assignments")
    .where("actor_id", "=", actorId)
    .execute()
  for (const group of groups) {
    await db
      .insertInto("actor_model_group_assignments")
      .values({
        actor_id: actorId,
        group_id: group.groupId,
        priority: group.priority,
      })
      .execute()
  }
  return getActorModelGroups(actorId, workspaceId)
}

export async function listVisibleActorModelGroups(
  actorId: string,
  workspaceId: string
) {
  await ensureActorInWorkspace(actorId, workspaceId)

  const result = await db
    .selectFrom("model_groups as mg")
    .distinct()
    .leftJoin("model_group_grants as mgg", (join) =>
      join.onRef("mgg.group_id", "=", "mg.id").on("mgg.status", "=", "active")
    )
    .leftJoin("access_subjects as mgs", "mgs.id", "mgg.subject_id")
    .selectAll("mg")
    .select(
      sql<number>`CASE mg.owner_type
        WHEN 'workspace' THEN 0
        WHEN 'platform' THEN 1
        ELSE 2
      END`.as("owner_rank")
    )
    .where("mg.is_enabled", "=", true)
    .where((eb) =>
      eb.or([
        eb.and([
          eb("mg.owner_type", "=", "workspace"),
          eb("mg.owner_workspace_id", "=", workspaceId),
        ]),
        eb("mgs.kind", "=", "platform"),
        eb.and([
          eb("mgs.kind", "=", "workspace"),
          eb("mgs.workspace_id", "=", workspaceId),
        ]),
        eb.and([
          eb("mgs.kind", "=", "actor"),
          eb("mgs.workspace_id", "=", workspaceId),
          eb("mgs.actor_id", "=", actorId),
        ]),
      ])
    )
    .orderBy("owner_rank")
    .orderBy("mg.is_default", "desc")
    .orderBy("mg.name")
    .execute()

  return result.map((row) => mapGroupRow(row as ModelGroupRow))
}

export async function listModelGroupGrants(groupId: string) {
  await getGroupRow(groupId)
  const result = await db
    .selectFrom("model_group_grants as mgg")
    .leftJoin("access_subjects as mgs", "mgs.id", "mgg.subject_id")
    .select([
      "mgg.id",
      "mgg.group_id",
      "mgg.status",
      "mgg.reason",
      "mgg.created_at",
      "mgg.revoked_at",
      "mgg.subject_id",
      "mgg.granted_by_workspace_member_id",
      "mgs.kind as mgs_kind",
      "mgs.workspace_id as mgs_workspace_id",
      "mgs.workspace_member_id as mgs_workspace_member_id",
      "mgs.actor_id as mgs_actor_id",
    ])
    .where("mgg.group_id", "=", groupId)
    .orderBy("mgg.created_at", "desc")
    .execute()
  return (result as ModelGroupGrantDbRow[])
    .map(dbRowToGrantRow)
    .map(mapGrantRow)
}

export async function issueModelGroupGrant(
  groupId: string,
  input: {
    grantScope: ModelGroupGrantScope
    workspaceId?: string
    workspaceMemberId?: string
    actorId?: string
    grantedByWorkspaceMemberId?: string
    reason?: string
  }
) {
  await validateGrantTarget(input)
  await ensureNoDuplicateActiveGrant(groupId, input)

  const subjectRef = buildModelGroupGrantSubjectRef({
    grantScope: input.grantScope,
    workspaceId: input.workspaceId,
    workspaceMemberId: input.workspaceMemberId,
    actorId: input.actorId,
  })
  const subjectId = await upsertAccessSubject(db, subjectRef)
  const inserted = await db
    .insertInto("model_group_grants")
    .values({
      group_id: groupId,
      subject_id: subjectId,
      status: "active",
      granted_by_workspace_member_id: input.grantedByWorkspaceMemberId || null,
      reason: input.reason || null,
    })
    .returning("id")
    .executeTakeFirstOrThrow()

  // Re-fetch with the access_subjects JOIN to populate the derived
  // grant_scope / workspace_id / actor_id / workspace_member_id fields the
  // mapGrantRow output shape exposes.
  const full = await db
    .selectFrom("model_group_grants as mgg")
    .leftJoin("access_subjects as mgs", "mgs.id", "mgg.subject_id")
    .select([
      "mgg.id",
      "mgg.group_id",
      "mgg.status",
      "mgg.reason",
      "mgg.created_at",
      "mgg.revoked_at",
      "mgg.subject_id",
      "mgg.granted_by_workspace_member_id",
      "mgs.kind as mgs_kind",
      "mgs.workspace_id as mgs_workspace_id",
      "mgs.workspace_member_id as mgs_workspace_member_id",
      "mgs.actor_id as mgs_actor_id",
    ])
    .where("mgg.id", "=", inserted.id)
    .executeTakeFirstOrThrow()
  return mapGrantRow(dbRowToGrantRow(full as ModelGroupGrantDbRow))
}

export async function revokeModelGroupGrant(groupId: string, grantId: string) {
  const result = await db
    .updateTable("model_group_grants")
    .set({
      status: "revoked",
      revoked_at: sql`NOW()`,
    })
    .where("id", "=", grantId)
    .where("group_id", "=", groupId)
    .where("status", "=", "active")
    .returning("id")
    .executeTakeFirst()
  if (!result) {
    throw new ModelGroupError(404, "Model group grant not found")
  }
}

export async function logAIRequest(data: {
  workspaceId?: string
  actorId?: string
  sessionId?: string
  turnId?: string
  round?: number
  groupId?: string
  profileId?: string
  profileRevisionId?: string
  requestType: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
  status: string
  errorMessage?: string
  requestBody?: unknown
  responseBody?: unknown
}) {
  if (!data.turnId) {
    await logRuntimeEvent({
      workspaceId: data.workspaceId,
      sessionId: data.sessionId,
      actorId: data.actorId,
      source: "provider",
      level: data.status === "error" ? "error" : "info",
      eventType: "provider.step.legacy",
      payload: {
        round: data.round || 1,
        requestType: data.requestType,
        modelGroupId: data.groupId,
        modelProfileId: data.profileId,
        modelProfileRevisionId: data.profileRevisionId,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        latencyMs: data.latencyMs,
        status: data.status,
        errorMessage: data.errorMessage,
        requestBody: data.requestBody,
        responseBody: data.responseBody,
      },
    })
    return
  }

  // No env model fallback: provider/model are sourced from the resolved
  // revision below. Empty strings are the neutral default when there is no
  // revision id (the legacy/no-turn path already returned before this point).
  let providerType = ""
  let modelName = ""
  if (data.profileRevisionId) {
    const revisionRow = await db
      .selectFrom("model_profile_revisions")
      .select(["provider_type", "model_name"])
      .where("id", "=", data.profileRevisionId)
      .limit(1)
      .executeTakeFirst()
    if (revisionRow) {
      providerType = revisionRow.provider_type as string
      modelName = revisionRow.model_name || modelName
    }
  }

  await logProviderStep({
    turnId: data.turnId,
    stepIndex: data.round || 1,
    providerType,
    requestType: data.requestType as "actor_think" | "ai_complete",
    modelGroupId: data.groupId,
    modelProfileId: data.profileId,
    modelProfileRevisionId: data.profileRevisionId,
    modelName,
    requestPayload: data.requestBody,
    responsePayload: data.responseBody,
    inputTokens: data.inputTokens,
    outputTokens: data.outputTokens,
    latencyMs: data.latencyMs,
    status: data.status as "success" | "error" | "timeout",
    errorMessage: data.errorMessage,
  })
}
