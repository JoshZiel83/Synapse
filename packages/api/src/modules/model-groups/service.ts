import { config } from '../../config/index.js';
import { query } from '../../infrastructure/database/index.js';
import {
  DEFAULT_MODEL_ATTEMPT_POLICY,
  DEFAULT_MODEL_ATTEMPT_TIMEOUT_MS,
} from './defaults.js';
import {
  AUTHZ_PLATFORM_ID,
  authzEnabled,
  buildWorkspaceUserContextId,
  diffAuthzRelationships,
  enqueueAuthzRelationships,
  flushAuthzOutboxEntries,
  touchRelation,
  touchWorkspaceUserContext,
  type AuthzRelationMutation,
} from '../../infrastructure/authz/index.js';
import { logProviderStep, logRuntimeEvent } from '../execution/service.js';

type JsonMap = Record<string, unknown>;
type ModelGroupOwnerType = 'platform' | 'workspace' | 'user';
type ModelGroupGrantScope = 'platform' | 'workspace' | 'user' | 'workspace_user' | 'actor';

type ModelGroupRow = {
  id: string;
  owner_type: ModelGroupOwnerType;
  owner_workspace_id: string | null;
  owner_user_id: string | null;
  name: string;
  description: string | null;
  routing_strategy: 'weighted_random' | 'round_robin' | 'priority_failover';
  attempt_policy: Record<string, unknown> | null;
  is_default: boolean;
  is_enabled: boolean;
  created_by: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type ModelGroupGrantRow = {
  id?: string;
  group_id?: string;
  grant_scope: ModelGroupGrantScope;
  workspace_id: string | null;
  user_id: string | null;
  actor_id: string | null;
  status: 'active' | 'revoked';
  granted_by?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
  revoked_at?: string | null;
};

type ModelGroupAuthzState = {
  id: string;
  owner_type: ModelGroupOwnerType;
  owner_workspace_id: string | null;
  owner_user_id: string | null;
  is_enabled: boolean;
  grants: ModelGroupGrantRow[];
};

type ModelProfileRelationState = {
  profileId: string;
  groupId: string;
  isEnabled: boolean;
};

export class ModelGroupError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

function asObject(value: unknown): JsonMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonMap;
}

async function flushQueuedAuthzEntries(entryIds: string[], source: string) {
  if (entryIds.length === 0) return;

  try {
    await flushAuthzOutboxEntries(entryIds);
  } catch (error) {
    console.error(`[authz] Failed to flush ${source} relationship updates:`, error);
  }
}

function buildModelGroupGrantRelations(groupId: string, grant: ModelGroupGrantRow): AuthzRelationMutation[] {
  switch (grant.grant_scope) {
    case 'platform':
      return [touchRelation('model_group', groupId, 'use_platform', 'platform', AUTHZ_PLATFORM_ID)];
    case 'workspace':
      return grant.workspace_id
        ? [touchRelation('model_group', groupId, 'use_workspace', 'workspace', grant.workspace_id)]
        : [];
    case 'user':
      return grant.user_id
        ? [touchRelation('model_group', groupId, 'use_principal', 'user', grant.user_id)]
        : [];
    case 'workspace_user':
      return grant.workspace_id && grant.user_id
        ? [
            ...touchWorkspaceUserContext(grant.workspace_id, grant.user_id),
            touchRelation(
              'model_group',
              groupId,
              'use_workspace_user',
              'workspace_user',
              buildWorkspaceUserContextId(grant.workspace_id, grant.user_id),
            ),
          ]
        : [];
    case 'actor':
      return grant.actor_id
        ? [touchRelation('model_group', groupId, 'use_actor', 'actor', grant.actor_id)]
        : [];
    default:
      return [];
  }
}

function buildModelGroupAuthzRelations(group: ModelGroupAuthzState): AuthzRelationMutation[] {
  const ownerRelations =
    group.owner_type === 'platform'
      ? [touchRelation('model_group', group.id, 'owner_platform', 'platform', AUTHZ_PLATFORM_ID)]
      : group.owner_type === 'workspace' && group.owner_workspace_id
        ? [touchRelation('model_group', group.id, 'owner_workspace', 'workspace', group.owner_workspace_id)]
        : group.owner_type === 'user' && group.owner_user_id
          ? [touchRelation('model_group', group.id, 'owner_user', 'user', group.owner_user_id)]
          : [];

  return [
    ...ownerRelations,
    ...(group.is_enabled
      ? group.grants
          .filter((grant) => grant.status === 'active')
          .flatMap((grant) => buildModelGroupGrantRelations(group.id, grant))
      : []),
  ];
}

function buildModelProfileAuthzRelations(state: ModelProfileRelationState): AuthzRelationMutation[] {
  if (!state.isEnabled) {
    return [];
  }
  return [touchRelation('model_profile', state.profileId, 'group', 'model_group', state.groupId)];
}

