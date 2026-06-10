import type {
  ModelAttemptPolicy,
  MultimodalConfig,
  ProviderKind,
  ResolvedModelConfig,
  ResolvedModelPlan,
} from "@synapse/shared"
import { db } from "../../infrastructure/database/kysely.js"
import {
  actorSubject,
  listAuthorizedResourceIds,
  workspaceMemberSubject,
} from "../access/service.js"
import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL_ATTEMPT_POLICY } from "./defaults.js"

type RoutingStrategy = "weighted_random" | "priority_failover"

type GroupRow = {
  id: string
  owner_type: "platform" | "workspace" | "workspace_member"
  owner_workspace_id: string | null
  owner_workspace_member_id: string | null
  name: string
  routing_strategy: RoutingStrategy
  attempt_policy: Record<string, unknown> | null
  is_default: boolean
  is_enabled: boolean
  created_at: Date
  updated_at: Date
}

type GroupItemRow = {
  group_id: string
  group_name: string
  routing_strategy: RoutingStrategy
  attempt_policy: Record<string, unknown> | null
  item_id: string
  priority: number
  weight: number
  item_enabled: boolean
  binding_id: string
  display_name: string
  current_version_id: string | null
  provider_kind: string | null
  vendor: string | null
  api_key: string | null
  base_url: string | null
  model_name: string | null
  max_output_tokens: number | null
  capability_tags: string[] | null
  features: Record<string, unknown> | null
  provider_options: Record<string, unknown> | null
  request_timeout_ms: number | null
  max_retries: number | null
}

type ResolveContext = {
  actorId: string
  workspaceId: string
  conversationId?: string
  workspaceMemberId?: string
}

const DEFAULT_ATTEMPT_POLICY: ModelAttemptPolicy = DEFAULT_MODEL_ATTEMPT_POLICY

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function parseAttemptPolicy(value: unknown): ModelAttemptPolicy {
  const policy = asObject(value)
  return {
    maxAttemptsTotal:
      asNumber(policy.maxAttemptsTotal) ??
      DEFAULT_ATTEMPT_POLICY.maxAttemptsTotal,
    maxAttemptsPerBinding:
      asNumber(policy.maxAttemptsPerBinding) ??
      DEFAULT_ATTEMPT_POLICY.maxAttemptsPerBinding,
    timeoutMsPerAttempt:
      asNumber(policy.timeoutMsPerAttempt) ??
      DEFAULT_ATTEMPT_POLICY.timeoutMsPerAttempt,
    continueOn:
      asStringArray(policy.continueOn).length > 0
        ? asStringArray(policy.continueOn)
        : DEFAULT_ATTEMPT_POLICY.continueOn,
    stopOn:
      asStringArray(policy.stopOn).length > 0
        ? asStringArray(policy.stopOn)
        : DEFAULT_ATTEMPT_POLICY.stopOn,
    retryBackoffMs: DEFAULT_ATTEMPT_POLICY.retryBackoffMs,
  }
}

function parseRetryBackoff(value: unknown): number[] {
  if (!Array.isArray(value)) return DEFAULT_ATTEMPT_POLICY.retryBackoffMs
  const parsed = value.filter(
    (item): item is number => typeof item === "number" && Number.isFinite(item)
  )
  return parsed.length > 0 ? parsed : DEFAULT_ATTEMPT_POLICY.retryBackoffMs
}

function finalizeAttemptPolicy(value: unknown): ModelAttemptPolicy {
  const base = parseAttemptPolicy(value)
  const policy = asObject(value)
  return {
    ...base,
    retryBackoffMs: parseRetryBackoff(policy.retryBackoffMs),
  }
}

function weightedPick<T extends { weight: number }>(items: T[]) {
  const totalWeight = items.reduce(
    (sum, item) => sum + Math.max(1, item.weight || 1),
    0
  )
  let cursor = Math.random() * totalWeight
  for (const item of items) {
    cursor -= Math.max(1, item.weight || 1)
    if (cursor <= 0) return item
  }
  return items[0]
}

function orderGroupItems(strategy: RoutingStrategy, items: GroupItemRow[]) {
  const sorted = [...items].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    if (a.weight !== b.weight) return b.weight - a.weight
    return a.display_name.localeCompare(b.display_name)
  })

  if (strategy === "weighted_random" && sorted.length > 1) {
    const first = weightedPick(sorted)
    return [first, ...sorted.filter((item) => item.item_id !== first.item_id)]
  }

  return sorted
}

function ownerRank(group: GroupRow, current: ResolveContext) {
  if (
    group.owner_type === "workspace_member" &&
    group.owner_workspace_member_id === current.workspaceMemberId
  ) {
    return 0
  }
  if (
    group.owner_type === "workspace" &&
    group.owner_workspace_id === current.workspaceId
  )
    return 1
  if (group.owner_type === "platform") return 2
  return 3
}

