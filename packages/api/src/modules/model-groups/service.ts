import {
  getProviderKindForVendor,
  isKnownModelVendor,
  validateModelProviderConfig,
} from "@synapse/shared"
import type {
  ModelGroupsOwnerType,
  ModelGroupsRoutingStrategy,
} from "../../infrastructure/database/generated/db.js"
import { db, type TableInsert } from "../../infrastructure/database/kysely.js"
import {
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
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
  created_at: Date
  updated_at: Date
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
  created_at?: Date
  revoked_at?: Date | null
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

function assertValidModelVersionInput(input: {
  vendor: string
  modelName: string
  maxOutputTokens?: number
}) {
  if (!isKnownModelVendor(input.vendor)) {
    throw new ModelGroupError(400, `Unknown model vendor "${input.vendor}".`)
  }
  const issues = validateModelProviderConfig({
    vendor: input.vendor,
    modelName: input.modelName,
    maxOutputTokens: input.maxOutputTokens,
  })

  if (issues.length > 0) {
    throw new ModelGroupError(400, issues[0].message)
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
    created_at: serializeInstant(row.created_at),
    updated_at: serializeInstant(row.updated_at),
  }
}

function mapGroupItem(row: any) {
  const features = asObject(row.features)
  const providerKind =
    row.provider_kind || getProviderKindForVendor(row.vendor || "anthropic")

  return {
    id: row.item_id ?? row.id,
    group_id: row.group_id,
    binding_id: row.binding_id ?? row.item_id ?? row.id,
    current_version_id: row.current_version_id || null,
    display_name: row.display_name,
    priority: row.priority,
    weight: row.weight,
    is_enabled: Boolean(row.item_enabled ?? row.is_enabled),
    version: row.version || null,
    provider_kind: providerKind,
    vendor: row.vendor || null,
    base_url: row.base_url || null,
    model_name: row.model_name || null,
    max_output_tokens: row.max_output_tokens || null,
    capability_tags: row.capability_tags || [],
    features,
    provider_options: asObject(row.provider_options),
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
    created_at: serializeOptionalInstant(row.created_at),
    revoked_at: serializeOptionalInstant(row.revoked_at),
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

async function createBindingVersion(input: {
  bindingId: string
  version: number
  providerKind: string
  vendor: string
  apiKey: string
  baseUrl: string
  modelName: string
  maxOutputTokens?: number
  capabilityTags?: string[]
  features?: JsonMap
  providerOptions?: JsonMap
  requestTimeoutMs?: number
  maxRetries?: number
}) {
  assertValidModelVersionInput({
    vendor: input.vendor,
    modelName: input.modelName,
    maxOutputTokens: input.maxOutputTokens,
  })
  const effectiveMaxTokens = input.maxOutputTokens ?? 4096

  return db
    .insertInto("model_binding_versions")
    .values({
      binding_id: input.bindingId,
      version: input.version,
      provider_kind: input.providerKind,
      vendor: input.vendor,
      api_key: input.apiKey,
      base_url: input.baseUrl,
      model_name: input.modelName,
      max_output_tokens: effectiveMaxTokens,
      capability_tags: input.capabilityTags || [],
      features: (input.features ||
        {}) as TableInsert<"model_binding_versions">["features"],
      provider_options: (input.providerOptions ||
        {}) as TableInsert<"model_binding_versions">["provider_options"],
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
    .where("deleted_at", "is", null)
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
      .selectFrom("model_bindings_live as mb")
      .leftJoin("model_binding_versions as v", "v.id", "mb.current_version_id")
      .select([
        "mb.id as item_id",
        "mb.group_id",
        "mb.priority",
        "mb.weight",
        "mb.is_enabled as item_enabled",
        "mb.created_at",
        "mb.updated_at",
        "mb.id as binding_id",
        "mb.display_name",
        "mb.current_version_id",
        "v.version",
        "v.provider_kind",
        "v.vendor",
        "v.base_url",
        "v.model_name",
        "v.max_output_tokens",
        "v.capability_tags",
        "v.features",
        "v.provider_options",
        "v.request_timeout_ms",
        "v.max_retries",
      ])
      .where("mb.group_id", "=", groupId)
      .where("mb.deleted_at", "is", null)
      .orderBy("mb.priority", "asc")
      .orderBy("mb.display_name")
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

  const updateData: Record<string, unknown> = {}

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
      deleted_at: sql`NOW()`,
    })
    .where("id", "=", groupId)
    .execute()
  await db
    .updateTable("model_bindings")
    .set({
      is_enabled: false,
      deleted_at: sql`NOW()`,
    })
    .where("group_id", "=", groupId)
    .execute()
  await sql`SELECT sd_replace_group_actor_assignments(${groupId}::uuid)`.execute(
    db
  )
}

export async function addModelItem(
  groupId: string,
  data: {
    displayName: string
    priority?: number
    weight?: number
    providerKind?: string
    vendor: string
    apiKey: string
    baseUrl: string
    modelName: string
    maxOutputTokens?: number
    capabilityTags?: string[]
    features?: JsonMap
    providerOptions?: JsonMap
    requestTimeoutMs?: number
    maxRetries?: number
    installedByWorkspaceMemberId?: string
  }
) {
  const group = await getGroupRow(groupId)

  const binding = await db
    .insertInto("model_bindings")
    .values({
      group_id: groupId,
      display_name: data.displayName,
      priority: data.priority ?? 0,
      weight: data.weight ?? 100,
      is_enabled: true,
      installed_by_workspace_member_id:
        data.installedByWorkspaceMemberId ||
        group.created_by_workspace_member_id ||
        null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  const version = await createBindingVersion({
    bindingId: binding.id as string,
    version: 1,
    providerKind: data.providerKind || getProviderKindForVendor(data.vendor),
    vendor: data.vendor,
    apiKey: data.apiKey,
    baseUrl: data.baseUrl,
    modelName: data.modelName,
    maxOutputTokens: data.maxOutputTokens,
    capabilityTags: data.capabilityTags,
    features: data.features,
    providerOptions: data.providerOptions,
    requestTimeoutMs: data.requestTimeoutMs,
    maxRetries: data.maxRetries,
  })

  await db
    .updateTable("model_bindings")
    .set({
      current_version_id: version.id,
    })
    .where("id", "=", binding.id)
    .execute()

  return mapGroupItem({
    item_id: binding.id,
    group_id: groupId,
    binding_id: binding.id,
    display_name: binding.display_name,
    priority: binding.priority,
    weight: binding.weight,
    item_enabled: binding.is_enabled,
    current_version_id: version.id,
    version: version.version,
    provider_kind: version.provider_kind,
    vendor: version.vendor,
    base_url: version.base_url,
    model_name: version.model_name,
    max_output_tokens: version.max_output_tokens,
    capability_tags: version.capability_tags,
    features: version.features,
    provider_options: version.provider_options,
    request_timeout_ms: version.request_timeout_ms,
    max_retries: version.max_retries,
    created_at: binding.created_at,
    updated_at: binding.updated_at,
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
    providerKind?: string
    vendor?: string
    apiKey?: string
    baseUrl?: string
    modelName?: string
    maxOutputTokens?: number
    capabilityTags?: string[]
    features?: JsonMap
    providerOptions?: JsonMap
    requestTimeoutMs?: number
    maxRetries?: number
  }
) {
  // itemId IS the binding id (the M:N profile/group join is gone).
  const item = await db
    .selectFrom("model_bindings_live as mb")
    .leftJoin("model_binding_versions as v", "v.id", "mb.current_version_id")
    .select([
      "mb.id as item_id",
      "mb.group_id",
      "mb.priority",
      "mb.weight",
      "mb.is_enabled as item_enabled",
      "mb.display_name",
      "mb.current_version_id",
      "v.version",
      "v.provider_kind",
      "v.vendor",
      "v.api_key",
      "v.base_url",
      "v.model_name",
      "v.max_output_tokens",
      "v.capability_tags",
      "v.features",
      "v.provider_options",
      "v.request_timeout_ms",
      "v.max_retries",
    ])
    .where("mb.id", "=", itemId)
    .where("mb.group_id", "=", groupId)
    .where("mb.deleted_at", "is", null)
    .limit(1)
    .executeTakeFirst()
  if (!item) {
    throw new ModelGroupError(404, "Model group item not found")
  }

  const bindingUpdate: Record<string, unknown> = {}
  if (data.priority !== undefined) bindingUpdate.priority = data.priority
  if (data.weight !== undefined) bindingUpdate.weight = data.weight
  if (data.isEnabled !== undefined) bindingUpdate.is_enabled = data.isEnabled
  if (data.displayName !== undefined) {
    bindingUpdate.display_name = data.displayName
  }

  if (Object.keys(bindingUpdate).length > 0) {
    await db
      .updateTable("model_bindings")
      .set({
        ...(bindingUpdate as any),
      })
      .where("id", "=", itemId)
      .execute()
  }

  const hasConfigChange =
    data.providerKind !== undefined ||
    data.vendor !== undefined ||
    data.apiKey !== undefined ||
    data.baseUrl !== undefined ||
    data.modelName !== undefined ||
    data.maxOutputTokens !== undefined ||
    data.capabilityTags !== undefined ||
    data.features !== undefined ||
    data.providerOptions !== undefined ||
    data.requestTimeoutMs !== undefined ||
    data.maxRetries !== undefined

  if (hasConfigChange) {
    const vendor = data.vendor || (item.vendor as string)
    const providerKind =
      data.providerKind ||
      (item.provider_kind as string) ||
      getProviderKindForVendor(vendor)
    const nextVersion = Number(item.version || 0) + 1
    const version = await createBindingVersion({
      bindingId: itemId,
      version: nextVersion,
      providerKind,
      vendor,
      apiKey: data.apiKey || (item.api_key as string),
      baseUrl: data.baseUrl || (item.base_url as string),
      modelName: data.modelName || (item.model_name as string),
      maxOutputTokens:
        data.maxOutputTokens ??
        (item.max_output_tokens as number | null) ??
        undefined,
      capabilityTags:
        data.capabilityTags || (item.capability_tags as string[] | null) || [],
      features: data.features ?? asObject(item.features),
      providerOptions: data.providerOptions ?? asObject(item.provider_options),
      requestTimeoutMs:
        data.requestTimeoutMs ??
        (item.request_timeout_ms as number | null) ??
        undefined,
      maxRetries:
        data.maxRetries ?? (item.max_retries as number | null) ?? undefined,
    })
    await db
      .updateTable("model_bindings")
      .set({
        current_version_id: version.id,
      })
      .where("id", "=", itemId)
      .execute()
  }

  const updated = await db
    .selectFrom("model_bindings_live as mb")
    .leftJoin("model_binding_versions as v", "v.id", "mb.current_version_id")
    .select([
      "mb.id as item_id",
      "mb.group_id",
      "mb.priority",
      "mb.weight",
      "mb.is_enabled as item_enabled",
      "mb.created_at",
      "mb.updated_at",
      "mb.id as binding_id",
      "mb.display_name",
      "mb.current_version_id",
      "v.version",
      "v.provider_kind",
      "v.vendor",
      "v.base_url",
      "v.model_name",
      "v.max_output_tokens",
      "v.capability_tags",
      "v.features",
      "v.provider_options",
      "v.request_timeout_ms",
      "v.max_retries",
    ])
    .where("mb.id", "=", itemId)
    .limit(1)
    .executeTakeFirstOrThrow()

  return mapGroupItem(updated)
}

export async function deleteModelItem(groupId: string, itemId: string) {
  const item = await db
    .selectFrom("model_bindings_live as mb")
    .select(["mb.id", "mb.is_enabled as item_enabled"])
    .where("mb.id", "=", itemId)
    .where("mb.group_id", "=", groupId)
    .where("mb.deleted_at", "is", null)
    .limit(1)
    .executeTakeFirst()
  if (!item) {
    throw new ModelGroupError(404, "Model group item not found")
  }
  // Soft-delete the binding (provider_steps.model_binding_version_id is RESTRICT,
  // so versions are never hard-deleted; the audit chain survives).
  await db
    .updateTable("model_bindings")
    .set({
      is_enabled: false,
      deleted_at: sql`NOW()`,
    })
    .where("id", "=", itemId)
    .where("group_id", "=", groupId)
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
  // itemId IS the binding id now; verify it exists (and belongs to the group).
  let bindingLookup = db
    .selectFrom("model_bindings_live")
    .select("id")
    .where("id", "=", itemId)
    .where("deleted_at", "is", null)
  if (groupId) {
    bindingLookup = bindingLookup.where("group_id", "=", groupId)
  }
  const bindingRow = await bindingLookup.limit(1).executeTakeFirst()
  if (!bindingRow) {
    throw new ModelGroupError(404, "Model group item not found")
  }

  return db
    .selectFrom("model_binding_versions as v")
    .select([
      "v.id",
      "v.binding_id",
      "v.version",
      "v.provider_kind",
      "v.vendor",
      "v.base_url",
      "v.model_name",
      "v.max_output_tokens",
      "v.capability_tags",
      "v.features",
      "v.provider_options",
      "v.request_timeout_ms",
      "v.max_retries",
      "v.created_at",
    ])
    .where("v.binding_id", "=", itemId)
    .orderBy("v.version", "desc")
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

  await sql`SELECT sd_replace_actor_model_groups(${actorId}::uuid)`.execute(db)
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
  bindingId?: string
  bindingVersionId?: string
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
        modelBindingId: data.bindingId,
        modelBindingVersionId: data.bindingVersionId,
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

  // No env model fallback: vendor/model are sourced from the resolved binding
  // version below. Empty strings are the neutral default when there is no
  // version id (the legacy/no-turn path already returned before this point).
  let vendor = ""
  let modelName = ""
  if (data.bindingVersionId) {
    const versionRow = await db
      .selectFrom("model_binding_versions")
      .select(["vendor", "model_name"])
      .where("id", "=", data.bindingVersionId)
      .limit(1)
      .executeTakeFirst()
    if (versionRow) {
      vendor = versionRow.vendor as string
      modelName = versionRow.model_name || modelName
    }
  }

  await logProviderStep({
    turnId: data.turnId,
    stepIndex: data.round || 1,
    providerType: vendor,
    requestType: data.requestType as "actor_think" | "ai_complete",
    modelGroupId: data.groupId,
    modelBindingId: data.bindingId,
    modelBindingVersionId: data.bindingVersionId,
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
