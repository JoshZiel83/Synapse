import {
  MODEL_API_STYLES,
  MODEL_SERVER_TOOLS,
  type ModelApiStyle,
  type ModelServerTool,
  ModelAttemptPolicy,
  MultimodalConfig,
  ProviderKind,
  ResolvedModelConfig,
  ResolvedModelPlan,
} from "@synapse/shared"
import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL_ATTEMPT_POLICY } from "./defaults.js"
import {
  type ModelGroupCandidateRow,
  type ModelGroupItemRow,
  listAuthorizedModelGroupIds,
  listCandidateGroupRows,
  listGroupItemRows,
} from "./repo.js"

type RoutingStrategy = "weighted_random" | "priority_failover"

type GroupRow = ModelGroupCandidateRow

type GroupItemRow = ModelGroupItemRow

type ResolveContext = {
  actorId: string
  workspaceId: string
  conversationId?: string
  workspaceMemberId?: string
}

const DEFAULT_ATTEMPT_POLICY: ModelAttemptPolicy = DEFAULT_MODEL_ATTEMPT_POLICY

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const MODEL_API_STYLE_SET = new Set<string>(MODEL_API_STYLES)
const MODEL_SERVER_TOOL_SET = new Set<string>(MODEL_SERVER_TOOLS)

function isModelApiStyle(value: unknown): value is ModelApiStyle {
  return typeof value === "string" && MODEL_API_STYLE_SET.has(value)
}

function isModelServerTool(value: unknown): value is ModelServerTool {
  return typeof value === "string" && MODEL_SERVER_TOOL_SET.has(value)
}

function parseAttemptPolicy(
  value: Record<string, unknown> | null | undefined
): ModelAttemptPolicy {
  const policy = value ?? {}
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

function finalizeAttemptPolicy(
  value: Record<string, unknown> | null | undefined
): ModelAttemptPolicy {
  const base = parseAttemptPolicy(value)
  const policy = value ?? {}
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
    return a.displayName.localeCompare(b.displayName)
  })

  if (strategy === "weighted_random" && sorted.length > 1) {
    const first = weightedPick(sorted)
    return [first, ...sorted.filter((item) => item.itemId !== first.itemId)]
  }

  return sorted
}

function ownerRank(group: GroupRow, current: ResolveContext) {
  if (
    group.ownerType === "workspace_member" &&
    group.ownerWorkspaceMemberId === current.workspaceMemberId
  ) {
    return 0
  }
  if (
    group.ownerType === "workspace" &&
    group.ownerWorkspaceId === current.workspaceId
  )
    return 1
  if (group.ownerType === "platform") return 2
  return 3
}

async function listCandidateGroups(
  current: ResolveContext,
  authorizedGroupIds: Set<string>
) {
  const {
    groups,
    assignments,
    workspaceDefaultGroupId,
    platformDefaultGroupId,
    workspaceMemberDefaultGroupId,
  } = await listCandidateGroupRows({
    actorId: current.actorId,
    workspaceId: current.workspaceId,
    workspaceMemberId: current.workspaceMemberId,
    authorizedGroupIds: Array.from(authorizedGroupIds),
  })

  const assignedPriority = new Map<string, number>()
  for (const row of assignments) {
    assignedPriority.set(row.groupId, row.priority)
  }

  return groups.sort((a, b) => {
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

    return b.updatedAt.getTime() - a.updatedAt.getTime()
  })
}

async function listGroupItems(groupId: string): Promise<GroupItemRow[]> {
  return listGroupItemRows(groupId)
}

function toResolvedModelConfig(row: GroupItemRow): ResolvedModelConfig | null {
  if (
    !row.currentVersionId ||
    !row.providerKind ||
    !row.vendor ||
    !row.apiKey ||
    !row.baseUrl ||
    !row.modelName
  ) {
    return null
  }

  const features = row.features ?? {}
  const multimodalConfig = recordValue(features.multimodal)
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
  const apiStyle = isModelApiStyle(apiStyleRaw) ? apiStyleRaw : undefined
  const serverTools = Array.isArray(features.serverTools)
    ? features.serverTools.filter(isModelServerTool)
    : undefined

  return {
    groupId: row.groupId,
    bindingId: row.bindingId,
    bindingVersionId: row.currentVersionId,
    providerKind: row.providerKind as ProviderKind,
    vendor: row.vendor,
    apiStyle,
    apiKey: row.apiKey,
    baseUrl: row.baseUrl,
    modelName: row.modelName,
    maxOutputTokens: row.maxOutputTokens || DEFAULT_MAX_TOKENS,
    serverTools,
    multimodal,
    crossTurnToolHistory:
      features.crossTurnToolHistory === true ? true : undefined,
    providerOptions: row.providerOptions ?? undefined,
    priority: row.priority,
    weight: row.weight,
    requestTimeoutMs: row.requestTimeoutMs ?? undefined,
    maxRetries: row.maxRetries ?? undefined,
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

  const authorizedGroupIds = await listAuthorizedModelGroupIds({
    actorId: current.actorId,
    workspaceMemberId: current.workspaceMemberId,
  })
  const groups = await listCandidateGroups(current, authorizedGroupIds)

  for (const group of groups) {
    const items = await listGroupItems(group.id)
    if (items.length === 0) continue

    const orderedItems = orderGroupItems(group.routingStrategy, items)
    const candidates = orderedItems
      .map(toResolvedModelConfig)
      .filter(
        (candidate): candidate is ResolvedModelConfig => candidate !== null
      )

    if (candidates.length === 0) continue

    return {
      groupId: group.id,
      groupName: group.name,
      routingStrategy: group.routingStrategy,
      attemptPolicy: finalizeAttemptPolicy(group.attemptPolicy),
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
