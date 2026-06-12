import {
  getProviderKindForVendor,
  isKnownModelVendor,
  validateModelProviderConfig,
} from "@synapse/shared"
import { MODEL_GROUP_GRANT_SCOPE } from "@synapse/shared/constants"
import type {
  ModelGroupDetailView,
  ModelGroupGrantScope,
  ModelGroupOwnerType,
  ModelGroupRoutingStrategy,
} from "@synapse/shared/types"
import { SUBJECT_KIND, type SubjectRef } from "@synapse/shared"
import { upsertAccessSubjectDefault } from "../access/guards.js"
import { logProviderStep, logRuntimeEvent } from "../execution/service.js"
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
  type ActorModelGroupAssignmentRow,
  type ModelGroupGrantRow,
  type ModelGroupItemRow,
  type ModelGroupItemVersionRow,
  type ModelGroupRow,
} from "./presenter.js"
import * as repo from "./repo.js"

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
  if (ownerType === "workspace" && !ownerWorkspaceId) {
    throw new ModelGroupError(
      400,
      "ownerWorkspaceId is required for workspace defaults"
    )
  }
  if (ownerType === "workspace_member" && !ownerWorkspaceMemberId) {
    throw new ModelGroupError(
      400,
      "ownerWorkspaceMemberId is required for workspace_member defaults"
    )
  }
  await repo.clearDefaultModelGroups(
    ownerType,
    ownerWorkspaceId ?? null,
    ownerWorkspaceMemberId ?? null
  )
}

async function getGroupRow(groupId: string): Promise<ModelGroupRow> {
  const row = await repo.getModelGroupRow(groupId)
  if (!row) {
    throw new ModelGroupError(404, "Model group not found")
  }
  return row
}

async function ensureWorkspaceExists(workspaceId: string) {
  if (!(await repo.workspaceExists(workspaceId))) {
    throw new ModelGroupError(404, "Workspace not found")
  }
}

async function ensureWorkspaceMember(
  workspaceMemberId: string,
  workspaceId?: string
) {
  const row = await repo.getWorkspaceMemberWorkspaceId(workspaceMemberId)
  if (!row || (workspaceId && row.workspaceId !== workspaceId)) {
    throw new ModelGroupError(
      400,
      "Workspace member is not valid for the target workspace"
    )
  }
}

async function ensureActorInWorkspace(actorId: string, workspaceId: string) {
  if (!(await repo.actorExistsInWorkspace(actorId, workspaceId))) {
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
  const subjectId = await upsertAccessSubjectDefault(subjectRef)
  if (await repo.activeGrantExistsForSubject(groupId, subjectId)) {
    throw new ModelGroupError(409, "An identical active grant already exists")
  }
}

export async function listPlatformModelGroups(): Promise<ModelGroupRow[]> {
  return repo.listPlatformModelGroupRows()
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
  const rows = await repo.listPlatformModelGroupImportRows()
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    is_default: Boolean(row.isDefault),
    is_enabled: Boolean(row.isEnabled),
  }))
}

export async function listWorkspaceModelGroups(
  workspaceId: string
): Promise<ModelGroupRow[]> {
  return repo.listWorkspaceModelGroupRows(workspaceId)
}

export async function listWorkspaceMemberOwnedModelGroups(
  workspaceMemberId: string
): Promise<ModelGroupRow[]> {
  return repo.listWorkspaceMemberOwnedModelGroupRows(workspaceMemberId)
}

export async function listModelGroups(
  workspaceId: string | null
): Promise<ModelGroupRow[]> {
  return workspaceId
    ? listWorkspaceModelGroups(workspaceId)
    : listPlatformModelGroups()
}

export async function getModelGroup(
  groupId: string
): Promise<ModelGroupDetailView> {
  const group = await getGroupRow(groupId)

  const { items, grants } = await repo.getModelGroupDetailRows(groupId)

  return {
    ...presentGroupRow(group),
    items: items.map((row) => presentGroupItem(row as ModelGroupItemRow)),
    grants: grants.map(dbRowToGrantRow).map(presentGrantRow),
  }
}

