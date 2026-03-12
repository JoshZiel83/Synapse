import type { ModelAttemptPolicy, MultimodalConfig, ResolvedModelConfig, ResolvedModelPlan } from '@synapse/shared';
import { redis } from '../../infrastructure/redis/index.js';
import { query } from '../../infrastructure/database/index.js';
import { config } from '../../config/index.js';

type RouteRow = {
  id: string;
  workspace_id: string | null;
  route_scope: 'platform' | 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user';
  conversation_id: string | null;
  actor_id: string | null;
  user_id: string | null;
  name: string;
  routing_strategy: 'weighted_random' | 'round_robin' | 'priority_failover';
  attempt_policy: Record<string, unknown> | null;
  is_default: boolean;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
};

type GrantRow = {
  route_id?: string;
  binding_id?: string;
  grant_scope: 'platform' | 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user';
  workspace_id: string | null;
  conversation_id: string | null;
  actor_id: string | null;
  user_id: string | null;
  status: 'active' | 'revoked';
};

type RouteItemRow = {
  route_id: string;
  route_name: string;
  routing_strategy: 'weighted_random' | 'round_robin' | 'priority_failover';
  attempt_policy: Record<string, unknown> | null;
  route_scope: RouteRow['route_scope'];
  route_workspace_id: string | null;
  route_conversation_id: string | null;
  route_actor_id: string | null;
  route_user_id: string | null;
  item_id: string;
  priority: number;
  weight: number;
  item_enabled: boolean;
  binding_id: string;
  binding_scope: 'platform' | 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user';
  binding_workspace_id: string | null;
  binding_conversation_id: string | null;
  binding_actor_id: string | null;
  binding_user_id: string | null;
  display_name: string;
  current_revision_id: string | null;
  provider_type: 'anthropic' | 'openai' | null;
  api_key: string | null;
  base_url: string | null;
  model_name: string | null;
  max_tokens: number | null;
  capability_tags: string[] | null;
  extra_config: Record<string, unknown> | null;
  request_timeout_ms: number | null;
  max_retries: number | null;
};

type ResolveContext = {
  actorId: string;
  workspaceId: string;
  conversationId?: string;
  userId?: string;
  userCount?: number;
};