async function listAuthorizedModelGroupIds(current: ResolveContext) {
  const authorized = new Set<string>()

  const actorResults = await listAuthorizedResourceIds(db, {
    subject: actorSubject(current.actorId),
    action: "model_group.use",
  })
  for (const id of actorResults) {
    authorized.add(id)
  }

  if (current.workspaceMemberId) {
    const userResults = await listAuthorizedResourceIds(db, {
      subject: workspaceMemberSubject(current.workspaceMemberId),
      action: "model_group.use",
    })
    for (const id of userResults) {
      authorized.add(id)
    }
  }

  return authorized
}

async function listCandidateGroups(
  current: ResolveContext,
  authorizedGroupIds: Set<string>
) {
  const [
    groupsResult,
    assignmentsResult,
    workspaceDefaultResult,
    platformDefaultResult,
    workspaceMemberDefaultResult,
  ] = await Promise.all([
    authorizedGroupIds.size > 0
      ? db
          .selectFrom("model_groups_live")
          .selectAll()
          .where("is_enabled", "=", true)
          .where("id", "in", Array.from(authorizedGroupIds))
          .execute()
      : Promise.resolve([] as GroupRow[]),
    db
      .selectFrom("actor_model_group_assignments")
      .select(["group_id", "priority"])
      .where("actor_id", "=", current.actorId)
      .orderBy("priority", "asc")
      .execute(),
    db
      .selectFrom("model_groups_live")
      .select("id")
      .where("owner_type", "=", "workspace")
      .where("owner_workspace_id", "=", current.workspaceId)
      .where("is_default", "=", true)
      .where("is_enabled", "=", true)
      .executeTakeFirst(),
    db
      .selectFrom("model_groups_live")
      .select("id")
      .where("owner_type", "=", "platform")
      .where("is_default", "=", true)
      .where("is_enabled", "=", true)
      .executeTakeFirst(),
    current.workspaceMemberId
      ? db
          .selectFrom("model_groups_live")
          .select("id")
          .where("owner_type", "=", "workspace_member")
          .where("owner_workspace_member_id", "=", current.workspaceMemberId)
          .where("is_default", "=", true)
          .where("is_enabled", "=", true)
          .executeTakeFirst()
      : Promise.resolve(undefined),
  ])

  const assignedPriority = new Map<string, number>()
  for (const row of assignmentsResult as Array<{
    group_id: string
    priority: number
  }>) {
    assignedPriority.set(row.group_id, row.priority)
  }

  const workspaceDefaultGroupId = workspaceDefaultResult?.id || undefined
  const platformDefaultGroupId = platformDefaultResult?.id || undefined
  const workspaceMemberDefaultGroupId =
    workspaceMemberDefaultResult?.id || undefined

  return (groupsResult as GroupRow[]).sort((a, b) => {
    const aAssigned = assignedPriority.has(a.id)
    const bAssigned = assignedPriority.has(b.id)
    if (aAssigned && bAssigned) {
      return (
        (assignedPriority.get(a.id) || 0) - (assignedPriority.get(b.id) || 0)
      )
    }
    if (aAssigned) return -1
    if (bAssigned) return 1

    const aIsWorkspaceMemberDefault = a.id === workspaceMemberDefaultGroupId
    const bIsWorkspaceMemberDefault = b.id === workspaceMemberDefaultGroupId
    if (aIsWorkspaceMemberDefault !== bIsWorkspaceMemberDefault) {
      return aIsWorkspaceMemberDefault ? -1 : 1
    }

    const aIsWorkspaceDefault = a.id === workspaceDefaultGroupId
    const bIsWorkspaceDefault = b.id === workspaceDefaultGroupId
    if (aIsWorkspaceDefault !== bIsWorkspaceDefault)
      return aIsWorkspaceDefault ? -1 : 1

    const aIsPlatformDefault = a.id === platformDefaultGroupId
    const bIsPlatformDefault = b.id === platformDefaultGroupId
    if (aIsPlatformDefault !== bIsPlatformDefault)
      return aIsPlatformDefault ? -1 : 1

    const aOwnerRank = ownerRank(a, current)
    const bOwnerRank = ownerRank(b, current)
    if (aOwnerRank !== bOwnerRank) return aOwnerRank - bOwnerRank

    return b.updated_at.getTime() - a.updated_at.getTime()
  })
}

