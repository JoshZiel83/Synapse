import {
  getProviderKindForVendor,
  SUBJECT_KIND,
  type SubjectRef,
} from "@synapse/shared"
import { MODEL_GROUP_GRANT_SCOPE } from "@synapse/shared/constants"
import type {
  ModelGroupGrantScope,
  ModelGroupOwnerType,
  ModelGroupRoutingStrategy,
} from "@synapse/shared/types"
import {
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"

/**
 * Model-groups presentation layer: DB row → app-facing snake_case view. Owns
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

export function presentGroupRow(row: ModelGroupRow) {
  return {
    id: row.id,
    owner_type: row.ownerType,
    owner_workspace_id: row.ownerWorkspaceId,
    owner_workspace_member_id: row.ownerWorkspaceMemberId,
    workspace_id: row.ownerWorkspaceId,
    scope: row.ownerType,
    name: row.name,
    description: row.description || "",
    routing_strategy: row.routingStrategy,
    attempt_policy: asObject(row.attemptPolicy),
    is_default: Boolean(row.isDefault),
    is_active: Boolean(row.isEnabled),
    createdByWorkspaceMemberId: row.createdByWorkspaceMemberId || null,
    created_at:
      serializeOptionalInstant(row.createdAt) ||
      serializeOptionalInstant(row.updatedAt) ||
      serializeInstant(new Date(0)),
    updated_at:
      serializeOptionalInstant(row.updatedAt) ||
      serializeOptionalInstant(row.createdAt) ||
      serializeInstant(new Date(0)),
  }
}

export function presentGroupItem(row: ModelGroupItemRow) {
  const features = asObject(row.features)
  const providerKind =
    row.providerKind || getProviderKindForVendor(row.vendor || "anthropic")

  return {
    id: row.itemId ?? row.id ?? "",
    group_id: row.groupId,
    binding_id: row.bindingId ?? row.itemId ?? row.id ?? "",
    current_version_id: row.currentVersionId || null,
    display_name: row.displayName || "",
    priority: row.priority ?? 0,
    weight: row.weight ?? 1,
    is_enabled: Boolean(row.itemEnabled ?? row.isEnabled),
    version: row.version || null,
    provider_kind: providerKind,
    vendor: row.vendor || null,
    base_url: row.baseUrl || null,
    model_name: row.modelName || null,
    max_output_tokens: row.maxOutputTokens || null,
    capability_tags: row.capabilityTags || [],
    features,
    provider_options: asObject(row.providerOptions),
    request_timeout_ms: row.requestTimeoutMs ?? null,
    max_retries: row.maxRetries ?? null,
    created_at: row.createdAt || undefined,
    updated_at: row.updatedAt || undefined,
  }
}

export function presentGrantRow(
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
