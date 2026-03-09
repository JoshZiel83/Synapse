import { query } from '../../infrastructure/database/index.js';
import { redis } from '../../infrastructure/redis/index.js';
import { config } from '../../config/index.js';
import type { ResolvedModelConfig, MultimodalConfig } from '@synapse/shared';

/**
 * Resolve model config for an actor using the failover chain:
 * 1. actor_model_groups (by priority)
 * 2. workspace.default_model_group_id
 * 3. Platform default group (workspace_id IS NULL, is_default=true)
 * 4. Fallback to env vars
 */
export async function resolveModelConfig(
  actorId: string,
  workspaceId: string
): Promise<ResolvedModelConfig | null> {
  // Collect candidate group IDs in priority order
  const candidateGroupIds: string[] = [];

  // 1. Actor-specific groups
  const actorGroups = await query(
    `SELECT group_id FROM actor_model_groups WHERE actor_id = $1 ORDER BY priority ASC`,
    [actorId]
  );
  for (const row of actorGroups.rows) {
    candidateGroupIds.push(row.group_id);
  }

  // 2. Workspace default
  const wsResult = await query(
    'SELECT default_model_group_id FROM workspaces WHERE id = $1',
    [workspaceId]
  );
  if (wsResult.rows.length > 0 && wsResult.rows[0].default_model_group_id) {
    const wsDefault = wsResult.rows[0].default_model_group_id;
    if (!candidateGroupIds.includes(wsDefault)) {
      candidateGroupIds.push(wsDefault);
    }
  }

  // 3. Platform default
  const platformResult = await query(
    'SELECT id FROM model_groups WHERE workspace_id IS NULL AND is_default = TRUE AND is_active = TRUE LIMIT 1',
    []
  );
  if (platformResult.rows.length > 0) {
    const platformId = platformResult.rows[0].id;
    if (!candidateGroupIds.includes(platformId)) {
      candidateGroupIds.push(platformId);
    }
  }

  // 4. Try each candidate group
  for (const groupId of candidateGroupIds) {
    const resolved = await resolveFromGroup(groupId);
    if (resolved) return resolved;
  }

  // 5. Fallback to env vars (no group/item/config tracking)
  return null;
}

async function resolveFromGroup(groupId: string): Promise<ResolvedModelConfig | null> {
  // Load group + enabled items with configs
  const groupResult = await query(
    'SELECT routing_strategy FROM model_groups WHERE id = $1 AND is_active = TRUE',
    [groupId]
  );
  if (groupResult.rows.length === 0) return null;

  const strategy = groupResult.rows[0].routing_strategy;

  const itemsResult = await query(
    `SELECT gi.id as item_id, gi.priority, gi.weight, gi.current_config_id,
            mc.id as config_id, mc.provider_type, mc.api_key, mc.base_url,
            mc.model_name, mc.max_tokens, mc.extra_config
     FROM model_group_items gi
     JOIN model_item_configs mc ON mc.id = gi.current_config_id
     WHERE gi.group_id = $1 AND gi.is_enabled = TRUE AND gi.current_config_id IS NOT NULL
     ORDER BY gi.priority ASC, gi.weight DESC`,
    [groupId]
  );

  if (itemsResult.rows.length === 0) return null;

  const items = itemsResult.rows;
  let selected: any;

  switch (strategy) {
    case 'weighted_random':
      selected = weightedRandom(items);
      break;
    case 'round_robin':
      selected = await roundRobin(groupId, items);
      break;
    case 'priority_failover':
    default:
      selected = items[0]; // lowest priority number = highest priority
      break;
  }

  if (!selected) return null;

  // Extract builtin_tools and multimodal from extra_config
  const extraConfig = selected.extra_config || {};
  const builtinTools = Array.isArray(extraConfig.builtin_tools) ? extraConfig.builtin_tools : undefined;
  const multimodal: MultimodalConfig | undefined = extraConfig.multimodal?.supported
    ? { supported: true, types: Array.isArray(extraConfig.multimodal.types) ? extraConfig.multimodal.types : [] }
    : undefined;

  return {
    groupId,
    itemId: selected.item_id,
    configId: selected.config_id,
    providerType: selected.provider_type,
    apiKey: selected.api_key,
    baseUrl: selected.base_url,
    modelName: selected.model_name,
    maxTokens: selected.max_tokens,
    builtinTools,
    multimodal,
  };
}

function weightedRandom(items: any[]): any {
  const totalWeight = items.reduce((sum: number, i: any) => sum + (i.weight || 1), 0);
  let random = Math.random() * totalWeight;
  for (const item of items) {
    random -= item.weight || 1;
    if (random <= 0) return item;
  }
  return items[items.length - 1];
}

async function roundRobin(groupId: string, items: any[]): Promise<any> {
  const key = `model_group:rr:${groupId}`;
  const count = await redis.incr(key);
  // Set expiry to avoid stale counters
  await redis.expire(key, 86400);
  const index = (count - 1) % items.length;
  return items[index];
}

/**
 * Get env-var fallback config (used when no model group resolves)
 */
export function getEnvFallbackConfig() {
  return {
    providerType: config.ai.provider,
    apiKey: config.ai.apiKey,
    baseUrl: config.ai.baseUrl,
    modelName: config.ai.model,
    maxTokens: config.ai.maxTokens,
  };
}