export async function isModelGroupAvailableInWorkspace(
  groupId: string,
  workspaceId: string
) {
  return repo.isModelGroupGrantedInWorkspace(groupId, workspaceId)
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
}): Promise<ModelGroupRow> {
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

  const ownerWorkspaceId =
    ownerType === "workspace" ? data.workspaceId || null : null
  const ownerWorkspaceMemberId =
    ownerType === "workspace_member"
      ? data.ownerWorkspaceMemberId || null
      : null

  const defaultGrantSubjectRef = buildModelGroupGrantSubjectRef({
    grantScope:
      ownerType === "platform"
        ? MODEL_GROUP_GRANT_SCOPE.PLATFORM
        : ownerType === "workspace"
          ? MODEL_GROUP_GRANT_SCOPE.WORKSPACE
          : MODEL_GROUP_GRANT_SCOPE.WORKSPACE_MEMBER,
    workspaceId: ownerWorkspaceId,
    workspaceMemberId: ownerWorkspaceMemberId,
  })

  const row = await repo.insertModelGroupWithDefaultGrant({
    clearDefault: data.isDefault
      ? {
          ownerType,
          ownerWorkspaceId,
          ownerWorkspaceMemberId,
        }
      : null,
    groupValues: {
      ownerType,
      ownerWorkspaceId,
      ownerWorkspaceMemberId,
      name: data.name,
      description: data.description || "",
      routingStrategy: data.routingStrategy || "priority_failover",
      attemptPolicy: (data.attemptPolicy || {}) as ModelGroupsAttemptPolicy,
      isDefault: data.isDefault || false,
      isEnabled: true,
      createdByWorkspaceMemberId: data.createdByWorkspaceMemberId || null,
    },
    defaultGrantSubjectRef,
    grantedByWorkspaceMemberId: data.createdByWorkspaceMemberId || null,
  })

  return row
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
): Promise<ModelGroupDetailView> {
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
    updateData.attemptPolicy = data.attemptPolicy
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

  const updatedRow = await repo.updateModelGroupRow(groupId, updateData)
  if (!updatedRow) {
    throw new ModelGroupError(404, "Model group not found")
  }

  // Always return the full detail view so the PUT route can present a single
  // schema (ModelGroupDetailView) via sendData — callers ignore the body and
  // reload, so returning detail vs. plain view is behavior-neutral.
  return getModelGroup(groupId)
}

export async function deleteModelGroup(groupId: string) {
  await repo.softDeleteModelGroupCascade(groupId)
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
): Promise<ModelGroupItemRow> {
  const group = await getGroupRow(groupId)

  assertValidModelVersionInput({
    vendor: data.vendor,
    modelName: data.modelName,
    maxOutputTokens: data.maxOutputTokens,
  })

  const { binding, version } = await repo.insertModelItemWithVersion({
    groupId,
    binding: {
      displayName: data.displayName,
      priority: data.priority ?? 0,
      weight: data.weight ?? 100,
      isEnabled: true,
      installedByWorkspaceMemberId:
        data.installedByWorkspaceMemberId ||
        group.createdByWorkspaceMemberId ||
        null,
    },
    version: {
      version: 1,
      providerKind: data.providerKind || getProviderKindForVendor(data.vendor),
      vendor: data.vendor,
      apiKey: data.apiKey,
      baseUrl: data.baseUrl,
      modelName: data.modelName,
      maxOutputTokens: data.maxOutputTokens ?? 4096,
      capabilityTags: data.capabilityTags || [],
      features: (data.features || {}) as ModelBindingVersionsFeatures,
      providerOptions: (data.providerOptions ||
        {}) as ModelBindingVersionsProviderOptions,
      requestTimeoutMs: data.requestTimeoutMs ?? null,
      maxRetries: data.maxRetries ?? null,
    },
  })

  return {
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
  }
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
): Promise<ModelGroupItemRow> {
  // itemId IS the binding id (the M:N profile/group join is gone).
  const item = await repo.getModelGroupItemForUpdate(itemId, groupId)
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

  let newVersion: Parameters<
    typeof repo.applyModelItemUpdate
  >[0]["newVersion"] = null

  if (hasConfigChange) {
    const vendor = data.vendor || (item.vendor as string)
    const providerKind =
      data.providerKind ||
      (item.providerKind as string) ||
      getProviderKindForVendor(vendor)
    const nextVersion = Number(item.version || 0) + 1
    const modelName = data.modelName || (item.modelName as string)
    const maxOutputTokens =
      data.maxOutputTokens ??
      (item.maxOutputTokens as number | null) ??
      undefined
    assertValidModelVersionInput({ vendor, modelName, maxOutputTokens })
    newVersion = {
      version: nextVersion,
      providerKind,
      vendor,
      apiKey: data.apiKey || (item.apiKey as string),
      baseUrl: data.baseUrl || (item.baseUrl as string),
      modelName,
      maxOutputTokens: maxOutputTokens ?? 4096,
      capabilityTags:
        data.capabilityTags || (item.capabilityTags as string[] | null) || [],
      features: (data.features ??
        asObject(item.features)) as ModelBindingVersionsFeatures,
      providerOptions: (data.providerOptions ??
        asObject(item.providerOptions)) as ModelBindingVersionsProviderOptions,
      requestTimeoutMs:
        data.requestTimeoutMs ??
        (item.requestTimeoutMs as number | null) ??
        null,
      maxRetries: data.maxRetries ?? (item.maxRetries as number | null) ?? null,
    }
  }

  const updated = await repo.applyModelItemUpdate({
    itemId,
    bindingUpdate: Object.keys(bindingUpdate).length > 0 ? bindingUpdate : null,
    newVersion,
  })

  return updated as ModelGroupItemRow
}