async function listGroupItems(groupId: string): Promise<GroupItemRow[]> {
  // Flat read: model_bindings (the item) joined to its current version row.
  // Reads go through the soft-delete _live view so deleted bindings are excluded.
  const result = await db
    .selectFrom("model_bindings_live as mb")
    .innerJoin("model_groups_live as mg", "mg.id", "mb.group_id")
    .leftJoin("model_binding_versions as v", "v.id", "mb.current_version_id")
    .select([
      "mg.id as group_id",
      "mg.name as group_name",
      "mg.routing_strategy",
      "mg.attempt_policy",
      "mb.id as item_id",
      "mb.priority",
      "mb.weight",
      "mb.is_enabled as item_enabled",
      "mb.id as binding_id",
      "mb.display_name",
      "mb.current_version_id",
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
    .where("mb.group_id", "=", groupId)
    .where("mb.is_enabled", "=", true)
    .where("mb.current_version_id", "is not", null)
    .execute()
  return result.map((row) => ({
    group_id: row.group_id || "",
    group_name: row.group_name || "",
    routing_strategy: row.routing_strategy || "priority_failover",
    attempt_policy:
      row.attempt_policy &&
      typeof row.attempt_policy === "object" &&
      !Array.isArray(row.attempt_policy)
        ? (row.attempt_policy as Record<string, unknown>)
        : null,
    item_id: row.item_id || "",
    priority: row.priority ?? 0,
    weight: row.weight ?? 1,
    item_enabled: row.item_enabled ?? false,
    binding_id: row.binding_id || row.item_id || "",
    display_name: row.display_name || "",
    current_version_id: row.current_version_id,
    provider_kind: row.provider_kind,
    vendor: row.vendor,
    api_key: row.api_key,
    base_url: row.base_url,
    model_name: row.model_name,
    max_output_tokens: row.max_output_tokens,
    capability_tags: Array.isArray(row.capability_tags)
      ? row.capability_tags.filter(
          (item): item is string => typeof item === "string"
        )
      : null,
    features:
      row.features &&
      typeof row.features === "object" &&
      !Array.isArray(row.features)
        ? (row.features as Record<string, unknown>)
        : null,
    provider_options:
      row.provider_options &&
      typeof row.provider_options === "object" &&
      !Array.isArray(row.provider_options)
        ? (row.provider_options as Record<string, unknown>)
        : null,
    request_timeout_ms: row.request_timeout_ms,
    max_retries: row.max_retries,
  }))
}

function toResolvedModelConfig(row: GroupItemRow): ResolvedModelConfig | null {
  if (
    !row.current_version_id ||
    !row.provider_kind ||
    !row.vendor ||
    !row.api_key ||
    !row.base_url ||
    !row.model_name
  ) {
    return null
  }

  const features = asObject(row.features)
  const multimodalConfig = asObject(features.multimodal)
  const multimodal: MultimodalConfig | undefined =
    multimodalConfig.supported === true
      ? {
          supported: true,
          types: Array.isArray(multimodalConfig.types)
            ? (multimodalConfig.types as MultimodalConfig["types"])
            : [],
        }
      : undefined

  const apiStyleRaw = features.apiStyle
  const apiStyle =
    apiStyleRaw === "responses" || apiStyleRaw === "chat"
      ? apiStyleRaw
      : undefined

  return {
    groupId: row.group_id,
    bindingId: row.binding_id,
    bindingVersionId: row.current_version_id,
    providerKind: row.provider_kind as ProviderKind,
    vendor: row.vendor,
    apiStyle,
    apiKey: row.api_key,
    baseUrl: row.base_url,
    modelName: row.model_name,
    maxOutputTokens: row.max_output_tokens || DEFAULT_MAX_TOKENS,
    serverTools: Array.isArray(features.serverTools)
      ? (features.serverTools as ResolvedModelConfig["serverTools"])
      : undefined,
    multimodal,
    crossTurnToolHistory:
      features.crossTurnToolHistory === true ? true : undefined,
    providerOptions: row.provider_options
      ? asObject(row.provider_options)
      : undefined,
    priority: row.priority,
    weight: row.weight,
    requestTimeoutMs: row.request_timeout_ms ?? undefined,
    maxRetries: row.max_retries ?? undefined,
  }
}

export async function resolveModelPlan(
  actorId: string,
  workspaceId: string,
  options?: {
    conversationId?: string
    workspaceMemberId?: string
  }
): Promise<ResolvedModelPlan | null> {
  const current: ResolveContext = {
    actorId,
    workspaceId,
    conversationId: options?.conversationId,
    workspaceMemberId: options?.workspaceMemberId,
  }

  const authorizedGroupIds = await listAuthorizedModelGroupIds(current)
  const groups = await listCandidateGroups(current, authorizedGroupIds)

  for (const group of groups) {
    const items = await listGroupItems(group.id)
    if (items.length === 0) continue

    const orderedItems = orderGroupItems(group.routing_strategy, items)
    const candidates = orderedItems
      .map(toResolvedModelConfig)
      .filter(
        (candidate): candidate is ResolvedModelConfig => candidate !== null
      )

    if (candidates.length === 0) continue

    return {
      groupId: group.id,
      groupName: group.name,
      routingStrategy: group.routing_strategy,
      attemptPolicy: finalizeAttemptPolicy(group.attempt_policy),
      candidates,
    }
  }

  return null
}

export async function resolveModelConfig(
  actorId: string,
  workspaceId: string,
  options?: {
    conversationId?: string
    workspaceMemberId?: string
  }
): Promise<ResolvedModelConfig | null> {
  const plan = await resolveModelPlan(actorId, workspaceId, options)
  return plan?.candidates[0] || null
}
