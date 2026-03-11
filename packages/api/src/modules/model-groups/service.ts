import { query } from '../../infrastructure/database/index.js';
import { config } from '../../config/index.js';
import { logProviderStep, logRuntimeEvent } from '../execution/service.js';

export class ModelGroupError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

// ============ Model Groups CRUD ============

export async function listModelGroups(workspaceId: string | null) {
  if (workspaceId) {
    // Return workspace groups + platform groups
    const result = await query(
      `SELECT * FROM model_groups
       WHERE (workspace_id = $1 OR workspace_id IS NULL) AND is_active = TRUE
       ORDER BY workspace_id NULLS LAST, is_default DESC, name`,
      [workspaceId]
    );
    return result.rows;
  }
  // Platform groups only
  const result = await query(
    `SELECT * FROM model_groups WHERE workspace_id IS NULL AND is_active = TRUE
     ORDER BY is_default DESC, name`,
    []
  );
  return result.rows;
}

export async function getModelGroup(groupId: string) {
  const result = await query('SELECT * FROM model_groups WHERE id = $1', [groupId]);
  if (result.rows.length === 0) throw new ModelGroupError(404, 'Model group not found');
  const group = result.rows[0];

  // Load items with current config
  const items = await query(
    `SELECT gi.*, mc.id as config_id, mc.version, mc.provider_type, mc.base_url,
            mc.model_name, mc.max_tokens, mc.input_token_cost_micros, mc.output_token_cost_micros,
            mc.capability_tags, mc.extra_config, mc.created_at as config_created_at
     FROM model_group_items gi
     LEFT JOIN model_item_configs mc ON mc.id = gi.current_config_id
     WHERE gi.group_id = $1
     ORDER BY gi.priority, gi.display_name`,
    [groupId]
  );

  return { ...group, items: items.rows };
}

export async function createModelGroup(data: {
  workspaceId?: string;
  name: string;
  description?: string;
  routingStrategy?: string;
  isDefault?: boolean;
  createdBy?: string;
}) {
  // If setting as default, unset existing default in same scope
  if (data.isDefault) {
    if (data.workspaceId) {
      await query(
        'UPDATE model_groups SET is_default = FALSE WHERE workspace_id = $1 AND is_default = TRUE',
        [data.workspaceId]
      );
    } else {
      await query(
        'UPDATE model_groups SET is_default = FALSE WHERE workspace_id IS NULL AND is_default = TRUE',
        []
      );
    }
  }

  const result = await query(
    `INSERT INTO model_groups (workspace_id, name, description, routing_strategy, is_default, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      data.workspaceId || null,
      data.name,
      data.description || '',
      data.routingStrategy || 'priority_failover',
      data.isDefault || false,
      data.createdBy || null,
    ]
  );
  return result.rows[0];
}

export async function updateModelGroup(groupId: string, data: {
  name?: string;
  description?: string;
  routingStrategy?: string;
  isDefault?: boolean;
  isActive?: boolean;
}) {
  const group = await query('SELECT * FROM model_groups WHERE id = $1', [groupId]);
  if (group.rows.length === 0) throw new ModelGroupError(404, 'Model group not found');

  // If setting as default, unset existing default in same scope
  if (data.isDefault === true) {
    const wsId = group.rows[0].workspace_id;
    if (wsId) {
      await query(
        'UPDATE model_groups SET is_default = FALSE WHERE workspace_id = $1 AND is_default = TRUE AND id != $2',
        [wsId, groupId]
      );
    } else {
      await query(
        'UPDATE model_groups SET is_default = FALSE WHERE workspace_id IS NULL AND is_default = TRUE AND id != $1',
        [groupId]
      );
    }
  }

  const sets: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (data.name !== undefined) { sets.push(`name = $${idx++}`); values.push(data.name); }
  if (data.description !== undefined) { sets.push(`description = $${idx++}`); values.push(data.description); }
  if (data.routingStrategy !== undefined) { sets.push(`routing_strategy = $${idx++}`); values.push(data.routingStrategy); }
  if (data.isDefault !== undefined) { sets.push(`is_default = $${idx++}`); values.push(data.isDefault); }
  if (data.isActive !== undefined) { sets.push(`is_active = $${idx++}`); values.push(data.isActive); }

  if (sets.length === 0) return group.rows[0];

  values.push(groupId);
  const result = await query(
    `UPDATE model_groups SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return result.rows[0];
}

export async function deleteModelGroup(groupId: string) {
  // Soft delete
  await query('UPDATE model_groups SET is_active = FALSE WHERE id = $1', [groupId]);
}

// ============ Model Group Items CRUD ============

export async function addModelItem(groupId: string, data: {
  displayName: string;
  priority?: number;
  weight?: number;
  providerType: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  maxTokens?: number;
  inputTokenCostMicros?: number;
  outputTokenCostMicros?: number;
  capabilityTags?: string[];
  extraConfig?: Record<string, unknown>;
}) {
  // Verify group exists
  const group = await query('SELECT id FROM model_groups WHERE id = $1', [groupId]);
  if (group.rows.length === 0) throw new ModelGroupError(404, 'Model group not found');

  // Create item
  const itemResult = await query(
    `INSERT INTO model_group_items (group_id, display_name, priority, weight)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [groupId, data.displayName, data.priority ?? 0, data.weight ?? 100]
  );
  const item = itemResult.rows[0];

  // Create first config version
  const configResult = await query(
    `INSERT INTO model_item_configs (item_id, version, provider_type, api_key, base_url, model_name, max_tokens,
       input_token_cost_micros, output_token_cost_micros, capability_tags, extra_config)
     VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      item.id,
      data.providerType,
      data.apiKey,
      data.baseUrl,
      data.modelName,
      data.maxTokens ?? 4096,
      data.inputTokenCostMicros ?? 0,
      data.outputTokenCostMicros ?? 0,
      data.capabilityTags || [],
      JSON.stringify(data.extraConfig || {}),
    ]
  );
  const cfg = configResult.rows[0];

  // Set current_config_id
  await query('UPDATE model_group_items SET current_config_id = $1 WHERE id = $2', [cfg.id, item.id]);

  return { ...item, current_config_id: cfg.id, currentConfig: cfg };
}

