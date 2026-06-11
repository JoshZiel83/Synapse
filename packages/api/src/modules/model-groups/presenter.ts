import {
  getProviderKindForVendor,
  SUBJECT_KIND,
  type SubjectRef,
} from "@synapse/shared"
import { MODEL_GROUP_GRANT_SCOPE } from "@synapse/shared/constants"
import type {
  ActorModelGroupAssignmentView,
  ModelGroupGrantScope,
  ModelGroupGrantView,
  ModelGroupItemVersionView,
  ModelGroupItemView,
  ModelGroupOwnerType,
  ModelGroupRoutingStrategy,
  ModelGroupView,
} from "@synapse/shared/types"
import {
  requireInstantDate,
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"

/**
 * Model-groups presentation layer: DB row → app-facing camelCase view. Owns
 * the outward semantic transforms (Date → IsoInstantString via
 * serializeInstant) so the service/controller never call serializeInstant
 * (guard-layering r3) and never define map*Row (r4). DB-row types are taken
 * structurally here; this file must NOT import generated/db or use TableRow.
 */

type JsonMap = Record<string, unknown>

export type ModelGroupRow = {
  id: string
  ownerType: ModelGroupOwnerType
  ownerWorkspaceId: string | null
  ownerWorkspaceMemberId: string | null
  name: string
  description: string | null
  routingStrategy: ModelGroupRoutingStrategy
  attemptPolicy: Record<string, unknown> | null
  isDefault: boolean
  isEnabled: boolean
  createdByWorkspaceMemberId: string | null
  createdAt: Date | null
  updatedAt: Date | null
}

export type ModelGroupGrantRow = {
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

export type ModelGroupGrantDbRow = {
  id: string
  groupId: string | null
  status: "active" | "revoked"
  reason: string | null
  createdAt: Date | null
  revokedAt: Date | null
  subjectId: string
  grantedByWorkspaceMemberId: string | null
  // From joined access_subjects (aliased mgs)
  mgsKind?: string | null
  mgsWorkspaceId?: string | null
  mgsWorkspaceMemberId?: string | null
  mgsActorId?: string | null
}

export type ModelGroupItemRow = {
  id?: string | null
  itemId?: string | null
  groupId: string | null
  bindingId?: string | null
  currentVersionId?: string | null
  displayName: string | null
  priority: number | null
  weight: number | null
  itemEnabled?: boolean | null
  isEnabled?: boolean | null
  version?: number | null
  providerKind?: string | null
  vendor?: string | null
  baseUrl?: string | null
  modelName?: string | null
  maxOutputTokens?: number | null
  capabilityTags?: string[] | null
  features?: unknown
  providerOptions?: unknown
  requestTimeoutMs?: number | null
  maxRetries?: number | null
  createdAt: Date | null
  updatedAt: Date | null
}

export function asObject(value: unknown): JsonMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as JsonMap
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

export function dbRowToGrantRow(
  row: ModelGroupGrantDbRow
): ModelGroupGrantRow & { id: string; group_id: string } {
  return {
    id: row.id,
    group_id: row.groupId || "",
    grant_scope: row.mgsKind
      ? subjectKindToModelGroupGrantScope(row.mgsKind as SubjectRef["kind"])
      : MODEL_GROUP_GRANT_SCOPE.PLATFORM,
    workspace_id: row.mgsWorkspaceId ?? null,
    workspace_member_id: row.mgsWorkspaceMemberId ?? null,
    actor_id: row.mgsActorId ?? null,
    status: row.status,
    granted_by_workspace_member_id: row.grantedByWorkspaceMemberId,
    reason: row.reason,
    created_at: row.createdAt || undefined,
    revoked_at: row.revokedAt,
  }
}

export function presentGroupRow(row: ModelGroupRow): ModelGroupView {
  return {
    id: row.id,
    ownerType: row.ownerType,
    ownerWorkspaceId: row.ownerWorkspaceId,
    ownerWorkspaceMemberId: row.ownerWorkspaceMemberId,
    workspaceId: row.ownerWorkspaceId,
    scope: row.ownerType,
    name: row.name,
    description: row.description || "",
    routingStrategy: row.routingStrategy,
    attemptPolicy: asObject(row.attemptPolicy),
    isDefault: Boolean(row.isDefault),
    isActive: Boolean(row.isEnabled),
    createdByWorkspaceMemberId: row.createdByWorkspaceMemberId || null,
    createdAt: serializeInstant(
      requireInstantDate(row.createdAt, "model group created_at")
    ),
    updatedAt: serializeInstant(
      requireInstantDate(row.updatedAt, "model group updated_at")
    ),
  }
}

export function presentGroupItem(row: ModelGroupItemRow): ModelGroupItemView {
  const features = asObject(row.features)
  const providerKind =
    row.providerKind || getProviderKindForVendor(row.vendor || "anthropic")

  const itemId = row.itemId ?? row.id
  if (!itemId) {
    throw new Error("model group item row is missing binding id")
  }

  return {
    id: itemId,
    groupId: row.groupId,
    bindingId: row.bindingId ?? itemId,
    currentVersionId: row.currentVersionId || null,
    displayName: row.displayName || "",
    priority: row.priority ?? 0,
    weight: row.weight ?? 1,
    isEnabled: Boolean(row.itemEnabled ?? row.isEnabled),
    version: row.version || null,
    providerKind,
    vendor: row.vendor || null,
    baseUrl: row.baseUrl || null,
    modelName: row.modelName || null,
    maxOutputTokens: row.maxOutputTokens || null,
    capabilityTags: row.capabilityTags || [],
    features,
    providerOptions: asObject(row.providerOptions),
    requestTimeoutMs: row.requestTimeoutMs ?? null,
    maxRetries: row.maxRetries ?? null,
    createdAt: serializeOptionalInstant(row.createdAt) ?? null,
    updatedAt: serializeOptionalInstant(row.updatedAt) ?? null,
  }
}

export function presentGrantRow(
  row: ModelGroupGrantRow & { id: string; group_id: string }
): ModelGroupGrantView {
  return {
    id: row.id,
    groupId: row.group_id,
    grantScope: row.grant_scope,
    workspaceId: row.workspace_id,
    workspaceMemberId: row.workspace_member_id,
    actorId: row.actor_id,
    status: row.status,
    grantedByWorkspaceMemberId: row.granted_by_workspace_member_id || null,
    reason: row.reason || null,
    createdAt: serializeOptionalInstant(row.created_at) ?? null,
    revokedAt: serializeOptionalInstant(row.revoked_at) ?? null,
  }
}

export type ActorModelGroupAssignmentRow = {
  actorId: string
  groupId: string
  priority: number | null
  createdAt: Date | null
  groupName: string
  routingStrategy: ModelGroupRoutingStrategy
  isDefault: boolean
  workspaceId: string | null
  ownerType: ModelGroupOwnerType
  ownerWorkspaceMemberId: string | null
}

export function presentActorModelGroup(
  row: ActorModelGroupAssignmentRow
): ActorModelGroupAssignmentView {
  return {
    actorId: row.actorId,
    groupId: row.groupId,
    priority: row.priority ?? 0,
    createdAt: serializeOptionalInstant(row.createdAt) ?? null,
    groupName: row.groupName,
    routingStrategy: row.routingStrategy,
    isDefault: Boolean(row.isDefault),
    workspaceId: row.workspaceId ?? null,
    ownerType: row.ownerType,
    ownerWorkspaceMemberId: row.ownerWorkspaceMemberId ?? null,
  }
}

export type ModelGroupItemVersionRow = {
  id: string
  bindingId: string | null
  version: number | null
  providerKind: string | null
  vendor: string | null
  baseUrl: string | null
  modelName: string | null
  maxOutputTokens: number | null
  capabilityTags: string[] | null
  features?: unknown
  providerOptions?: unknown
  requestTimeoutMs: number | null
  maxRetries: number | null
  createdAt: Date | null
}

export function presentItemVersion(
  row: ModelGroupItemVersionRow
): ModelGroupItemVersionView {
  if (!row.bindingId) {
    throw new Error("model binding version row is missing binding_id")
  }
  if (!row.vendor) {
    throw new Error("model binding version row is missing vendor")
  }
  if (!row.baseUrl) {
    throw new Error("model binding version row is missing base_url")
  }
  return {
    id: row.id,
    bindingId: row.bindingId,
    version: row.version ?? 0,
    providerKind: row.providerKind || getProviderKindForVendor(row.vendor),
    vendor: row.vendor,
    baseUrl: row.baseUrl,
    modelName: row.modelName || null,
    maxOutputTokens: row.maxOutputTokens ?? null,
    capabilityTags: row.capabilityTags || [],
    features: asObject(row.features),
    providerOptions: asObject(row.providerOptions),
    requestTimeoutMs: row.requestTimeoutMs ?? null,
    maxRetries: row.maxRetries ?? null,
    createdAt: serializeOptionalInstant(row.createdAt) ?? null,
  }
}