function mapGroupRow(row: ModelGroupRow) {
  return {
    id: row.id,
    owner_type: row.owner_type,
    owner_workspace_id: row.owner_workspace_id,
    owner_user_id: row.owner_user_id,
    workspace_id: row.owner_workspace_id,
    scope: row.owner_type,
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

function mapGroupItem(row: any) {
  return {
    id: row.item_id ?? row.id,
    group_id: row.group_id,
    profile_id: row.profile_id,
    current_revision_id: row.current_revision_id || null,
    display_name: row.display_name,
    priority: row.priority,
    weight: row.weight,
    is_enabled: Boolean(row.item_enabled ?? row.is_enabled),
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

function mapGrantRow(row: ModelGroupGrantRow & { id: string; group_id: string }) {
  return {
    id: row.id,
    group_id: row.group_id,
    grant_scope: row.grant_scope,
    workspace_id: row.workspace_id,
    user_id: row.user_id,
    actor_id: row.actor_id,
    status: row.status,
    granted_by: row.granted_by || null,
    reason: row.reason || null,
    metadata: asObject(row.metadata),
    created_at: row.created_at || null,
    revoked_at: row.revoked_at || null,
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

async function clearExistingDefault(ownerType: ModelGroupOwnerType, ownerWorkspaceId?: string | null, ownerUserId?: string | null) {
  if (ownerType === 'platform') {
    await query(
      `UPDATE model_groups
       SET is_default = FALSE
       WHERE owner_type = 'platform' AND is_default = TRUE`,
      [],
    );
    await ensurePlatformSettingsRow();
    return;
  }

  if (ownerType === 'workspace') {
    if (!ownerWorkspaceId) {
      throw new ModelGroupError(400, 'ownerWorkspaceId is required for workspace defaults');
    }
    await query(
      `UPDATE model_groups
       SET is_default = FALSE
       WHERE owner_type = 'workspace'
         AND owner_workspace_id = $1
         AND is_default = TRUE`,
      [ownerWorkspaceId],
    );
    return;
  }

  if (!ownerUserId) {
    throw new ModelGroupError(400, 'ownerUserId is required for user defaults');
  }
  await query(
    `UPDATE model_groups
     SET is_default = FALSE
     WHERE owner_type = 'user'
       AND owner_user_id = $1
       AND is_default = TRUE`,
    [ownerUserId],
  );
}

async function setDefaultGroup(groupId: string, ownerType: ModelGroupOwnerType, ownerWorkspaceId?: string | null) {
  if (ownerType === 'platform') {
    await ensurePlatformSettingsRow();
    await query(
      `UPDATE platform_settings
       SET default_model_group_id = $1, updated_at = NOW()
       WHERE id = TRUE`,
      [groupId],
    );
    return;
  }

  if (ownerType === 'workspace') {
    if (!ownerWorkspaceId) {
      throw new ModelGroupError(400, 'ownerWorkspaceId is required for workspace defaults');
    }
    await query(
      `UPDATE workspaces
       SET default_model_group_id = $1, updated_at = NOW()
       WHERE id = $2`,
      [groupId, ownerWorkspaceId],
    );
  }
}

async function clearDefaultGroupPointer(groupId: string, ownerType: ModelGroupOwnerType, ownerWorkspaceId?: string | null) {
  if (ownerType === 'platform') {
    await ensurePlatformSettingsRow();
    await query(
      `UPDATE platform_settings
       SET default_model_group_id = NULL, updated_at = NOW()
       WHERE id = TRUE AND default_model_group_id = $1`,
      [groupId],
    );
    return;
  }

  if (ownerType === 'workspace' && ownerWorkspaceId) {
    await query(
      `UPDATE workspaces
       SET default_model_group_id = NULL, updated_at = NOW()
       WHERE id = $1 AND default_model_group_id = $2`,
      [ownerWorkspaceId, groupId],
    );
  }
}

async function getGroupRow(groupId: string) {
  const result = await query<ModelGroupRow>(
    `SELECT *
     FROM model_groups
     WHERE id = $1
     LIMIT 1`,
    [groupId],
  );
  if (result.rows.length === 0) {
    throw new ModelGroupError(404, 'Model group not found');
  }
  return result.rows[0];
}

async function listActiveGroupGrants(groupIds: string[]) {
  if (groupIds.length === 0) return new Map<string, ModelGroupGrantRow[]>();

  const result = await query<ModelGroupGrantRow & { group_id: string }>(
    `SELECT *
     FROM model_group_grants
     WHERE status = 'active'
       AND group_id = ANY($1)`,
    [groupIds],
  );

  const byGroup = new Map<string, ModelGroupGrantRow[]>();
  for (const row of result.rows) {
    const bucket = byGroup.get(row.group_id) || [];
    bucket.push(row);
    byGroup.set(row.group_id, bucket);
  }
  return byGroup;
}

async function loadGroupAuthzState(groupId: string) {
  const group = await getGroupRow(groupId);
  const grants = (await listActiveGroupGrants([groupId])).get(groupId) || [];
  return {
    id: group.id,
    owner_type: group.owner_type,
    owner_workspace_id: group.owner_workspace_id,
    owner_user_id: group.owner_user_id,
    is_enabled: Boolean(group.is_enabled),
    grants,
  } satisfies ModelGroupAuthzState;
}

async function listProfileRelationStates(groupId: string) {
  const result = await query(
    `SELECT
        mp.id AS profile_id,
        mgp.group_id,
        (mg.is_enabled = TRUE AND mgp.is_enabled = TRUE AND mp.is_enabled = TRUE) AS relation_enabled
     FROM model_group_profiles mgp
     JOIN model_groups mg ON mg.id = mgp.group_id
     JOIN model_profiles mp ON mp.id = mgp.profile_id
     WHERE mgp.group_id = $1`,
    [groupId],
  );

  return result.rows.map((row) => ({
    profileId: row.profile_id as string,
    groupId: row.group_id as string,
    isEnabled: row.relation_enabled === true,
  }));
}

async function createProfileRevision(input: {
  profileId: string;
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
    `INSERT INTO model_profile_revisions (
       profile_id, version, provider_type, api_key, base_url, model_name,
       max_tokens, capability_tags, extra_config, request_timeout_ms, max_retries, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '{}'::jsonb)
     RETURNING *`,
    [
      input.profileId,
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

async function createDefaultGroupGrant(
  groupId: string,
  ownerType: ModelGroupOwnerType,
  ownerWorkspaceId?: string | null,
  ownerUserId?: string | null,
  grantedBy?: string | null,
) {
  const result = await query(
    `INSERT INTO model_group_grants (
       group_id, grant_scope, workspace_id, user_id, actor_id,
       status, granted_by, reason, metadata
     )
     VALUES ($1, $2, $3, $4, NULL, 'active', $5, 'default_group_scope', '{}'::jsonb)
     RETURNING *`,
    [
      groupId,
      ownerType === 'platform' ? 'platform' : ownerType === 'workspace' ? 'workspace' : 'user',
      ownerType === 'workspace' ? ownerWorkspaceId || null : null,
      ownerType === 'user' ? ownerUserId || null : null,
      grantedBy || null,
    ],
  );
  return result.rows[0] as ModelGroupGrantRow;
}

async function ensureWorkspaceExists(workspaceId: string) {
  const result = await query(
    `SELECT 1
     FROM workspaces
     WHERE id = $1
     LIMIT 1`,
    [workspaceId],
  );
  if (result.rows.length === 0) {
    throw new ModelGroupError(404, 'Workspace not found');
  }
}

async function ensureUserExists(userId: string) {
  const result = await query(
    `SELECT 1
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId],
  );
  if (result.rows.length === 0) {
    throw new ModelGroupError(404, 'User not found');
  }
}

async function ensureWorkspaceMember(workspaceId: string, userId: string) {
  const result = await query(
    `SELECT 1
     FROM workspace_members
     WHERE workspace_id = $1
       AND user_id = $2
     LIMIT 1`,
    [workspaceId, userId],
  );
  if (result.rows.length === 0) {
    throw new ModelGroupError(400, 'User is not a member of the target workspace');
  }
}

async function ensureActorInWorkspace(actorId: string, workspaceId: string) {
  const result = await query(
    `SELECT id
     FROM actors
     WHERE id = $1
       AND workspace_id = $2
     LIMIT 1`,
    [actorId, workspaceId],
  );
  if (result.rows.length === 0) {
    throw new ModelGroupError(404, 'Actor not found');
  }
}

async function validateGrantTarget(input: {
  grantScope: ModelGroupGrantScope;
  workspaceId?: string;
  userId?: string;
  actorId?: string;
}) {
  switch (input.grantScope) {
    case 'platform':
      return;
    case 'workspace':
      if (!input.workspaceId) {
        throw new ModelGroupError(400, 'workspaceId is required for workspace grants');
      }
      await ensureWorkspaceExists(input.workspaceId);
      return;
    case 'user':
      if (!input.userId) {
        throw new ModelGroupError(400, 'userId is required for user grants');
      }
      await ensureUserExists(input.userId);
      return;
    case 'workspace_user':
      if (!input.workspaceId || !input.userId) {
        throw new ModelGroupError(400, 'workspaceId and userId are required for workspace_user grants');
      }
      await ensureWorkspaceExists(input.workspaceId);
      await ensureWorkspaceMember(input.workspaceId, input.userId);
      return;
    case 'actor':
      if (!input.workspaceId || !input.actorId) {
        throw new ModelGroupError(400, 'workspaceId and actorId are required for actor grants');
      }
      await ensureWorkspaceExists(input.workspaceId);
      await ensureActorInWorkspace(input.actorId, input.workspaceId);
      return;
    default:
      return;
  }
}

async function ensureNoDuplicateActiveGrant(groupId: string, input: {
  grantScope: ModelGroupGrantScope;
  workspaceId?: string;
  userId?: string;
  actorId?: string;
}) {
  const result = await query(
    `SELECT 1
     FROM model_group_grants
     WHERE group_id = $1
       AND status = 'active'
       AND grant_scope = $2
       AND workspace_id IS NOT DISTINCT FROM $3::uuid
       AND user_id IS NOT DISTINCT FROM $4::uuid
       AND actor_id IS NOT DISTINCT FROM $5::uuid
     LIMIT 1`,
    [groupId, input.grantScope, input.workspaceId || null, input.userId || null, input.actorId || null],
  );
  if (result.rows.length > 0) {
    throw new ModelGroupError(409, 'An identical active grant already exists');
  }
}

export async function listPlatformModelGroups() {
  const result = await query<ModelGroupRow>(
    `SELECT *
     FROM model_groups
     WHERE owner_type = 'platform'
       AND is_enabled = TRUE
     ORDER BY is_default DESC, name`,
    [],
  );
  return result.rows.map(mapGroupRow);
}

export async function listWorkspaceModelGroups(workspaceId: string) {
  const result = await query<ModelGroupRow & { owner_rank: number }>(
    `SELECT DISTINCT
        mg.*,
        CASE mg.owner_type
          WHEN 'workspace' THEN 0
          WHEN 'platform' THEN 1
          ELSE 2
        END AS owner_rank
     FROM model_groups mg
     LEFT JOIN model_group_grants mgg
       ON mgg.group_id = mg.id
      AND mgg.status = 'active'
     WHERE mg.is_enabled = TRUE
       AND (
         (mg.owner_type = 'workspace' AND mg.owner_workspace_id = $1)
         OR (mgg.grant_scope = 'platform')
       OR (mgg.grant_scope = 'workspace' AND mgg.workspace_id = $1)
       OR (mgg.grant_scope = 'workspace_user' AND mgg.workspace_id = $1)
       OR (mgg.grant_scope = 'actor' AND mgg.workspace_id = $1)
       )
     ORDER BY
       owner_rank,
       mg.is_default DESC,
       mg.name`,
    [workspaceId],
  );
  return result.rows.map(mapGroupRow);
}

export async function listUserOwnedModelGroups(userId: string) {
  const result = await query<ModelGroupRow>(
    `SELECT *
     FROM model_groups
     WHERE owner_type = 'user'
       AND owner_user_id = $1
       AND is_enabled = TRUE
     ORDER BY is_default DESC, name`,
    [userId],
  );
  return result.rows.map(mapGroupRow);
}

export async function listModelGroups(workspaceId: string | null) {
  return workspaceId ? listWorkspaceModelGroups(workspaceId) : listPlatformModelGroups();
}

export async function getModelGroup(groupId: string) {
  const group = await getGroupRow(groupId);

  const [itemsResult, grantsResult] = await Promise.all([
    query(
      `SELECT
          mgp.id AS item_id,
          mgp.group_id,
          mgp.priority,
          mgp.weight,
          mgp.is_enabled AS item_enabled,
          mgp.created_at,
          mgp.updated_at,
          mp.id AS profile_id,
          mp.display_name,
          mp.current_revision_id,
          r.version,
          r.provider_type,
          r.base_url,
          r.model_name,
          r.max_tokens,
          r.capability_tags,
          r.extra_config,
          r.request_timeout_ms,
          r.max_retries
       FROM model_group_profiles mgp
       JOIN model_profiles mp ON mp.id = mgp.profile_id
       LEFT JOIN model_profile_revisions r ON r.id = mp.current_revision_id
       WHERE mgp.group_id = $1
       ORDER BY mgp.priority ASC, mp.display_name`,
      [groupId],
    ),
    query<ModelGroupGrantRow & { id: string; group_id: string }>(
      `SELECT *
       FROM model_group_grants
       WHERE group_id = $1
       ORDER BY created_at DESC`,
      [groupId],
    ),
  ]);

  return {
    ...mapGroupRow(group),
    items: itemsResult.rows.map(mapGroupItem),
    grants: grantsResult.rows.map(mapGrantRow),
  };
}

export async function isModelGroupAvailableInWorkspace(groupId: string, workspaceId: string) {
  const result = await query(
    `SELECT 1
     FROM model_groups mg
     LEFT JOIN model_group_grants mgg
       ON mgg.group_id = mg.id
      AND mgg.status = 'active'
     WHERE mg.id = $1
       AND mg.is_enabled = TRUE
       AND (
         (mg.owner_type = 'workspace' AND mg.owner_workspace_id = $2)
         OR (mgg.grant_scope = 'platform')
         OR (mgg.grant_scope = 'workspace' AND mgg.workspace_id = $2)
         OR (mgg.grant_scope = 'workspace_user' AND mgg.workspace_id = $2)
         OR (mgg.grant_scope = 'actor' AND mgg.workspace_id = $2)
       )
     LIMIT 1`,
    [groupId, workspaceId],
  );
  return result.rows.length > 0;
}

export async function createModelGroup(data: {
  ownerType?: ModelGroupOwnerType;
  workspaceId?: string;
  ownerUserId?: string;
  name: string;
  description?: string;
  routingStrategy?: string;
  attemptPolicy?: JsonMap;
  isDefault?: boolean;
  createdBy?: string;
}) {
  const ownerType = data.ownerType || (data.workspaceId ? 'workspace' : data.ownerUserId ? 'user' : 'platform');

  if (ownerType === 'workspace' && !data.workspaceId) {
    throw new ModelGroupError(400, 'workspaceId is required for workspace-owned groups');
  }
  if (ownerType === 'user' && !data.ownerUserId) {
    throw new ModelGroupError(400, 'ownerUserId is required for user-owned groups');
  }

  if (data.isDefault) {
    await clearExistingDefault(ownerType, data.workspaceId || null, data.ownerUserId || null);
  }

  const result = await query<ModelGroupRow>(
    `INSERT INTO model_groups (
       owner_type, owner_workspace_id, owner_user_id, name, description, routing_strategy,
       attempt_policy, is_default, is_enabled, created_by, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9, '{}'::jsonb)
     RETURNING *`,
    [
      ownerType,
      ownerType === 'workspace' ? data.workspaceId || null : null,
      ownerType === 'user' ? data.ownerUserId || null : null,
      data.name,
      data.description || '',
      data.routingStrategy || 'priority_failover',
      JSON.stringify(data.attemptPolicy || {}),
      data.isDefault || false,
      data.createdBy || null,
    ],
  );

  const row = result.rows[0];
  const defaultGrant = await createDefaultGroupGrant(
    row.id,
    row.owner_type,
    row.owner_workspace_id,
    row.owner_user_id,
    data.createdBy || null,
  );

  if (data.isDefault) {
    await setDefaultGroup(row.id, row.owner_type, row.owner_workspace_id);
  }

  const authzEntryIds = await enqueueAuthzRelationships(
    buildModelGroupAuthzRelations({
      id: row.id,
      owner_type: row.owner_type,
      owner_workspace_id: row.owner_workspace_id,
      owner_user_id: row.owner_user_id,
      is_enabled: Boolean(row.is_enabled),
      grants: [defaultGrant],
    }),
    {
      source: 'model_group.create',
      groupId: row.id,
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, 'model_group.create');

  return mapGroupRow(row);
}

export async function updateModelGroup(groupId: string, data: {
  name?: string;
  description?: string;
  routingStrategy?: string;
  attemptPolicy?: JsonMap;
  isDefault?: boolean;
  isActive?: boolean;
}) {
  const previousState = await loadGroupAuthzState(groupId);

  if (data.isDefault === true) {
    await clearExistingDefault(
      previousState.owner_type,
      previousState.owner_workspace_id,
      previousState.owner_user_id,
    );
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

  const result = await query<ModelGroupRow>(
    `UPDATE model_groups
     SET ${sets.join(', ')}
     WHERE id = $${idx}
     RETURNING *`,
    values,
  );
  if (result.rows.length === 0) {
    throw new ModelGroupError(404, 'Model group not found');
  }

  const updatedRow = result.rows[0];
  if (data.isDefault === true) {
    if (updatedRow.is_enabled) {
      await setDefaultGroup(updatedRow.id, updatedRow.owner_type, updatedRow.owner_workspace_id);
    } else {
      await clearDefaultGroupPointer(updatedRow.id, updatedRow.owner_type, updatedRow.owner_workspace_id);
    }
  } else if ((data.isDefault === false || data.isActive === false) && previousState.grants.length > 0) {
    await clearDefaultGroupPointer(updatedRow.id, updatedRow.owner_type, updatedRow.owner_workspace_id);
  }

  const nextState = await loadGroupAuthzState(groupId);
  const authzEntryIds = await enqueueAuthzRelationships(
    diffAuthzRelationships(
      buildModelGroupAuthzRelations(previousState),
      buildModelGroupAuthzRelations(nextState),
    ),
    {
      source: 'model_group.update',
      groupId,
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, 'model_group.update');

  const previousProfileStates = await listProfileRelationStates(groupId);
  if (data.isActive !== undefined) {
    const nextProfileStates = await listProfileRelationStates(groupId);
    const profileEntryIds = await enqueueAuthzRelationships(
      previousProfileStates.flatMap((state) =>
        diffAuthzRelationships(
          buildModelProfileAuthzRelations(state),
          buildModelProfileAuthzRelations(
            nextProfileStates.find((candidate) => candidate.profileId === state.profileId) || state,
          ),
        ),
      ),
      {
        source: 'model_group.profile_relations.update',
        groupId,
      },
    );
    await flushQueuedAuthzEntries(profileEntryIds, 'model_group.profile_relations.update');
  }

  return mapGroupRow(updatedRow);
}

export async function deleteModelGroup(groupId: string) {
  const previousGroupState = await loadGroupAuthzState(groupId);
  const previousProfileStates = await listProfileRelationStates(groupId);

  await query(
    `UPDATE model_groups
     SET is_enabled = FALSE, is_default = FALSE, updated_at = NOW()
     WHERE id = $1`,
    [groupId],
  );
  await query(
    `UPDATE model_group_profiles
     SET is_enabled = FALSE, updated_at = NOW()
     WHERE group_id = $1`,
    [groupId],
  );
  await query(
    `UPDATE model_profiles
     SET is_enabled = FALSE, updated_at = NOW()
     WHERE id IN (
       SELECT profile_id
       FROM model_group_profiles
       WHERE group_id = $1
     )`,
    [groupId],
  );
  await query(
    `DELETE FROM actor_model_group_assignments
     WHERE group_id = $1`,
    [groupId],
  );
  await clearDefaultGroupPointer(groupId, previousGroupState.owner_type, previousGroupState.owner_workspace_id);

  const nextGroupState = await loadGroupAuthzState(groupId);
  const nextProfileStates = await listProfileRelationStates(groupId);

  const groupEntryIds = await enqueueAuthzRelationships(
    diffAuthzRelationships(
      buildModelGroupAuthzRelations(previousGroupState),
      buildModelGroupAuthzRelations(nextGroupState),
    ),
    {
      source: 'model_group.delete',
      groupId,
    },
  );
  await flushQueuedAuthzEntries(groupEntryIds, 'model_group.delete');

  const profileEntryIds = await enqueueAuthzRelationships(
    previousProfileStates.flatMap((state) =>
      diffAuthzRelationships(
        buildModelProfileAuthzRelations(state),
        buildModelProfileAuthzRelations(
          nextProfileStates.find((candidate) => candidate.profileId === state.profileId) || state,
        ),
      ),
    ),
    {
      source: 'model_group.profile_relations.delete',
      groupId,
    },
  );
  await flushQueuedAuthzEntries(profileEntryIds, 'model_group.profile_relations.delete');
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
  installedBy?: string;
}) {
  const group = await getGroupRow(groupId);

  const profileResult = await query(
    `INSERT INTO model_profiles (
       workspace_id, display_name, is_enabled, installed_by, metadata
     )
     VALUES ($1, $2, TRUE, $3, '{}'::jsonb)
     RETURNING *`,
    [
      group.owner_type === 'workspace' ? group.owner_workspace_id : null,
      data.displayName,
      data.installedBy || group.created_by || null,
    ],
  );
  const profile = profileResult.rows[0];

  const revision = await createProfileRevision({
    profileId: profile.id as string,
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
    `UPDATE model_profiles
     SET current_revision_id = $1, updated_at = NOW()
     WHERE id = $2`,
    [revision.id, profile.id],
  );

  const itemResult = await query(
    `INSERT INTO model_group_profiles (
       group_id, profile_id, priority, weight, is_enabled, metadata
     )
     VALUES ($1, $2, $3, $4, TRUE, '{}'::jsonb)
     RETURNING *`,
    [groupId, profile.id, data.priority ?? 0, data.weight ?? 100],
  );

  const authzEntryIds = await enqueueAuthzRelationships(
    buildModelProfileAuthzRelations({
      profileId: profile.id as string,
      groupId,
      isEnabled: true,
    }),
    {
      source: 'model_profile.create',
      groupId,
      profileId: profile.id,
      profileRevisionId: revision.id,
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, 'model_profile.create');

  return mapGroupItem({
    ...itemResult.rows[0],
    group_id: groupId,
    profile_id: profile.id,
    display_name: profile.display_name,
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
        mgp.id AS item_id,
        mgp.group_id,
        mgp.priority,
        mgp.weight,
        mgp.is_enabled AS item_enabled,
        mp.id AS profile_id,
        mp.workspace_id AS profile_workspace_id,
        mp.display_name,
        mp.current_revision_id,
        mp.is_enabled AS profile_enabled,
        mp.installed_by,
        mg.is_enabled AS group_enabled,
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
     FROM model_group_profiles mgp
     JOIN model_groups mg ON mg.id = mgp.group_id
     JOIN model_profiles mp ON mp.id = mgp.profile_id
     LEFT JOIN model_profile_revisions r ON r.id = mp.current_revision_id
     WHERE mgp.id = $1
       AND mgp.group_id = $2
     LIMIT 1`,
    [itemId, groupId],
  );
  if (itemResult.rows.length === 0) {
    throw new ModelGroupError(404, 'Model group item not found');
  }

  const item = itemResult.rows[0];
  const previousProfileState: ModelProfileRelationState = {
    profileId: item.profile_id as string,
    groupId,
    isEnabled: Boolean(item.group_enabled) && Boolean(item.item_enabled) && Boolean(item.profile_enabled),
  };

  const itemSets: string[] = [];
  const itemValues: unknown[] = [];
  let itemIdx = 1;

  if (data.priority !== undefined) {
    itemSets.push(`priority = $${itemIdx++}`);
    itemValues.push(data.priority);
  }
  if (data.weight !== undefined) {
    itemSets.push(`weight = $${itemIdx++}`);
    itemValues.push(data.weight);
  }
  if (data.isEnabled !== undefined) {
    itemSets.push(`is_enabled = $${itemIdx++}`);
    itemValues.push(data.isEnabled);
  }

  if (itemSets.length > 0) {
    itemSets.push(`updated_at = NOW()`);
    itemValues.push(itemId);
    await query(
      `UPDATE model_group_profiles
       SET ${itemSets.join(', ')}
       WHERE id = $${itemIdx}`,
      itemValues,
    );
  }

  if (data.isEnabled !== undefined) {
    await query(
      `UPDATE model_profiles
       SET is_enabled = $1, updated_at = NOW()
       WHERE id = $2`,
      [data.isEnabled, item.profile_id],
    );
  }

  if (data.displayName !== undefined) {
    await query(
      `UPDATE model_profiles
       SET display_name = $1, updated_at = NOW()
       WHERE id = $2`,
      [data.displayName, item.profile_id],
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
    const revision = await createProfileRevision({
      profileId: item.profile_id as string,
      version: nextVersion,
      providerType: data.providerType || (item.provider_type as string),
      apiKey: data.apiKey || (item.api_key as string),
      baseUrl: data.baseUrl || (item.base_url as string),
      modelName: data.modelName || (item.model_name as string),
      maxTokens: data.maxTokens ?? (item.max_tokens as number | null) ?? undefined,
      capabilityTags: data.capabilityTags || (item.capability_tags as string[] | null) || [],
      extraConfig: data.extraConfig ?? asObject(item.extra_config),
      requestTimeoutMs: data.requestTimeoutMs ?? (item.request_timeout_ms as number | null) ?? undefined,
      maxRetries: data.maxRetries ?? (item.max_retries as number | null) ?? undefined,
    });
    await query(
      `UPDATE model_profiles
       SET current_revision_id = $1, updated_at = NOW()
       WHERE id = $2`,
      [revision.id, item.profile_id],
    );
  }

  const updatedResult = await query(
    `SELECT
        mgp.id AS item_id,
        mgp.group_id,
        mgp.priority,
        mgp.weight,
        mgp.is_enabled AS item_enabled,
        mgp.created_at,
        mgp.updated_at,
        mp.id AS profile_id,
        mp.display_name,
        mp.current_revision_id,
        mp.is_enabled AS profile_enabled,
        mg.is_enabled AS group_enabled,
        r.version,
        r.provider_type,
        r.base_url,
        r.model_name,
        r.max_tokens,
        r.capability_tags,
        r.extra_config,
        r.request_timeout_ms,
        r.max_retries
     FROM model_group_profiles mgp
     JOIN model_groups mg ON mg.id = mgp.group_id
     JOIN model_profiles mp ON mp.id = mgp.profile_id
     LEFT JOIN model_profile_revisions r ON r.id = mp.current_revision_id
     WHERE mgp.id = $1
     LIMIT 1`,
    [itemId],
  );
  const updated = updatedResult.rows[0];

  const nextProfileState: ModelProfileRelationState = {
    profileId: updated.profile_id as string,
    groupId,
    isEnabled: Boolean(updated.group_enabled) && Boolean(updated.item_enabled) && Boolean(updated.profile_enabled),
  };

  const authzEntryIds = await enqueueAuthzRelationships(
    diffAuthzRelationships(
      buildModelProfileAuthzRelations(previousProfileState),
      buildModelProfileAuthzRelations(nextProfileState),
    ),
    {
      source: 'model_profile.update',
      groupId,
      itemId,
      profileId: updated.profile_id,
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, 'model_profile.update');

  return mapGroupItem(updated);
}

export async function deleteModelItem(groupId: string, itemId: string) {
  const itemResult = await query(
    `SELECT
        mgp.profile_id,
        mgp.is_enabled AS item_enabled,
        mg.is_enabled AS group_enabled,
        mp.is_enabled AS profile_enabled
     FROM model_group_profiles mgp
     JOIN model_groups mg ON mg.id = mgp.group_id
     JOIN model_profiles mp ON mp.id = mgp.profile_id
     WHERE mgp.id = $1
       AND mgp.group_id = $2
     LIMIT 1`,
    [itemId, groupId],
  );
  if (itemResult.rows.length === 0) {
    throw new ModelGroupError(404, 'Model group item not found');
  }

  const item = itemResult.rows[0];
  const previousProfileState: ModelProfileRelationState = {
    profileId: item.profile_id as string,
    groupId,
    isEnabled: Boolean(item.group_enabled) && Boolean(item.item_enabled) && Boolean(item.profile_enabled),
  };

  await query(
    `UPDATE model_group_profiles
     SET is_enabled = FALSE, updated_at = NOW()
     WHERE id = $1
       AND group_id = $2`,
    [itemId, groupId],
  );
  await query(
    `UPDATE model_profiles
     SET is_enabled = FALSE, updated_at = NOW()
     WHERE id = $1`,
    [item.profile_id],
  );

  const authzEntryIds = await enqueueAuthzRelationships(
    diffAuthzRelationships(
      buildModelProfileAuthzRelations(previousProfileState),
      buildModelProfileAuthzRelations({
        ...previousProfileState,
        isEnabled: false,
      }),
    ),
    {
      source: 'model_profile.delete',
      groupId,
      itemId,
      profileId: item.profile_id,
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, 'model_profile.delete');
}

async function ensureAssignableModelGroups(workspaceId: string, groupIds: string[], actorId?: string) {
  if (groupIds.length === 0) return;

  const result = await query(
    `SELECT DISTINCT mg.id
     FROM model_groups mg
     LEFT JOIN model_group_grants mgg
       ON mgg.group_id = mg.id
      AND mgg.status = 'active'
     WHERE mg.id = ANY($1)
       AND mg.is_enabled = TRUE
       AND (
         (mg.owner_type = 'workspace' AND mg.owner_workspace_id = $2)
         OR (mgg.grant_scope = 'platform')
         OR (mgg.grant_scope = 'workspace' AND mgg.workspace_id = $2)
         OR (mgg.grant_scope = 'workspace_user' AND mgg.workspace_id = $2)
         OR (mgg.grant_scope = 'actor' AND mgg.workspace_id = $2 AND ($3::uuid IS NULL OR mgg.actor_id = $3))
       )`,
    [groupIds, workspaceId, actorId || null],
  );

  if (result.rows.length !== groupIds.length) {
    throw new ModelGroupError(400, 'One or more model groups are invalid for this workspace');
  }
}

export async function getItemVersions(itemId: string, groupId?: string) {
  const itemResult = await query(
    `SELECT profile_id
     FROM model_group_profiles
     WHERE id = $1
       AND ($2::uuid IS NULL OR group_id = $2)
     LIMIT 1`,
    [itemId, groupId || null],
  );
  if (itemResult.rows.length === 0) {
    throw new ModelGroupError(404, 'Model group item not found');
  }
  const profileId = itemResult.rows[0].profile_id as string;

  const versions = await query(
    `SELECT
        r.id,
        r.profile_id,
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
     FROM model_profile_revisions r
     WHERE r.profile_id = $1
     ORDER BY r.version DESC`,
    [profileId],
  );
  return versions.rows;
}

export async function getActorModelGroups(actorId: string, workspaceId?: string) {
  if (workspaceId) {
    await ensureActorInWorkspace(actorId, workspaceId);
  }

  const result = await query(
    `SELECT
        amga.actor_id,
        amga.group_id,
        amga.priority,
        amga.created_at,
        mg.name AS group_name,
        mg.routing_strategy,
        mg.is_default,
        mg.owner_workspace_id AS workspace_id,
        mg.owner_type,
        mg.owner_user_id
     FROM actor_model_group_assignments amga
     JOIN model_groups mg ON mg.id = amga.group_id
     WHERE amga.actor_id = $1
       AND mg.is_enabled = TRUE
       AND (
         $2::uuid IS NULL
         OR (mg.owner_type = 'workspace' AND mg.owner_workspace_id = $2)
         OR EXISTS (
           SELECT 1
           FROM model_group_grants mgg
           WHERE mgg.group_id = mg.id
             AND mgg.status = 'active'
             AND (
               mgg.grant_scope = 'platform'
               OR (mgg.grant_scope = 'workspace' AND mgg.workspace_id = $2)
               OR (mgg.grant_scope = 'workspace_user' AND mgg.workspace_id = $2)
               OR (mgg.grant_scope = 'actor' AND mgg.workspace_id = $2)
             )
         )
       )
     ORDER BY amga.priority ASC`,
    [actorId, workspaceId || null],
  );
  return result.rows;
}

export async function setActorModelGroups(actorId: string, workspaceId: string, groups: { groupId: string; priority: number }[]) {
  await ensureActorInWorkspace(actorId, workspaceId);
  await ensureAssignableModelGroups(workspaceId, groups.map((group) => group.groupId), actorId);

  await query(`DELETE FROM actor_model_group_assignments WHERE actor_id = $1`, [actorId]);
  for (const group of groups) {
    await query(
      `INSERT INTO actor_model_group_assignments (actor_id, group_id, priority)
       VALUES ($1, $2, $3)`,
      [actorId, group.groupId, group.priority],
    );
  }
  return getActorModelGroups(actorId, workspaceId);
}

export async function listVisibleActorModelGroups(actorId: string, workspaceId: string) {
  await ensureActorInWorkspace(actorId, workspaceId);

  const result = await query<ModelGroupRow>(
    `SELECT DISTINCT
        mg.*,
        CASE mg.owner_type
          WHEN 'workspace' THEN 0
          WHEN 'platform' THEN 1
          ELSE 2
        END AS owner_rank
     FROM model_groups mg
     LEFT JOIN model_group_grants mgg
       ON mgg.group_id = mg.id
      AND mgg.status = 'active'
     WHERE mg.is_enabled = TRUE
       AND (
         (mg.owner_type = 'workspace' AND mg.owner_workspace_id = $2)
         OR (mgg.grant_scope = 'platform')
         OR (mgg.grant_scope = 'workspace' AND mgg.workspace_id = $2)
         OR (mgg.grant_scope = 'actor' AND mgg.workspace_id = $2 AND mgg.actor_id = $1)
       )
     ORDER BY owner_rank, mg.is_default DESC, mg.name`,
    [actorId, workspaceId],
  );

  return result.rows.map(mapGroupRow);
}

export async function listModelGroupGrants(groupId: string) {
  await getGroupRow(groupId);
  const result = await query<ModelGroupGrantRow & { id: string; group_id: string }>(
    `SELECT *
     FROM model_group_grants
     WHERE group_id = $1
     ORDER BY created_at DESC`,
    [groupId],
  );
  return result.rows.map(mapGrantRow);
}

export async function issueModelGroupGrant(groupId: string, input: {
  grantScope: ModelGroupGrantScope;
  workspaceId?: string;
  userId?: string;
  actorId?: string;
  grantedBy?: string;
  reason?: string;
  metadata?: JsonMap;
}) {
  const previousState = await loadGroupAuthzState(groupId);
  await validateGrantTarget(input);
  await ensureNoDuplicateActiveGrant(groupId, input);

  const result = await query<ModelGroupGrantRow & { id: string; group_id: string }>(
    `INSERT INTO model_group_grants (
       group_id, grant_scope, workspace_id, user_id, actor_id,
       status, granted_by, reason, metadata
     )
     VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8::jsonb)
     RETURNING *`,
    [
      groupId,
      input.grantScope,
      input.workspaceId || null,
      input.userId || null,
      input.actorId || null,
      input.grantedBy || null,
      input.reason || null,
      JSON.stringify(input.metadata || {}),
    ],
  );

  const nextState = await loadGroupAuthzState(groupId);
  const authzEntryIds = await enqueueAuthzRelationships(
    diffAuthzRelationships(
      buildModelGroupAuthzRelations(previousState),
      buildModelGroupAuthzRelations(nextState),
    ),
    {
      source: 'model_group.grant.issue',
      groupId,
      grantId: result.rows[0].id,
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, 'model_group.grant.issue');

  return mapGrantRow(result.rows[0]);
}

export async function revokeModelGroupGrant(groupId: string, grantId: string) {
  const previousState = await loadGroupAuthzState(groupId);
  const result = await query(
    `UPDATE model_group_grants
     SET status = 'revoked',
         revoked_at = NOW()
     WHERE id = $1
       AND group_id = $2
       AND status = 'active'
     RETURNING id`,
    [grantId, groupId],
  );
  if (result.rows.length === 0) {
    throw new ModelGroupError(404, 'Model group grant not found');
  }

  const nextState = await loadGroupAuthzState(groupId);
  const authzEntryIds = await enqueueAuthzRelationships(
    diffAuthzRelationships(
      buildModelGroupAuthzRelations(previousState),
      buildModelGroupAuthzRelations(nextState),
    ),
    {
      source: 'model_group.grant.revoke',
      groupId,
      grantId,
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, 'model_group.grant.revoke');
}

export async function logAIRequest(data: {
  workspaceId?: string;
  actorId?: string;
  sessionId?: string;
  turnId?: string;
  round?: number;
  groupId?: string;
  profileId?: string;
  profileRevisionId?: string;
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
        modelProfileId: data.profileId,
        modelProfileRevisionId: data.profileRevisionId,
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
  if (data.profileRevisionId) {
    const revisionResult = await query(
      `SELECT provider_type, model_name
       FROM model_profile_revisions
       WHERE id = $1
       LIMIT 1`,
      [data.profileRevisionId],
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
    modelGroupId: data.groupId,
    modelProfileId: data.profileId,
    modelProfileRevisionId: data.profileRevisionId,
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

  const defaultGroupResult = await query<{ group_id: string }>(
    `SELECT ps.default_model_group_id AS group_id
     FROM platform_settings ps
     JOIN model_groups mg ON mg.id = ps.default_model_group_id
     WHERE ps.id = TRUE
       AND ps.default_model_group_id IS NOT NULL
       AND mg.owner_type = 'platform'
       AND mg.is_enabled = TRUE
     LIMIT 1`,
    [],
  );

  let groupId = defaultGroupResult.rows[0]?.group_id || null;

  if (!groupId) {
    const fallbackGroupResult = await query<{ id: string }>(
      `SELECT id
       FROM model_groups
       WHERE owner_type = 'platform'
         AND is_enabled = TRUE
       ORDER BY is_default DESC, created_at ASC
       LIMIT 1`,
      [],
    );

    groupId = fallbackGroupResult.rows[0]?.id || null;

    if (groupId) {
      await clearExistingDefault('platform');
      await query(
        `UPDATE model_groups
         SET is_default = TRUE, updated_at = NOW()
         WHERE id = $1`,
        [groupId],
      );
      await setDefaultGroup(groupId, 'platform');
    }
  }

  if (!groupId) {
    const group = await createModelGroup({
      ownerType: 'platform',
      name: 'Platform Default',
      description: 'Auto-created from environment variables',
      routingStrategy: 'priority_failover',
      attemptPolicy: { ...DEFAULT_MODEL_ATTEMPT_POLICY },
      isDefault: true,
    });
    groupId = group.id;
  }

  if (config.ai.apiKey && groupId) {
    const existingItems = await query<{ id: string }>(
      `SELECT id
       FROM model_group_profiles
       WHERE group_id = $1
         AND is_enabled = TRUE
       LIMIT 1`,
      [groupId],
    );

    if (existingItems.rows.length === 0) {
      await addModelItem(groupId, {
        displayName: `${config.ai.model} (env)`,
        priority: 0,
        weight: 100,
        providerType: config.ai.provider,
        apiKey: config.ai.apiKey,
        baseUrl: config.ai.baseUrl,
        modelName: config.ai.model,
        maxTokens: config.ai.maxTokens,
        requestTimeoutMs: DEFAULT_MODEL_ATTEMPT_TIMEOUT_MS,
        maxRetries: 1,
      });
    }
  }

  return groupId;
}