const DEFAULT_ATTEMPT_POLICY: ModelAttemptPolicy = {
  maxAttemptsTotal: 4,
  maxAttemptsPerBinding: 2,
  timeoutMsPerAttempt: 30000,
  continueOn: ['timeout', '5xx', 'network', 'rate_limit'],
  stopOn: ['auth_error', 'bad_request', 'policy_block'],
  retryBackoffMs: [0, 1000, 3000],
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseAttemptPolicy(value: unknown): ModelAttemptPolicy {
  const policy = asObject(value);
  return {
    maxAttemptsTotal: asNumber(policy.maxAttemptsTotal) ?? DEFAULT_ATTEMPT_POLICY.maxAttemptsTotal,
    maxAttemptsPerBinding: asNumber(policy.maxAttemptsPerBinding) ?? DEFAULT_ATTEMPT_POLICY.maxAttemptsPerBinding,
    timeoutMsPerAttempt: asNumber(policy.timeoutMsPerAttempt) ?? DEFAULT_ATTEMPT_POLICY.timeoutMsPerAttempt,
    continueOn: asStringArray(policy.continueOn).length > 0 ? asStringArray(policy.continueOn) : DEFAULT_ATTEMPT_POLICY.continueOn,
    stopOn: asStringArray(policy.stopOn).length > 0 ? asStringArray(policy.stopOn) : DEFAULT_ATTEMPT_POLICY.stopOn,
    retryBackoffMs: DEFAULT_ATTEMPT_POLICY.retryBackoffMs,
  };
}

function parseRetryBackoff(value: unknown): number[] {
  if (!Array.isArray(value)) return DEFAULT_ATTEMPT_POLICY.retryBackoffMs;
  const parsed = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
  return parsed.length > 0 ? parsed : DEFAULT_ATTEMPT_POLICY.retryBackoffMs;
}

function finalizeAttemptPolicy(value: unknown): ModelAttemptPolicy {
  const base = parseAttemptPolicy(value);
  const policy = asObject(value);
  return {
    ...base,
    retryBackoffMs: parseRetryBackoff(policy.retryBackoffMs),
  };
}

function scopeMatches(
  scope: 'platform' | 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user',
  target: {
    workspaceId?: string | null;
    conversationId?: string | null;
    actorId?: string | null;
    userId?: string | null;
    userCount?: number;
  },
  current: ResolveContext,
) {
  switch (scope) {
    case 'platform':
      return true;
    case 'workspace':
      return target.workspaceId === current.workspaceId;
    case 'conversation':
      return Boolean(current.conversationId && target.conversationId === current.conversationId);
    case 'actor_global':
      return target.actorId === current.actorId;
    case 'actor_conversation':
      return Boolean(
        current.conversationId &&
        target.actorId === current.actorId &&
        target.conversationId === current.conversationId,
      );
    case 'user':
      return Boolean(
        current.userId &&
        current.userCount === 1 &&
        target.userId === current.userId,
      );
    default:
      return false;
  }
}

function routeVisible(route: RouteRow, grants: GrantRow[], current: ResolveContext) {
  if (scopeMatches(route.route_scope, {
    workspaceId: route.workspace_id,
    conversationId: route.conversation_id,
    actorId: route.actor_id,
    userId: route.user_id,
  }, current)) {
    return true;
  }

  return grants.some((grant) =>
    grant.status === 'active' &&
    scopeMatches(grant.grant_scope, {
      workspaceId: grant.workspace_id,
      conversationId: grant.conversation_id,
      actorId: grant.actor_id,
      userId: grant.user_id,
    }, current),
  );
}

function bindingVisible(binding: RouteItemRow, grants: GrantRow[], current: ResolveContext) {
  if (scopeMatches(binding.binding_scope, {
    workspaceId: binding.binding_workspace_id,
    conversationId: binding.binding_conversation_id,
    actorId: binding.binding_actor_id,
    userId: binding.binding_user_id,
  }, current)) {
    return true;
  }

  return grants.some((grant) =>
    grant.status === 'active' &&
    scopeMatches(grant.grant_scope, {
      workspaceId: grant.workspace_id,
      conversationId: grant.conversation_id,
      actorId: grant.actor_id,
      userId: grant.user_id,
    }, current),
  );
}

function scopeRank(scope: RouteRow['route_scope']) {
  switch (scope) {
    case 'actor_conversation':
      return 0;
    case 'conversation':
      return 1;
    case 'user':
      return 2;
    case 'actor_global':
      return 3;
    case 'workspace':
      return 4;
    case 'platform':
      return 5;
    default:
      return 99;
  }
}

function weightedPick<T extends { weight: number }>(items: T[]) {
  const totalWeight = items.reduce((sum, item) => sum + Math.max(1, item.weight || 1), 0);
  let cursor = Math.random() * totalWeight;
  for (const item of items) {
    cursor -= Math.max(1, item.weight || 1);
    if (cursor <= 0) return item;
  }
  return items[0];
}

function orderRouteItems(routeId: string, strategy: RouteRow['routing_strategy'], items: RouteItemRow[], roundRobinOffset = 0) {
  const sorted = [...items].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.weight !== b.weight) return b.weight - a.weight;
    return a.display_name.localeCompare(b.display_name);
  });

  if (strategy === 'round_robin' && sorted.length > 1) {
    const offset = roundRobinOffset % sorted.length;
    return [...sorted.slice(offset), ...sorted.slice(0, offset)];
  }

  if (strategy === 'weighted_random' && sorted.length > 1) {
    const first = weightedPick(sorted);
    return [first, ...sorted.filter((item) => item.item_id !== first.item_id)];
  }

  void routeId;
  return sorted;
}

async function getRoundRobinOffset(routeId: string, length: number) {
  if (length <= 1) return 0;
  const key = `model_route:rr:${routeId}`;
  const count = await redis.incr(key);
  await redis.expire(key, 86400);
  return (count - 1) % length;
}

