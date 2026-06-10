import {
  getProviderKindForVendor,
  isKnownModelVendor,
  validateModelProviderConfig,
} from "@synapse/shared"
import { db } from "../../infrastructure/database/kysely.js"
import { MODEL_GROUP_GRANT_SCOPE } from "@synapse/shared/constants"
import type {
  ModelGroupGrantScope,
  ModelGroupOwnerType,
  ModelGroupRoutingStrategy,
} from "@synapse/shared/types"
import { SUBJECT_KIND, type SubjectRef } from "@synapse/shared"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { logProviderStep, logRuntimeEvent } from "../execution/service.js"
import { sql } from "kysely"
import type {
  ModelBindingVersionsFeatures,
  ModelBindingVersionsProviderOptions,
  ModelGroupsAttemptPolicy,
} from "./repo.types.js"
import {
  asObject,
  dbRowToGrantRow,
  presentGrantRow,
  presentGroupItem,
  presentGroupRow,
  type ModelGroupGrantDbRow,
  type ModelGroupItemRow,
  type ModelGroupRow,
} from "./presenter.js"

type JsonMap = Record<string, unknown>

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

export class ModelGroupError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message)
  }
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

async function clearExistingDefault(
  ownerType: ModelGroupOwnerType,
  ownerWorkspaceId?: string | null,
  ownerWorkspaceMemberId?: string | null
) {
  if (ownerType === "platform") {
    await db
      .updateTable("modelGroups")
      .set({
        isDefault: false,
      })
      .where("ownerType", "=", "platform")
      .where("isDefault", "=", true)
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
      .updateTable("modelGroups")
      .set({
        isDefault: false,
      })
      .where("ownerType", "=", "workspace")
      .where("ownerWorkspaceId", "=", ownerWorkspaceId)
      .where("isDefault", "=", true)
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
    .updateTable("modelGroups")
    .set({
      isDefault: false,
    })
    .where("ownerType", "=", "workspace_member")
    .where("ownerWorkspaceMemberId", "=", ownerWorkspaceMemberId)
    .where("isDefault", "=", true)
    .execute()
}

async function getGroupRow(groupId: string) {
  const row = (await db
    .selectFrom("modelGroups")
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
    .insertInto("modelBindingVersions")
    .values({
      bindingId: input.bindingId,
      version: input.version,
      providerKind: input.providerKind,
      vendor: input.vendor,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      modelName: input.modelName,
      maxOutputTokens: effectiveMaxTokens,
      capabilityTags: input.capabilityTags || [],
      features: (input.features || {}) as ModelBindingVersionsFeatures,
      providerOptions: (input.providerOptions ||
        {}) as ModelBindingVersionsProviderOptions,
      requestTimeoutMs: input.requestTimeoutMs ?? null,
      maxRetries: input.maxRetries ?? null,
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
    .insertInto("modelGroupGrants")
    .values({
      groupId: groupId,
      subjectId: subjectId,
      status: "active",
      grantedByWorkspaceMemberId: grantedByWorkspaceMemberId || null,
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
    .selectFrom("workspaceMembers")
    .select(["id", "workspaceId"])
    .where("id", "=", workspaceMemberId)
    .limit(1)
    .executeTakeFirst()
  if (!row || (workspaceId && row.workspaceId !== workspaceId)) {
    throw new ModelGroupError(
      400,
      "Workspace member is not valid for the target workspace"
    )
  }
}

async function ensureActorInWorkspace(actorId: string, workspaceId: string) {
  const row = await db
    .selectFrom("actors as actor")
    .innerJoin("workspaceApps as app", "app.id", "actor.id")
    .select("actor.id")
    .where("actor.id", "=", actorId)
    .where("app.workspaceId", "=", workspaceId)
    .where("app.deletedAt", "is", null)
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
    .selectFrom("modelGroupGrants")
    .select("groupId")
    .where("groupId", "=", groupId)
    .where("status", "=", "active")
    .where("subjectId", "=", subjectId)
    .limit(1)
    .executeTakeFirst()
  if (row) {
    throw new ModelGroupError(409, "An identical active grant already exists")
  }
}

export async function listPlatformModelGroups() {
  const result = await db
    .selectFrom("modelGroups")
    .selectAll()
    .where("ownerType", "=", "platform")
    .where("isEnabled", "=", true)
    .orderBy("isDefault", "desc")
    .orderBy("name")
    .execute()
  return result.map((row) => presentGroupRow(row as ModelGroupRow))
}

/**
 * List ALL platform model groups for the declarative importer — including
 * DISABLED (soft-deleted) ones. The importer uses this to build its name→group
 * dedupe table so it never recreates (or revives) a group an operator removed
 * in the UI.
 *
 * Deliberately does NOT reuse presentGroupRow: that mapper renames `is_enabled` to
 * `is_active`, which would make the importer's enabled-check read undefined.
 * Returns the raw columns the importer actually needs.
 */
export async function listPlatformModelGroupsForImport(): Promise<
  Array<{ id: string; name: string; is_default: boolean; is_enabled: boolean }>
> {
  const rows = await db
    .selectFrom("modelGroups")
    .select(["id", "name", "isDefault", "isEnabled"])
    .where("ownerType", "=", "platform")
    .where("deletedAt", "is", null)
    .execute()
  return rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    is_default: Boolean(row.isDefault),
    is_enabled: Boolean(row.isEnabled),
  }))
}

export async function listWorkspaceModelGroups(workspaceId: string) {
  const result = await db
    .selectFrom("modelGroups as mg")
    .distinct()
    .leftJoin("modelGroupGrants as mgg", (join) =>
      join.onRef("mgg.groupId", "=", "mg.id").on("mgg.status", "=", "active")
    )
    .leftJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
    .selectAll("mg")
    .select(
      sql<number>`CASE mg.owner_type
        WHEN 'workspace' THEN 0
        WHEN 'platform' THEN 1
        ELSE 2
      END`.as("owner_rank")
    )
    .where("mg.isEnabled", "=", true)
    .where((eb) =>
      eb.or([
        eb.and([
          eb("mg.ownerType", "=", "workspace"),
          eb("mg.ownerWorkspaceId", "=", workspaceId),
        ]),
        eb("mgs.kind", "=", "platform"),
        eb.and([
          eb("mgs.kind", "=", "workspace"),
          eb("mgs.workspaceId", "=", workspaceId),
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
          eb("mgs.workspaceId", "=", workspaceId),
        ]),
      ])
    )
    .orderBy("owner_rank")
    .orderBy("mg.isDefault", "desc")
    .orderBy("mg.name")
    .execute()
  return result.map((row) => presentGroupRow(row as ModelGroupRow))
}

export async function listWorkspaceMemberOwnedModelGroups(
  workspaceMemberId: string
) {
  const result = await db
    .selectFrom("modelGroups")
    .selectAll()
    .where("ownerType", "=", "workspace_member")
    .where("ownerWorkspaceMemberId", "=", workspaceMemberId)
    .where("isEnabled", "=", true)
    .orderBy("isDefault", "desc")
    .orderBy("name")
    .execute()
  return result.map((row) => presentGroupRow(row as ModelGroupRow))
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
      .selectFrom("modelBindingsLive as mb")
      .leftJoin("modelBindingVersions as v", "v.id", "mb.currentVersionId")
      .select([
        "mb.id as itemId",
        "mb.groupId",
        "mb.priority",
        "mb.weight",
        "mb.isEnabled as itemEnabled",
        "mb.createdAt",
        "mb.updatedAt",
        "mb.id as bindingId",
        "mb.displayName",
        "mb.currentVersionId",
        "v.version",
        "v.providerKind",
        "v.vendor",
        "v.baseUrl",
        "v.modelName",
        "v.maxOutputTokens",
        "v.capabilityTags",
        "v.features",
        "v.providerOptions",
        "v.requestTimeoutMs",
        "v.maxRetries",
      ])
      .where("mb.groupId", "=", groupId)
      .where("mb.deletedAt", "is", null)
      .orderBy("mb.priority", "asc")
      .orderBy("mb.displayName")
      .execute(),
    db
      .selectFrom("modelGroupGrants as mgg")
      .leftJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
      .select([
        "mgg.id",
        "mgg.groupId",
        "mgg.status",
        "mgg.reason",
        "mgg.createdAt",
        "mgg.revokedAt",
        "mgg.subjectId",
        "mgg.grantedByWorkspaceMemberId",
        "mgs.kind as mgsKind",
        "mgs.workspaceId as mgsWorkspaceId",
        "mgs.workspaceMemberId as mgsWorkspaceMemberId",
        "mgs.actorId as mgsActorId",
      ])
      .where("mgg.groupId", "=", groupId)
      .orderBy("mgg.createdAt", "desc")
      .execute(),
  ])

  return {
    ...presentGroupRow(group),
    items: itemsResult.map(presentGroupItem),
    grants: (grantsResult as ModelGroupGrantDbRow[])
      .map(dbRowToGrantRow)
      .map(presentGrantRow),
  }
}

export async function isModelGroupAvailableInWorkspace(
  groupId: string,
  workspaceId: string
) {
  const row = await db
    .selectFrom("modelGroups as mg")
    .leftJoin("modelGroupGrants as mgg", (join) =>
      join.onRef("mgg.groupId", "=", "mg.id").on("mgg.status", "=", "active")
    )
    .leftJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
    .select("mg.id")
    .where("mg.id", "=", groupId)
    .where("mg.isEnabled", "=", true)
    .where((eb) =>
      eb.or([
        eb.and([
          eb("mg.ownerType", "=", "workspace"),
          eb("mg.ownerWorkspaceId", "=", workspaceId),
        ]),
        eb("mgs.kind", "=", "platform"),
        eb.and([
          eb("mgs.kind", "=", "workspace"),
          eb("mgs.workspaceId", "=", workspaceId),
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
          eb("mgs.workspaceId", "=", workspaceId),
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
  routingStrategy?: ModelGroupRoutingStrategy
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
    .insertInto("modelGroups")
    .values({
      ownerType: ownerType,
      ownerWorkspaceId:
        ownerType === "workspace" ? data.workspaceId || null : null,
      ownerWorkspaceMemberId:
        ownerType === "workspace_member"
          ? data.ownerWorkspaceMemberId || null
          : null,
      name: data.name,
      description: data.description || "",
      routingStrategy: data.routingStrategy || "priority_failover",
      attemptPolicy: (data.attemptPolicy || {}) as ModelGroupsAttemptPolicy,
      isDefault: data.isDefault || false,
      isEnabled: true,
      createdByWorkspaceMemberId: data.createdByWorkspaceMemberId || null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()) as ModelGroupRow
  await createDefaultGroupGrant(
    row.id,
    row.ownerType,
    row.ownerWorkspaceId,
    row.ownerWorkspaceMemberId,
    data.createdByWorkspaceMemberId || null
  )

  return presentGroupRow(row)
}

export async function updateModelGroup(
  groupId: string,
  data: {
    name?: string
    description?: string
    routingStrategy?: ModelGroupRoutingStrategy
    attemptPolicy?: JsonMap
    isDefault?: boolean
    isActive?: boolean
  }
) {
  const group = await getGroupRow(groupId)

  if (data.isDefault === true && data.isActive !== false) {
    await clearExistingDefault(
      group.ownerType,
      group.ownerWorkspaceId,
      group.ownerWorkspaceMemberId
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
    updateData.routingStrategy = data.routingStrategy
  }
  if (data.attemptPolicy !== undefined) {
    updateData.attemptPolicy = data.attemptPolicy as ModelGroupsAttemptPolicy
  }
  if (data.isDefault !== undefined) {
    updateData.isDefault = data.isDefault
  }
  if (data.isActive !== undefined) {
    updateData.isEnabled = data.isActive
  }
  if (data.isActive === false) {
    updateData.isDefault = false
  }

  if (Object.keys(updateData).length === 1) {
    return getModelGroup(groupId)
  }

  const updatedRow = (await db
    .updateTable("modelGroups")
    .set(updateData as any)
    .where("id", "=", groupId)
    .returningAll()
    .executeTakeFirst()) as ModelGroupRow | undefined
  if (!updatedRow) {
    throw new ModelGroupError(404, "Model group not found")
  }

  return presentGroupRow(updatedRow)
}

export async function deleteModelGroup(groupId: string) {
  await db
    .updateTable("modelGroups")
    .set({
      isEnabled: false,
      isDefault: false,
      deletedAt: sql`NOW()`,
    })
    .where("id", "=", groupId)
    .execute()
  await db
    .updateTable("modelBindings")
    .set({
      isEnabled: false,
      deletedAt: sql`NOW()`,
    })
    .where("groupId", "=", groupId)
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
    .insertInto("modelBindings")
    .values({
      groupId: groupId,
      displayName: data.displayName,
      priority: data.priority ?? 0,
      weight: data.weight ?? 100,
      isEnabled: true,
      installedByWorkspaceMemberId:
        data.installedByWorkspaceMemberId ||
        group.createdByWorkspaceMemberId ||
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
    .updateTable("modelBindings")
    .set({
      currentVersionId: version.id,
    })
    .where("id", "=", binding.id)
    .execute()

  return presentGroupItem({
    itemId: binding.id,
    groupId: groupId,
    bindingId: binding.id,
    displayName: binding.displayName,
    priority: binding.priority,
    weight: binding.weight,
    itemEnabled: binding.isEnabled,
    currentVersionId: version.id,
    version: version.version,
    providerKind: version.providerKind,
    vendor: version.vendor,
    baseUrl: version.baseUrl,
    modelName: version.modelName,
    maxOutputTokens: version.maxOutputTokens,
    capabilityTags: version.capabilityTags,
    features: version.features,
    providerOptions: version.providerOptions,
    requestTimeoutMs: version.requestTimeoutMs,
    maxRetries: version.maxRetries,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
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
    .selectFrom("modelBindingsLive as mb")
    .leftJoin("modelBindingVersions as v", "v.id", "mb.currentVersionId")
    .select([
      "mb.id as itemId",
      "mb.groupId",
      "mb.priority",
      "mb.weight",
      "mb.isEnabled as itemEnabled",
      "mb.displayName",
      "mb.currentVersionId",
      "v.version",
      "v.providerKind",
      "v.vendor",
      "v.apiKey",
      "v.baseUrl",
      "v.modelName",
      "v.maxOutputTokens",
      "v.capabilityTags",
      "v.features",
      "v.providerOptions",
      "v.requestTimeoutMs",
      "v.maxRetries",
    ])
    .where("mb.id", "=", itemId)
    .where("mb.groupId", "=", groupId)
    .where("mb.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()
  if (!item) {
    throw new ModelGroupError(404, "Model group item not found")
  }

  const bindingUpdate: Record<string, unknown> = {}
  if (data.priority !== undefined) bindingUpdate.priority = data.priority
  if (data.weight !== undefined) bindingUpdate.weight = data.weight
  if (data.isEnabled !== undefined) bindingUpdate.isEnabled = data.isEnabled
  if (data.displayName !== undefined) {
    bindingUpdate.displayName = data.displayName
  }

  if (Object.keys(bindingUpdate).length > 0) {
    await db
      .updateTable("modelBindings")
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
      (item.providerKind as string) ||
      getProviderKindForVendor(vendor)
    const nextVersion = Number(item.version || 0) + 1
    const version = await createBindingVersion({
      bindingId: itemId,
      version: nextVersion,
      providerKind,
      vendor,
      apiKey: data.apiKey || (item.apiKey as string),
      baseUrl: data.baseUrl || (item.baseUrl as string),
      modelName: data.modelName || (item.modelName as string),
      maxOutputTokens:
        data.maxOutputTokens ??
        (item.maxOutputTokens as number | null) ??
        undefined,
      capabilityTags:
        data.capabilityTags || (item.capabilityTags as string[] | null) || [],
      features: data.features ?? asObject(item.features),
      providerOptions: data.providerOptions ?? asObject(item.providerOptions),
      requestTimeoutMs:
        data.requestTimeoutMs ??
        (item.requestTimeoutMs as number | null) ??
        undefined,
      maxRetries:
        data.maxRetries ?? (item.maxRetries as number | null) ?? undefined,
    })
    await db
      .updateTable("modelBindings")
      .set({
        currentVersionId: version.id,
      })
      .where("id", "=", itemId)
      .execute()
  }

  const updated = await db
    .selectFrom("modelBindingsLive as mb")
    .leftJoin("modelBindingVersions as v", "v.id", "mb.currentVersionId")
    .select([
      "mb.id as itemId",
      "mb.groupId",
      "mb.priority",
      "mb.weight",
      "mb.isEnabled as itemEnabled",
      "mb.createdAt",
      "mb.updatedAt",
      "mb.id as bindingId",
      "mb.displayName",
      "mb.currentVersionId",
      "v.version",
      "v.providerKind",
      "v.vendor",
      "v.baseUrl",
      "v.modelName",
      "v.maxOutputTokens",
      "v.capabilityTags",
      "v.features",
      "v.providerOptions",
      "v.requestTimeoutMs",
      "v.maxRetries",
    ])
    .where("mb.id", "=", itemId)
    .limit(1)
    .executeTakeFirstOrThrow()

  return presentGroupItem(updated)
}

export async function deleteModelItem(groupId: string, itemId: string) {
  const item = await db
    .selectFrom("modelBindingsLive as mb")
    .select(["mb.id", "mb.isEnabled as itemEnabled"])
    .where("mb.id", "=", itemId)
    .where("mb.groupId", "=", groupId)
    .where("mb.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()
  if (!item) {
    throw new ModelGroupError(404, "Model group item not found")
  }
  // Soft-delete the binding (provider_steps.model_binding_version_id is RESTRICT,
  // so versions are never hard-deleted; the audit chain survives).
  await db
    .updateTable("modelBindings")
    .set({
      isEnabled: false,
      deletedAt: sql`NOW()`,
    })
    .where("id", "=", itemId)
    .where("groupId", "=", groupId)
    .execute()
}

async function ensureAssignableModelGroups(
  workspaceId: string,
  groupIds: string[],
  actorId?: string
) {
  if (groupIds.length === 0) return

  const result = await db
    .selectFrom("modelGroups as mg")
    .distinct()
    .leftJoin("modelGroupGrants as mgg", (join) =>
      join.onRef("mgg.groupId", "=", "mg.id").on("mgg.status", "=", "active")
    )
    .leftJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
    .select("mg.id")
    .where("mg.id", "in", groupIds)
    .where("mg.isEnabled", "=", true)
    .where((eb) =>
      eb.or([
        eb.and([
          eb("mg.ownerType", "=", "workspace"),
          eb("mg.ownerWorkspaceId", "=", workspaceId),
        ]),
        eb("mgs.kind", "=", "platform"),
        eb.and([
          eb("mgs.kind", "=", "workspace"),
          eb("mgs.workspaceId", "=", workspaceId),
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
          eb("mgs.workspaceId", "=", workspaceId),
          actorId ? eb("mgs.actorId", "=", actorId) : sql<boolean>`TRUE`,
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
    .selectFrom("modelBindingsLive")
    .select("id")
    .where("id", "=", itemId)
    .where("deletedAt", "is", null)
  if (groupId) {
    bindingLookup = bindingLookup.where("groupId", "=", groupId)
  }
  const bindingRow = await bindingLookup.limit(1).executeTakeFirst()
  if (!bindingRow) {
    throw new ModelGroupError(404, "Model group item not found")
  }

  return db
    .selectFrom("modelBindingVersions as v")
    .select([
      "v.id",
      "v.bindingId",
      "v.version",
      "v.providerKind",
      "v.vendor",
      "v.baseUrl",
      "v.modelName",
      "v.maxOutputTokens",
      "v.capabilityTags",
      "v.features",
      "v.providerOptions",
      "v.requestTimeoutMs",
      "v.maxRetries",
      "v.createdAt",
    ])
    .where("v.bindingId", "=", itemId)
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
    .selectFrom("actorModelGroupAssignments as amga")
    .innerJoin("modelGroups as mg", "mg.id", "amga.groupId")
    .select([
      "amga.actorId",
      "amga.groupId",
      "amga.priority",
      "amga.createdAt",
      "mg.name as groupName",
      "mg.routingStrategy",
      "mg.isDefault",
      "mg.ownerWorkspaceId as workspaceId",
      "mg.ownerType",
      "mg.ownerWorkspaceMemberId",
    ])
    .where("amga.actorId", "=", actorId)
    .where("mg.isEnabled", "=", true)

  if (workspaceId) {
    statement = statement.where((eb) =>
      eb.or([
        eb.and([
          eb("mg.ownerType", "=", "workspace"),
          eb("mg.ownerWorkspaceId", "=", workspaceId),
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
      .insertInto("actorModelGroupAssignments")
      .values({
        actorId: actorId,
        groupId: group.groupId,
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
    .selectFrom("modelGroups as mg")
    .distinct()
    .leftJoin("modelGroupGrants as mgg", (join) =>
      join.onRef("mgg.groupId", "=", "mg.id").on("mgg.status", "=", "active")
    )
    .leftJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
    .selectAll("mg")
    .select(
      sql<number>`CASE mg.owner_type
        WHEN 'workspace' THEN 0
        WHEN 'platform' THEN 1
        ELSE 2
      END`.as("owner_rank")
    )
    .where("mg.isEnabled", "=", true)
    .where((eb) =>
      eb.or([
        eb.and([
          eb("mg.ownerType", "=", "workspace"),
          eb("mg.ownerWorkspaceId", "=", workspaceId),
        ]),
        eb("mgs.kind", "=", "platform"),
        eb.and([
          eb("mgs.kind", "=", "workspace"),
          eb("mgs.workspaceId", "=", workspaceId),
        ]),
        eb.and([
          eb("mgs.kind", "=", "actor"),
          eb("mgs.workspaceId", "=", workspaceId),
          eb("mgs.actorId", "=", actorId),
        ]),
      ])
    )
    .orderBy("owner_rank")
    .orderBy("mg.isDefault", "desc")
    .orderBy("mg.name")
    .execute()

  return result.map((row) => presentGroupRow(row as ModelGroupRow))
}

export async function listModelGroupGrants(groupId: string) {
  await getGroupRow(groupId)
  const result = await db
    .selectFrom("modelGroupGrants as mgg")
    .leftJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
    .select([
      "mgg.id",
      "mgg.groupId",
      "mgg.status",
      "mgg.reason",
      "mgg.createdAt",
      "mgg.revokedAt",
      "mgg.subjectId",
      "mgg.grantedByWorkspaceMemberId",
      "mgs.kind as mgsKind",
      "mgs.workspaceId as mgsWorkspaceId",
      "mgs.workspaceMemberId as mgsWorkspaceMemberId",
      "mgs.actorId as mgsActorId",
    ])
    .where("mgg.groupId", "=", groupId)
    .orderBy("mgg.createdAt", "desc")
    .execute()
  return (result as ModelGroupGrantDbRow[])
    .map(dbRowToGrantRow)
    .map(presentGrantRow)
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
    .insertInto("modelGroupGrants")
    .values({
      groupId: groupId,
      subjectId: subjectId,
      status: "active",
      grantedByWorkspaceMemberId: input.grantedByWorkspaceMemberId || null,
      reason: input.reason || null,
    })
    .returning("id")
    .executeTakeFirstOrThrow()

  // Re-fetch with the access_subjects JOIN to populate the derived
  // grant_scope / workspace_id / actor_id / workspace_member_id fields the
  // presentGrantRow output shape exposes.
  const full = await db
    .selectFrom("modelGroupGrants as mgg")
    .leftJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
    .select([
      "mgg.id",
      "mgg.groupId",
      "mgg.status",
      "mgg.reason",
      "mgg.createdAt",
      "mgg.revokedAt",
      "mgg.subjectId",
      "mgg.grantedByWorkspaceMemberId",
      "mgs.kind as mgsKind",
      "mgs.workspaceId as mgsWorkspaceId",
      "mgs.workspaceMemberId as mgsWorkspaceMemberId",
      "mgs.actorId as mgsActorId",
    ])
    .where("mgg.id", "=", inserted.id)
    .executeTakeFirstOrThrow()
  return presentGrantRow(dbRowToGrantRow(full as ModelGroupGrantDbRow))
}

export async function revokeModelGroupGrant(groupId: string, grantId: string) {
  const result = await db
    .updateTable("modelGroupGrants")
    .set({
      status: "revoked",
      revokedAt: sql`NOW()`,
    })
    .where("id", "=", grantId)
    .where("groupId", "=", groupId)
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
      .selectFrom("modelBindingVersions")
      .select(["vendor", "modelName"])
      .where("id", "=", data.bindingVersionId)
      .limit(1)
      .executeTakeFirst()
    if (versionRow) {
      vendor = versionRow.vendor as string
      modelName = versionRow.modelName || modelName
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