export async function updateModelItem(groupId: string, itemId: string, data: {
  displayName?: string;
  priority?: number;
  weight?: number;
  isEnabled?: boolean;
  // Config fields trigger new version
  providerType?: string;
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
  maxTokens?: number;
  inputTokenCostMicros?: number;
  outputTokenCostMicros?: number;
  capabilityTags?: string[];
  extraConfig?: Record<string, unknown>;
}) {
  const itemResult = await query(
    'SELECT * FROM model_group_items WHERE id = $1 AND group_id = $2',
    [itemId, groupId]
  );
  if (itemResult.rows.length === 0) throw new ModelGroupError(404, 'Model item not found');
  const item = itemResult.rows[0];

  // Update item metadata
  const metaSets: string[] = [];
  const metaVals: any[] = [];
  let mi = 1;
  if (data.displayName !== undefined) { metaSets.push(`display_name = $${mi++}`); metaVals.push(data.displayName); }
  if (data.priority !== undefined) { metaSets.push(`priority = $${mi++}`); metaVals.push(data.priority); }
  if (data.weight !== undefined) { metaSets.push(`weight = $${mi++}`); metaVals.push(data.weight); }
  if (data.isEnabled !== undefined) { metaSets.push(`is_enabled = $${mi++}`); metaVals.push(data.isEnabled); }

  if (metaSets.length > 0) {
    metaVals.push(itemId);
    await query(`UPDATE model_group_items SET ${metaSets.join(', ')} WHERE id = $${mi}`, metaVals);
  }

  // If config fields provided, create new version
  const hasConfigChange = data.providerType || data.apiKey || data.baseUrl || data.modelName || data.maxTokens !== undefined || data.extraConfig !== undefined;
  if (hasConfigChange) {
    // Get current config to use as base
    let base: any = {};
    if (item.current_config_id) {
      const baseResult = await query('SELECT * FROM model_item_configs WHERE id = $1', [item.current_config_id]);
      if (baseResult.rows.length > 0) base = baseResult.rows[0];
    }

    // Get next version
    const maxVer = await query('SELECT COALESCE(MAX(version), 0) as max_ver FROM model_item_configs WHERE item_id = $1', [itemId]);
    const newVersion = (maxVer.rows[0].max_ver || 0) + 1;

    const configResult = await query(
      `INSERT INTO model_item_configs (item_id, version, provider_type, api_key, base_url, model_name, max_tokens,
         input_token_cost_micros, output_token_cost_micros, capability_tags, extra_config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        itemId,
        newVersion,
        data.providerType || base.provider_type || 'anthropic',
        data.apiKey || base.api_key || '',
        data.baseUrl || base.base_url || '',
        data.modelName || base.model_name || '',
        data.maxTokens ?? base.max_tokens ?? 4096,
        data.inputTokenCostMicros ?? base.input_token_cost_micros ?? 0,
        data.outputTokenCostMicros ?? base.output_token_cost_micros ?? 0,
        data.capabilityTags || base.capability_tags || [],
        JSON.stringify(data.extraConfig || base.extra_config || {}),
      ]
    );

    await query('UPDATE model_group_items SET current_config_id = $1 WHERE id = $2', [configResult.rows[0].id, itemId]);
  }

  // Return updated item
  const updated = await query(
    `SELECT gi.*, mc.id as config_id, mc.version, mc.provider_type, mc.base_url,
            mc.model_name, mc.max_tokens, mc.capability_tags, mc.extra_config
     FROM model_group_items gi
     LEFT JOIN model_item_configs mc ON mc.id = gi.current_config_id
     WHERE gi.id = $1`,
    [itemId]
  );
  return updated.rows[0];
}

export async function deleteModelItem(groupId: string, itemId: string) {
  // Disable instead of hard delete
  await query(
    'UPDATE model_group_items SET is_enabled = FALSE WHERE id = $1 AND group_id = $2',
    [itemId, groupId]
  );
}

export async function getItemVersions(itemId: string) {
  const result = await query(
    `SELECT id, item_id, version, provider_type, base_url, model_name, max_tokens,
            input_token_cost_micros, output_token_cost_micros, capability_tags, created_at
     FROM model_item_configs WHERE item_id = $1 ORDER BY version DESC`,
    [itemId]
  );
  return result.rows;
}

// ============ Actor Model Groups ============

export async function getActorModelGroups(actorId: string) {
  const result = await query(
    `SELECT amg.*, mg.name as group_name, mg.routing_strategy, mg.is_default, mg.workspace_id
     FROM actor_model_groups amg
     JOIN model_groups mg ON mg.id = amg.group_id
     WHERE amg.actor_id = $1
     ORDER BY amg.priority`,
    [actorId]
  );
  return result.rows;
}

export async function setActorModelGroups(actorId: string, groups: { groupId: string; priority: number }[]) {
  // Replace all assignments
  await query('DELETE FROM actor_model_groups WHERE actor_id = $1', [actorId]);

  for (const g of groups) {
    await query(
      'INSERT INTO actor_model_groups (actor_id, group_id, priority) VALUES ($1, $2, $3)',
      [actorId, g.groupId, g.priority]
    );
  }

  return getActorModelGroups(actorId);
}

// ============ AI Request Logging ============

export async function logAIRequest(data: {
  workspaceId?: string;
  actorId?: string;
  sessionId?: string;
  turnId?: string;
  round?: number;
  groupId?: string;
  itemId?: string;
  configId?: string;
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
        modelGroupId: data.groupId,
        modelItemId: data.itemId,
        modelConfigId: data.configId,
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
  if (data.configId) {
    const configResult = await query(
      `SELECT provider_type, model_name FROM model_item_configs WHERE id = $1`,
      [data.configId],
    );
    if (configResult.rows[0]) {
      providerType = configResult.rows[0].provider_type === 'openai' ? 'openai' : 'anthropic';
      modelName = configResult.rows[0].model_name || modelName;
    }
  }

  await logProviderStep({
    turnId: data.turnId,
    stepIndex: data.round || 1,
    providerType,
    requestType: data.requestType as 'actor_think' | 'ai_complete',
    modelGroupId: data.groupId,
    modelItemId: data.itemId,
    modelConfigId: data.configId,
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

// ============ Seed Platform Default ============

export async function seedPlatformDefaultGroup() {
  // Check if platform default already exists
  const existing = await query(
    'SELECT id FROM model_groups WHERE workspace_id IS NULL AND is_default = TRUE AND is_active = TRUE',
    []
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  // Create platform default group from env config
  const group = await createModelGroup({
    name: 'Platform Default',
    description: 'Auto-created from environment variables',
    routingStrategy: 'priority_failover',
    isDefault: true,
  });

  // Add the env-configured model as an item
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
    });
  }

  return group.id;
}