async function listVisibleRoutes(current: ResolveContext) {
  const [routesResult, grantsResult, assignmentsResult, workspaceDefaultResult, platformDefaultResult] = await Promise.all([
    query(
      `SELECT *
       FROM model_routes
       WHERE is_enabled = TRUE
         AND (
           route_scope = 'platform'
           OR workspace_id = $1
         )`,
      [current.workspaceId],
    ),
    query(
      `SELECT *
       FROM model_route_grants
       WHERE status = 'active'
         AND (
           grant_scope = 'platform'
           OR workspace_id = $1
         )`,
      [current.workspaceId],
    ),
    query(
      `SELECT route_id, priority
       FROM actor_model_routes
       WHERE actor_id = $1
       ORDER BY priority ASC`,
      [current.actorId],
    ),
    query(
      `SELECT default_model_route_id
       FROM workspaces
       WHERE id = $1
       LIMIT 1`,
      [current.workspaceId],
    ),
    query(
      `SELECT default_model_route_id
       FROM platform_settings
       WHERE id = TRUE
       LIMIT 1`,
      [],
    ),
  ]);

  const grantsByRoute = new Map<string, GrantRow[]>();
  for (const row of grantsResult.rows as GrantRow[]) {
    if (!row.route_id) continue;
    const bucket = grantsByRoute.get(row.route_id) || [];
    bucket.push(row);
    grantsByRoute.set(row.route_id, bucket);
  }

  const assignedPriority = new Map<string, number>();
  for (const row of assignmentsResult.rows as Array<{ route_id: string; priority: number }>) {
    assignedPriority.set(row.route_id, row.priority);
  }

  const workspaceDefaultRouteId = workspaceDefaultResult.rows[0]?.default_model_route_id as string | undefined;
  const platformDefaultRouteId = platformDefaultResult.rows[0]?.default_model_route_id as string | undefined;

  const visible = (routesResult.rows as RouteRow[])
    .filter((route) => routeVisible(route, grantsByRoute.get(route.id) || [], current))
    .sort((a, b) => {
      const aAssigned = assignedPriority.has(a.id);
      const bAssigned = assignedPriority.has(b.id);
      if (aAssigned && bAssigned) {
        return (assignedPriority.get(a.id) || 0) - (assignedPriority.get(b.id) || 0);
      }
      if (aAssigned) return -1;
      if (bAssigned) return 1;

      const aIsDefault = a.id === workspaceDefaultRouteId || a.id === platformDefaultRouteId || a.is_default;
      const bIsDefault = b.id === workspaceDefaultRouteId || b.id === platformDefaultRouteId || b.is_default;
      if (aIsDefault !== bIsDefault) return aIsDefault ? -1 : 1;

      const rankDiff = scopeRank(a.route_scope) - scopeRank(b.route_scope);
      if (rankDiff !== 0) return rankDiff;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });

  return visible;
}

async function listRouteItems(routeId: string) {
  const result = await query(
    `SELECT
        mr.id AS route_id,
        mr.name AS route_name,
        mr.routing_strategy,
        mr.attempt_policy,
        mr.route_scope,
        mr.workspace_id AS route_workspace_id,
        mr.conversation_id AS route_conversation_id,
        mr.actor_id AS route_actor_id,
        mr.user_id AS route_user_id,
        ri.id AS item_id,
        ri.priority,
        ri.weight,
        ri.is_enabled AS item_enabled,
        b.id AS binding_id,
        b.binding_scope,
        b.workspace_id AS binding_workspace_id,
        b.conversation_id AS binding_conversation_id,
        b.actor_id AS binding_actor_id,
        b.user_id AS binding_user_id,
        b.display_name,
        b.current_revision_id,
        r.provider_type,
        r.api_key,
        r.base_url,
        r.model_name,
        r.max_tokens,
        r.capability_tags,
        r.extra_config,
        r.request_timeout_ms,
        r.max_retries
     FROM model_route_items ri
     JOIN model_routes mr ON mr.id = ri.route_id
     JOIN model_bindings b ON b.id = ri.binding_id
     LEFT JOIN model_binding_revisions r ON r.id = b.current_revision_id
     WHERE ri.route_id = $1
       AND ri.is_enabled = TRUE
       AND b.is_enabled = TRUE
       AND b.current_revision_id IS NOT NULL`,
    [routeId],
  );
  return result.rows as RouteItemRow[];
}