export async function deleteModelItem(groupId: string, itemId: string) {
  if (!(await repo.modelGroupItemExists(itemId, groupId))) {
    throw new ModelGroupError(404, "Model group item not found")
  }
  // Soft-delete the binding (provider_steps.model_binding_version_id is RESTRICT,
  // so versions are never hard-deleted; the audit chain survives).
  await repo.softDeleteBinding(itemId, groupId)
}

export async function getItemVersions(
  itemId: string,
  groupId?: string
): Promise<ModelGroupItemVersionRow[]> {
  // itemId IS the binding id now; verify it exists (and belongs to the group).
  if (!(await repo.bindingExistsForVersions(itemId, groupId))) {
    throw new ModelGroupError(404, "Model group item not found")
  }
  return repo.listBindingVersionRows(itemId)
}

export async function getActorModelGroups(
  actorId: string,
  workspaceId?: string
): Promise<ActorModelGroupAssignmentRow[]> {
  if (workspaceId) {
    await ensureActorInWorkspace(actorId, workspaceId)
  }

  return repo.listActorModelGroupAssignmentRows(actorId, workspaceId)
}

export async function setActorModelGroups(
  actorId: string,
  workspaceId: string,
  groups: { groupId: string; priority: number }[]
): Promise<ActorModelGroupAssignmentRow[]> {
  await ensureActorInWorkspace(actorId, workspaceId)
  await ensureAssignableModelGroups(
    workspaceId,
    groups.map((group) => group.groupId),
    actorId
  )

  await repo.replaceActorModelGroups(actorId, groups)
  return getActorModelGroups(actorId, workspaceId)
}

async function ensureAssignableModelGroups(
  workspaceId: string,
  groupIds: string[],
  actorId?: string
) {
  if (groupIds.length === 0) return

  const matched = await repo.listAssignableModelGroupIds(
    workspaceId,
    groupIds,
    actorId
  )

  if (matched.length !== groupIds.length) {
    throw new ModelGroupError(
      400,
      "One or more model groups are invalid for this workspace"
    )
  }
}

export async function listVisibleActorModelGroups(
  actorId: string,
  workspaceId: string
): Promise<ModelGroupRow[]> {
  await ensureActorInWorkspace(actorId, workspaceId)
  return repo.listVisibleActorModelGroupRows(actorId, workspaceId)
}

export async function listModelGroupGrants(
  groupId: string
): Promise<Array<ModelGroupGrantRow & { id: string; group_id: string }>> {
  await getGroupRow(groupId)
  const result = await repo.listModelGroupGrantDbRows(groupId)
  return result.map(dbRowToGrantRow)
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
): Promise<ModelGroupGrantRow & { id: string; group_id: string }> {
  await validateGrantTarget(input)
  await ensureNoDuplicateActiveGrant(groupId, input)

  const subjectRef = buildModelGroupGrantSubjectRef({
    grantScope: input.grantScope,
    workspaceId: input.workspaceId,
    workspaceMemberId: input.workspaceMemberId,
    actorId: input.actorId,
  })

  const full = await repo.insertModelGroupGrantAndReadBack({
    groupId,
    subjectRef,
    grantedByWorkspaceMemberId: input.grantedByWorkspaceMemberId || null,
    reason: input.reason || null,
  })
  return dbRowToGrantRow(full)
}

export async function revokeModelGroupGrant(groupId: string, grantId: string) {
  const result = await repo.revokeModelGroupGrantRow(groupId, grantId)
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
    const versionRow = await repo.getBindingVersionVendorModel(
      data.bindingVersionId
    )
    if (versionRow) {
      vendor = versionRow.vendor ?? ""
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
