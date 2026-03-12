import { config } from '../../config/index.js';
import { query } from '../../infrastructure/database/index.js';
import { logProviderStep, logRuntimeEvent } from '../execution/service.js';

type JsonMap = Record<string, unknown>;

export class ModelGroupError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

function asObject(value: unknown): JsonMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonMap;
}

function mapRouteToGroup(row: any) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    route_scope: row.route_scope,
    name: row.name,
    description: row.description || '',
    routing_strategy: row.routing_strategy,
    attempt_policy: asObject(row.attempt_policy),
    is_default: Boolean(row.is_default),
    is_active: Boolean(row.is_enabled),
    created_by: row.created_by || null,
    metadata: asObject(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapRouteItem(row: any) {
  return {
    id: row.id,
    group_id: row.route_id,
    binding_id: row.binding_id,
    current_config_id: row.current_revision_id || null,
    display_name: row.display_name,
    priority: row.priority,
    weight: row.weight,
    is_enabled: Boolean(row.is_enabled),
    config_id: row.current_revision_id || null,
    version: row.version || null,
    provider_type: row.provider_type || null,
    base_url: row.base_url || null,
    model_name: row.model_name || null,
    max_tokens: row.max_tokens || null,
    capability_tags: row.capability_tags || [],
    extra_config: asObject(row.extra_config),
    request_timeout_ms: row.request_timeout_ms ?? null,
    max_retries: row.max_retries ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function ensurePlatformSettingsRow() {
  await query(
    `INSERT INTO platform_settings (id, metadata)
     VALUES (TRUE, '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [],
  );
}

async function clearExistingDefault(scope: 'platform' | 'workspace', workspaceId?: string) {
  if (scope === 'platform') {
    await query(
      `UPDATE model_routes
       SET is_default = FALSE
       WHERE route_scope = 'platform' AND is_default = TRUE`,
      [],
    );
    await ensurePlatformSettingsRow();
    return;
  }

  if (!workspaceId) {
    throw new ModelGroupError(400, 'workspaceId is required for workspace defaults');
  }

  await query(
    `UPDATE model_routes
     SET is_default = FALSE
     WHERE workspace_id = $1 AND route_scope = 'workspace' AND is_default = TRUE`,
    [workspaceId],
  );
}

async function setDefaultRoute(routeId: string, scope: 'platform' | 'workspace', workspaceId?: string) {
  if (scope === 'platform') {
    await ensurePlatformSettingsRow();
    await query(
      `UPDATE platform_settings
       SET default_model_route_id = $1, updated_at = NOW()
       WHERE id = TRUE`,
      [routeId],
    );
    return;
  }

  if (!workspaceId) {
    throw new ModelGroupError(400, 'workspaceId is required for workspace defaults');
  }

  await query(
    `UPDATE workspaces
     SET default_model_route_id = $1, updated_at = NOW()
     WHERE id = $2`,
    [routeId, workspaceId],
  );
}

async function resolveDefaultRouteScope(routeId: string) {
  const result = await query(
    `SELECT id, workspace_id, route_scope
     FROM model_routes
     WHERE id = $1
     LIMIT 1`,
    [routeId],
  );
  if (result.rows.length === 0) {
    throw new ModelGroupError(404, 'Model route not found');
  }
  return result.rows[0] as {
    id: string;
    workspace_id: string | null;
    route_scope: 'platform' | 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user';
  };
}

async function createBindingRevision(input: {
  bindingId: string;
  version: number;
  providerType: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  maxTokens?: number;
  capabilityTags?: string[];
  extraConfig?: JsonMap;
  requestTimeoutMs?: number;
  maxRetries?: number;
}) {
  const result = await query(
    `INSERT INTO model_binding_revisions (
       binding_id, version, provider_type, api_key, base_url, model_name,
       max_tokens, capability_tags, extra_config, request_timeout_ms, max_retries, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '{}'::jsonb)
     RETURNING *`,
    [
      input.bindingId,
      input.version,
      input.providerType,
      input.apiKey,
      input.baseUrl,
      input.modelName,
      input.maxTokens ?? 4096,
      input.capabilityTags || [],
      JSON.stringify(input.extraConfig || {}),
      input.requestTimeoutMs ?? null,
      input.maxRetries ?? null,
    ],
  );
  return result.rows[0];
}

export async function listModelGroups(workspaceId: string | null) {
  if (!workspaceId) {
    const result = await query(
      `SELECT * FROM model_routes
       WHERE route_scope = 'platform' AND is_enabled = TRUE
       ORDER BY is_default DESC, name`,
      [],
    );
    return result.rows.map(mapRouteToGroup);
  }

  const result = await query(
    `SELECT *
     FROM model_routes
     WHERE is_enabled = TRUE
       AND (
         route_scope = 'platform'
         OR workspace_id = $1
       )
     ORDER BY
       CASE route_scope
         WHEN 'platform' THEN 0
         WHEN 'workspace' THEN 1
         WHEN 'conversation' THEN 2
         WHEN 'actor_global' THEN 3
         WHEN 'actor_conversation' THEN 4
         WHEN 'user' THEN 5
         ELSE 99
       END,
       is_default DESC,
       name`,
    [workspaceId],
  );
  return result.rows.map(mapRouteToGroup);
}

export async function getModelGroup(groupId: string) {
  const routeResult = await query(
    `SELECT * FROM model_routes WHERE id = $1 LIMIT 1`,
    [groupId],
  );
  if (routeResult.rows.length === 0) throw new ModelGroupError(404, 'Model route not found');

  const itemsResult = await query(
    `SELECT
        ri.*,
        b.display_name,
        b.current_revision_id,
        r.version,
        r.provider_type,
        r.base_url,
        r.model_name,
        r.max_tokens,
        r.capability_tags,
        r.extra_config,
        r.request_timeout_ms,
        r.max_retries
     FROM model_route_items ri
     JOIN model_bindings b ON b.id = ri.binding_id
     LEFT JOIN model_binding_revisions r ON r.id = b.current_revision_id
     WHERE ri.route_id = $1
     ORDER BY ri.priority ASC, b.display_name`,
    [groupId],
  );

  return {
    ...mapRouteToGroup(routeResult.rows[0]),
    items: itemsResult.rows.map(mapRouteItem),
  };
}

export async function createModelGroup(data: {
  workspaceId?: string;
  name: string;
  description?: string;
  routingStrategy?: string;
  attemptPolicy?: JsonMap;
  isDefault?: boolean;
  createdBy?: string;
}) {
  const routeScope = data.workspaceId ? 'workspace' : 'platform';

  if (data.isDefault) {
    await clearExistingDefault(routeScope, data.workspaceId);
  }

  const result = await query(
    `INSERT INTO model_routes (
       workspace_id, route_scope, name, description, routing_strategy, attempt_policy,
       is_default, is_enabled, created_by, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, '{}'::jsonb)
     RETURNING *`,
    [
      data.workspaceId || null,
      routeScope,
      data.name,
      data.description || '',
      data.routingStrategy || 'priority_failover',
      JSON.stringify(data.attemptPolicy || {}),
      data.isDefault || false,
      data.createdBy || null,
    ],
  );

  const route = mapRouteToGroup(result.rows[0]);
  if (data.isDefault) {
    await setDefaultRoute(route.id, routeScope, data.workspaceId);
  }
  return route;
}

export async function updateModelGroup(groupId: string, data: {
  name?: string;
  description?: string;
  routingStrategy?: string;
  attemptPolicy?: JsonMap;
  isDefault?: boolean;
  isActive?: boolean;
}) {
  const route = await resolveDefaultRouteScope(groupId);

  if (data.isDefault === true) {
    if (route.route_scope !== 'platform' && route.route_scope !== 'workspace') {
      throw new ModelGroupError(400, 'Only platform or workspace routes can be default routes');
    }
    await clearExistingDefault(route.route_scope, route.workspace_id || undefined);
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (data.name !== undefined) {
    sets.push(`name = $${idx++}`);
    values.push(data.name);
  }
  if (data.description !== undefined) {
    sets.push(`description = $${idx++}`);
    values.push(data.description);
  }
  if (data.routingStrategy !== undefined) {
    sets.push(`routing_strategy = $${idx++}`);
    values.push(data.routingStrategy);
  }
  if (data.attemptPolicy !== undefined) {
    sets.push(`attempt_policy = $${idx++}`);
    values.push(JSON.stringify(data.attemptPolicy));
  }
  if (data.isDefault !== undefined) {
    sets.push(`is_default = $${idx++}`);
    values.push(data.isDefault);
  }
  if (data.isActive !== undefined) {
    sets.push(`is_enabled = $${idx++}`);
    values.push(data.isActive);
  }

  if (sets.length === 0) {
    return getModelGroup(groupId);
  }

  sets.push(`updated_at = NOW()`);
  values.push(groupId);
  const result = await query(
    `UPDATE model_routes
     SET ${sets.join(', ')}
     WHERE id = $${idx}
     RETURNING *`,
    values,
  );

  if (result.rows.length === 0) throw new ModelGroupError(404, 'Model route not found');
  const updated = mapRouteToGroup(result.rows[0]);
  if (data.isDefault === true && (route.route_scope === 'platform' || route.route_scope === 'workspace')) {
    await setDefaultRoute(updated.id, route.route_scope, route.workspace_id || undefined);
  }
  return updated;
}

export async function deleteModelGroup(groupId: string) {
  await query(
    `UPDATE model_routes
     SET is_enabled = FALSE, updated_at = NOW()
     WHERE id = $1`,
    [groupId],
  );
}

export async function addModelItem(groupId: string, data: {
  displayName: string;
  priority?: number;
  weight?: number;
  providerType: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  maxTokens?: number;
  capabilityTags?: string[];
  extraConfig?: JsonMap;
  requestTimeoutMs?: number;
  maxRetries?: number;
}) {
  const routeResult = await query(
    `SELECT * FROM model_routes WHERE id = $1 LIMIT 1`,
    [groupId],
  );
  if (routeResult.rows.length === 0) throw new ModelGroupError(404, 'Model route not found');
  const route = routeResult.rows[0];

  const bindingResult = await query(
    `INSERT INTO model_bindings (
       workspace_id, binding_scope, conversation_id, actor_id, user_id,
       display_name, is_enabled, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, '{}'::jsonb)
     RETURNING *`,
    [
      route.workspace_id || null,
      route.route_scope,
      route.conversation_id || null,
      route.actor_id || null,
      route.user_id || null,
      data.displayName,
    ],
  );
  const binding = bindingResult.rows[0];

  const revision = await createBindingRevision({
    bindingId: binding.id,
    version: 1,
    providerType: data.providerType,
    apiKey: data.apiKey,
    baseUrl: data.baseUrl,
    modelName: data.modelName,
    maxTokens: data.maxTokens,
    capabilityTags: data.capabilityTags,
    extraConfig: data.extraConfig,
    requestTimeoutMs: data.requestTimeoutMs,
    maxRetries: data.maxRetries,
  });

  await query(
    `UPDATE model_bindings
     SET current_revision_id = $1, updated_at = NOW()
     WHERE id = $2`,
    [revision.id, binding.id],
  );

  const routeItemResult = await query(
    `INSERT INTO model_route_items (
       route_id, binding_id, priority, weight, is_enabled, metadata
     )
     VALUES ($1, $2, $3, $4, TRUE, '{}'::jsonb)
     RETURNING *`,
    [groupId, binding.id, data.priority ?? 0, data.weight ?? 100],
  );

  return mapRouteItem({
    ...routeItemResult.rows[0],
    display_name: binding.display_name,
    current_revision_id: revision.id,
    version: revision.version,
    provider_type: revision.provider_type,
    base_url: revision.base_url,
    model_name: revision.model_name,
    max_tokens: revision.max_tokens,
    capability_tags: revision.capability_tags,
    extra_config: revision.extra_config,
    request_timeout_ms: revision.request_timeout_ms,
    max_retries: revision.max_retries,
  });
}

export async function updateModelItem(groupId: string, itemId: string, data: {
  displayName?: string;
  priority?: number;
  weight?: number;
  isEnabled?: boolean;
  providerType?: string;
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
  maxTokens?: number;
  capabilityTags?: string[];
  extraConfig?: JsonMap;
  requestTimeoutMs?: number;
  maxRetries?: number;
}) {
  const itemResult = await query(
    `SELECT
        ri.*,
        b.display_name,
        b.current_revision_id,
        b.id AS binding_id,
        r.version,
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
     JOIN model_bindings b ON b.id = ri.binding_id
     LEFT JOIN model_binding_revisions r ON r.id = b.current_revision_id
     WHERE ri.id = $1 AND ri.route_id = $2
     LIMIT 1`,
    [itemId, groupId],
  );
  if (itemResult.rows.length === 0) throw new ModelGroupError(404, 'Model route item not found');
  const item = itemResult.rows[0];

  const routeSets: string[] = [];
  const routeValues: unknown[] = [];
  let routeIdx = 1;

  if (data.priority !== undefined) {
    routeSets.push(`priority = $${routeIdx++}`);
    routeValues.push(data.priority);
  }
  if (data.weight !== undefined) {
    routeSets.push(`weight = $${routeIdx++}`);
    routeValues.push(data.weight);
  }
  if (data.isEnabled !== undefined) {
    routeSets.push(`is_enabled = $${routeIdx++}`);
    routeValues.push(data.isEnabled);
  }

  if (routeSets.length > 0) {
    routeSets.push(`updated_at = NOW()`);
    routeValues.push(itemId);
    await query(
      `UPDATE model_route_items
       SET ${routeSets.join(', ')}
       WHERE id = $${routeIdx}`,
      routeValues,
    );
  }

  if (data.displayName !== undefined) {
    await query(
      `UPDATE model_bindings
       SET display_name = $1, updated_at = NOW()
       WHERE id = $2`,
      [data.displayName, item.binding_id],
    );
  }

  const hasConfigChange =
    data.providerType !== undefined ||
    data.apiKey !== undefined ||
    data.baseUrl !== undefined ||
    data.modelName !== undefined ||
    data.maxTokens !== undefined ||
    data.capabilityTags !== undefined ||
    data.extraConfig !== undefined ||
    data.requestTimeoutMs !== undefined ||
    data.maxRetries !== undefined;

  if (hasConfigChange) {
    const nextVersion = Number(item.version || 0) + 1;
    const revision = await createBindingRevision({
      bindingId: item.binding_id,
      version: nextVersion,
      providerType: data.providerType || item.provider_type,
      apiKey: data.apiKey || item.api_key,
      baseUrl: data.baseUrl || item.base_url,
      modelName: data.modelName || item.model_name,
      maxTokens: data.maxTokens ?? item.max_tokens,
      capabilityTags: data.capabilityTags || item.capability_tags || [],
      extraConfig: data.extraConfig ?? asObject(item.extra_config),
      requestTimeoutMs: data.requestTimeoutMs ?? item.request_timeout_ms ?? undefined,
      maxRetries: data.maxRetries ?? item.max_retries ?? undefined,
    });
    await query(
      `UPDATE model_bindings
       SET current_revision_id = $1, updated_at = NOW()
       WHERE id = $2`,
      [revision.id, item.binding_id],
    );
  }

  const updatedResult = await query(
    `SELECT
        ri.*,
        b.display_name,
        b.current_revision_id,
        r.version,
        r.provider_type,
        r.base_url,
        r.model_name,
        r.max_tokens,
        r.capability_tags,
        r.extra_config,
        r.request_timeout_ms,
        r.max_retries
     FROM model_route_items ri
     JOIN model_bindings b ON b.id = ri.binding_id
     LEFT JOIN model_binding_revisions r ON r.id = b.current_revision_id
     WHERE ri.id = $1
     LIMIT 1`,
    [itemId],
  );
  return mapRouteItem(updatedResult.rows[0]);
}

export async function deleteModelItem(groupId: string, itemId: string) {
  await query(
    `UPDATE model_route_items
     SET is_enabled = FALSE, updated_at = NOW()
     WHERE id = $1 AND route_id = $2`,
    [itemId, groupId],
  );
}

export async function getItemVersions(itemId: string) {
  const itemResult = await query(
    `SELECT binding_id
     FROM model_route_items
     WHERE id = $1
     LIMIT 1`,
    [itemId],
  );
  if (itemResult.rows.length === 0) throw new ModelGroupError(404, 'Model route item not found');
  const bindingId = itemResult.rows[0].binding_id as string;

  const versions = await query(
    `SELECT
        r.id,
        r.binding_id AS item_id,
        r.version,
        r.provider_type,
        r.base_url,
        r.model_name,
        r.max_tokens,
        r.capability_tags,
        r.extra_config,
        r.request_timeout_ms,
        r.max_retries,
        r.created_at
     FROM model_binding_revisions r
     WHERE r.binding_id = $1
     ORDER BY r.version DESC`,
    [bindingId],
  );
  return versions.rows;
}

export async function getActorModelGroups(actorId: string) {
  const result = await query(
    `SELECT
        amr.actor_id,
        amr.route_id AS group_id,
        amr.priority,
        amr.created_at,
        mr.name AS group_name,
        mr.routing_strategy,
        mr.is_default,
        mr.workspace_id
     FROM actor_model_routes amr
     JOIN model_routes mr ON mr.id = amr.route_id
     WHERE amr.actor_id = $1
     ORDER BY amr.priority ASC`,
    [actorId],
  );
  return result.rows;
}

export async function setActorModelGroups(actorId: string, groups: { groupId: string; priority: number }[]) {
  await query(`DELETE FROM actor_model_routes WHERE actor_id = $1`, [actorId]);
  for (const group of groups) {
    await query(
      `INSERT INTO actor_model_routes (actor_id, route_id, priority)
       VALUES ($1, $2, $3)`,
      [actorId, group.groupId, group.priority],
    );
  }
  return getActorModelGroups(actorId);
}

export async function logAIRequest(data: {
  workspaceId?: string;
  actorId?: string;
  sessionId?: string;
  turnId?: string;
  round?: number;
  routeId?: string;
  bindingId?: string;
  revisionId?: string;
  requestType: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  status: string;
  errorMessage?: string;
  requestBody?: unknown;
  responseBody?: unknown;
}) {
  if (!data.turnId) {
    await logRuntimeEvent({
      workspaceId: data.workspaceId,
      sessionId: data.sessionId,
      actorId: data.actorId,
      source: 'provider',
      level: data.status === 'error' ? 'error' : 'info',
      eventType: 'provider.step.legacy',
      payload: {
        round: data.round || 1,
        requestType: data.requestType,
        modelRouteId: data.routeId,
        modelBindingId: data.bindingId,
        modelRevisionId: data.revisionId,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        latencyMs: data.latencyMs,
        status: data.status,
        errorMessage: data.errorMessage,
        requestBody: data.requestBody,
        responseBody: data.responseBody,
      },
    });
    return;
  }

  let providerType: 'anthropic' | 'openai' = config.ai.provider === 'openai' ? 'openai' : 'anthropic';
  let modelName = config.ai.model;
  if (data.revisionId) {
    const revisionResult = await query(
      `SELECT provider_type, model_name
       FROM model_binding_revisions
       WHERE id = $1
       LIMIT 1`,
      [data.revisionId],
    );
    if (revisionResult.rows[0]) {
      providerType = revisionResult.rows[0].provider_type === 'openai' ? 'openai' : 'anthropic';
      modelName = revisionResult.rows[0].model_name || modelName;
    }
  }

  await logProviderStep({
    turnId: data.turnId,
    stepIndex: data.round || 1,
    providerType,
    requestType: data.requestType as 'actor_think' | 'ai_complete',
    modelRouteId: data.routeId,
    modelBindingId: data.bindingId,
    modelRevisionId: data.revisionId,
    modelName,
    requestPayload: data.requestBody,
    responsePayload: data.responseBody,
    inputTokens: data.inputTokens,
    outputTokens: data.outputTokens,
    latencyMs: data.latencyMs,
    status: data.status as 'success' | 'error' | 'timeout',
    errorMessage: data.errorMessage,
  });
}

export async function seedPlatformDefaultGroup() {
  await ensurePlatformSettingsRow();

  const existing = await query(
    `SELECT ps.default_model_route_id
     FROM platform_settings ps
     WHERE ps.id = TRUE AND ps.default_model_route_id IS NOT NULL
     LIMIT 1`,
    [],
  );
  if (existing.rows[0]?.default_model_route_id) {
    return existing.rows[0].default_model_route_id as string;
  }

  const group = await createModelGroup({
    name: 'Platform Default',
    description: 'Auto-created from environment variables',
    routingStrategy: 'priority_failover',
    attemptPolicy: {
      maxAttemptsTotal: 4,
      maxAttemptsPerBinding: 2,
      timeoutMsPerAttempt: 30000,
      continueOn: ['timeout', '5xx', 'network', 'rate_limit'],
      stopOn: ['auth_error', 'bad_request', 'policy_block'],
      retryBackoffMs: [0, 1000, 3000],
    },
    isDefault: true,
  });

  if (config.ai.apiKey) {
    await addModelItem(group.id, {
      displayName: `${config.ai.model} (env)`,
      priority: 0,
      weight: 100,
      providerType: config.ai.provider,
      apiKey: config.ai.apiKey,
      baseUrl: config.ai.baseUrl,
      modelName: config.ai.model,
      maxTokens: config.ai.maxTokens,
      requestTimeoutMs: 30000,
      maxRetries: 1,
    });
  }

  return group.id;
}