async function listBindingGrants(workspaceId: string, bindingIds: string[]) {
  if (bindingIds.length === 0) return new Map<string, GrantRow[]>();
  const result = await query(
    `SELECT *
     FROM model_binding_grants
     WHERE status = 'active'
       AND binding_id = ANY($1)
       AND (
         grant_scope = 'platform'
         OR workspace_id = $2
       )`,
    [bindingIds, workspaceId],
  );
  const byBinding = new Map<string, GrantRow[]>();
  for (const row of result.rows as GrantRow[]) {
    if (!row.binding_id) continue;
    const bucket = byBinding.get(row.binding_id) || [];
    bucket.push(row);
    byBinding.set(row.binding_id, bucket);
  }
  return byBinding;
}

function toResolvedModelConfig(row: RouteItemRow): ResolvedModelConfig | null {
  if (!row.current_revision_id || !row.provider_type || !row.api_key || !row.base_url || !row.model_name) {
    return null;
  }
  const extraConfig = asObject(row.extra_config);
  const multimodalConfig = asObject(extraConfig.multimodal);
  const multimodal: MultimodalConfig | undefined = multimodalConfig.supported === true
    ? {
        supported: true,
        types: Array.isArray(multimodalConfig.types) ? multimodalConfig.types as MultimodalConfig['types'] : [],
      }
    : undefined;

  return {
    routeId: row.route_id,
    bindingId: row.binding_id,
    revisionId: row.current_revision_id,
    providerType: row.provider_type,
    apiKey: row.api_key,
    baseUrl: row.base_url,
    modelName: row.model_name,
    maxTokens: row.max_tokens || config.ai.maxTokens,
    builtinTools: Array.isArray(extraConfig.builtin_tools) ? extraConfig.builtin_tools as ResolvedModelConfig['builtinTools'] : undefined,
    multimodal,
    crossTurnToolHistory: extraConfig.cross_turn_tool_history === true ? true : undefined,
    bindingScope: row.binding_scope,
    priority: row.priority,
    weight: row.weight,
    requestTimeoutMs: row.request_timeout_ms ?? undefined,
    maxRetries: row.max_retries ?? undefined,
  };
}

export async function resolveModelPlan(
  actorId: string,
  workspaceId: string,
  options?: {
    conversationId?: string;
    userId?: string;
    userCount?: number;
  },
): Promise<ResolvedModelPlan | null> {
  const current: ResolveContext = {
    actorId,
    workspaceId,
    conversationId: options?.conversationId,
    userId: options?.userId,
    userCount: options?.userCount ?? 0,
  };

  const routes = await listVisibleRoutes(current);
  for (const route of routes) {
    const items = await listRouteItems(route.id);
    if (items.length === 0) continue;
    const grantsByBinding = await listBindingGrants(workspaceId, items.map((item) => item.binding_id));
    const visibleItems = items.filter((item) => bindingVisible(item, grantsByBinding.get(item.binding_id) || [], current));
    if (visibleItems.length === 0) continue;

    const offset = route.routing_strategy === 'round_robin'
      ? await getRoundRobinOffset(route.id, visibleItems.length)
      : 0;
    const orderedItems = orderRouteItems(route.id, route.routing_strategy, visibleItems, offset);
    const candidates = orderedItems
      .map(toResolvedModelConfig)
      .filter((candidate): candidate is ResolvedModelConfig => candidate !== null);
    if (candidates.length === 0) continue;

    return {
      routeId: route.id,
      routeName: route.name,
      routingStrategy: route.routing_strategy,
      attemptPolicy: finalizeAttemptPolicy(route.attempt_policy),
      candidates,
    };
  }

  return null;
}

export async function resolveModelConfig(
  actorId: string,
  workspaceId: string,
  options?: {
    conversationId?: string;
    userId?: string;
    userCount?: number;
  },
): Promise<ResolvedModelConfig | null> {
  const plan = await resolveModelPlan(actorId, workspaceId, options);
  return plan?.candidates[0] || null;
}

export function getEnvFallbackConfig(): ResolvedModelConfig {
  return {
    routeId: 'env-fallback',
    bindingId: 'env-fallback',
    revisionId: 'env-fallback',
    providerType: config.ai.provider === 'openai' ? 'openai' : 'anthropic',
    apiKey: config.ai.apiKey,
    baseUrl: config.ai.baseUrl,
    modelName: config.ai.model,
    maxTokens: config.ai.maxTokens,
    requestTimeoutMs: DEFAULT_ATTEMPT_POLICY.timeoutMsPerAttempt,
    maxRetries: DEFAULT_ATTEMPT_POLICY.maxAttemptsPerBinding - 1,
  };
}
