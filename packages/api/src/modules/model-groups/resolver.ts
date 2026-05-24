import type {
  ModelAttemptPolicy,
  ModelEngineKind,
  MultimodalConfig,
  ResolvedModelConfig,
  ResolvedModelPlan,
} from "@synapse/shared"
import { resolveModelEngineKind } from "@synapse/shared"
import { redis } from "../../infrastructure/redis/index.js"
import { db } from "../../infrastructure/database/kysely.js"
import { config } from "../../config/index.js"
import {
  actorSubject,
  listAuthorizedResourceIds,
  workspaceMemberSubject,
} from "../access/service.js"
import { DEFAULT_MODEL_ATTEMPT_POLICY } from "./defaults.js"

type GroupRow = {
  id: string
  owner_type: "platform" | "workspace" | "workspace_member"
  owner_workspace_id: string | null
  owner_workspace_member_id: string | null
  name: string
  routing_strategy: "weighted_random" | "round_robin" | "priority_failover"
  attempt_policy: Record<string, unknown> | null
  is_default: boolean
  is_enabled: boolean
  created_at: string | Date
  updated_at: string | Date
}

type GroupItemRow = {
  group_id: string
  group_name: string
  routing_strategy: "weighted_random" | "round_robin" | "priority_failover"
  attempt_policy: Record<string, unknown> | null
  item_id: string
  priority: number
  weight: number
  item_enabled: boolean
  profile_id: string
  display_name: string
  current_revision_id: string | null
  provider_type: string | null
  api_key: string | null
  base_url: string | null
  model_name: string | null
  max_tokens: number | null
  capability_tags: string[] | null
  extra_config: Record<string, unknown> | null
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

function orderGroupItems(
  groupId: string,
  strategy: GroupRow["routing_strategy"],
  items: GroupItemRow[],
  roundRobinOffset = 0
) {
  const sorted = [...items].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    if (a.weight !== b.weight) return b.weight - a.weight
    return a.display_name.localeCompare(b.display_name)
  })

  if (strategy === "round_robin" && sorted.length > 1) {
    const offset = roundRobinOffset % sorted.length
    return [...sorted.slice(offset), ...sorted.slice(0, offset)]
  }

  if (strategy === "weighted_random" && sorted.length > 1) {
    const first = weightedPick(sorted)
    return [first, ...sorted.filter((item) => item.item_id !== first.item_id)]
  }

  void groupId
  return sorted
}

async function getRoundRobinOffset(groupId: string, length: number) {
  if (length <= 1) return 0
  const key = `model_group:rr:${groupId}`
  const count = await redis.incr(key)
  await redis.expire(key, 86400)
  return (count - 1) % length
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
          .selectFrom("model_groups")
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
      .selectFrom("model_groups")
      .select("id")
      .where("owner_type", "=", "workspace")
      .where("owner_workspace_id", "=", current.workspaceId)
      .where("is_default", "=", true)
      .where("is_enabled", "=", true)
      .executeTakeFirst(),
    db
      .selectFrom("model_groups")
      .select("id")
      .where("owner_type", "=", "platform")
      .where("is_default", "=", true)
      .where("is_enabled", "=", true)
      .executeTakeFirst(),
    current.workspaceMemberId
      ? db
          .selectFrom("model_groups")
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

    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  })
}

async function listGroupItems(groupId: string) {
  const result = await db
    .selectFrom("model_group_profiles as mgp")
    .innerJoin("model_groups as mg", "mg.id", "mgp.group_id")
    .innerJoin("model_profiles as mp", "mp.id", "mgp.profile_id")
    .leftJoin("model_profile_revisions as r", "r.id", "mp.current_revision_id")
    .select([
      "mg.id as group_id",
      "mg.name as group_name",
      "mg.routing_strategy",
      "mg.attempt_policy",
      "mgp.id as item_id",
      "mgp.priority",
      "mgp.weight",
      "mgp.is_enabled as item_enabled",
      "mp.id as profile_id",
      "mp.display_name",
      "mp.current_revision_id",
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
    .where("mgp.group_id", "=", groupId)
    .where("mgp.is_enabled", "=", true)
    .where("mp.is_enabled", "=", true)
    .where("mp.current_revision_id", "is not", null)
    .execute()
  return result as GroupItemRow[]
}

function toResolvedModelConfig(row: GroupItemRow): ResolvedModelConfig | null {
  if (
    !row.current_revision_id ||
    !row.provider_type ||
    !row.api_key ||
    !row.base_url ||
    !row.model_name
  ) {
    return null
  }

  const extraConfig = asObject(row.extra_config)
  const multimodalConfig = asObject(extraConfig.multimodal)
  const multimodal: MultimodalConfig | undefined =
    multimodalConfig.supported === true
      ? {
          supported: true,
          types: Array.isArray(multimodalConfig.types)
            ? (multimodalConfig.types as MultimodalConfig["types"])
            : [],
        }
      : undefined

  return {
    groupId: row.group_id,
    profileId: row.profile_id,
    profileRevisionId: row.current_revision_id,
    providerType: row.provider_type,
    engineKind: resolveModelEngineKind(row.provider_type, extraConfig),
    apiKey: row.api_key,
    baseUrl: row.base_url,
    modelName: row.model_name,
    maxTokens: row.max_tokens || config.ai.maxTokens,
    builtinTools: Array.isArray(extraConfig.builtin_tools)
      ? (extraConfig.builtin_tools as ResolvedModelConfig["builtinTools"])
      : undefined,
    multimodal,
    crossTurnToolHistory:
      extraConfig.cross_turn_tool_history === true ? true : undefined,
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

    const offset =
      group.routing_strategy === "round_robin"
        ? await getRoundRobinOffset(group.id, items.length)
        : 0
    const orderedItems = orderGroupItems(
      group.id,
      group.routing_strategy,
      items,
      offset
    )
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

export function getEnvFallbackConfig(): ResolvedModelConfig {
  return {
    groupId: "env-fallback",
    profileId: "env-fallback",
    profileRevisionId: "env-fallback",
    providerType: config.ai.provider,
    engineKind: config.ai.engineKind,
    apiKey: config.ai.apiKey,
    baseUrl: config.ai.baseUrl,
    modelName: config.ai.model,
    maxTokens: config.ai.maxTokens,
    requestTimeoutMs: DEFAULT_ATTEMPT_POLICY.timeoutMsPerAttempt,
    maxRetries: DEFAULT_ATTEMPT_POLICY.maxAttemptsPerBinding - 1,
  }
}
