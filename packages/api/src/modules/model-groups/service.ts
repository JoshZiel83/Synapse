import { config } from '../../config/index.js';
import {
  resolveModelEngineKind,
  validateModelProviderConfig,
} from '@synapse/shared';
import { query } from '../../infrastructure/database/index.js';
import {
  db,
  type TableInsert,
} from '../../infrastructure/database/kysely.js';
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
import { sql } from 'kysely';

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
  created_at: string | Date;
  updated_at: string | Date;
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
  created_at?: string | Date;
  revoked_at?: string | Date | null;
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

function toIsoString(value: string | Date | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function withEngineKind(extraConfig: JsonMap | undefined, engineKind?: string): JsonMap | undefined {
  const next = { ...(extraConfig || {}) };
  if (engineKind) {
    next.engine_kind = engineKind;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function assertValidModelRevisionInput(input: {
  providerType: string;
  engineKind?: string;
  modelName: string;
  maxTokens?: number;
  extraConfig?: JsonMap;
}) {
  const engineKind = input.engineKind || resolveModelEngineKind(input.providerType, input.extraConfig);
  const issues = validateModelProviderConfig({
    providerType: input.providerType,
    engineKind,
    modelName: input.modelName,
    maxTokens: input.maxTokens,
  });

  if (issues.length > 0) {
    throw new ModelGroupError(400, issues[0].message);
  }

  return {
    engineKind,
  };
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
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at),
  };
}

function mapGroupItem(row: any) {
  const extraConfig = asObject(row.extra_config);
  const engineKind = resolveModelEngineKind(row.provider_type || 'anthropic', extraConfig);

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
    engine_kind: engineKind,
    base_url: row.base_url || null,
    model_name: row.model_name || null,
    max_tokens: row.max_tokens || null,
    capability_tags: row.capability_tags || [],
    extra_config: extraConfig,
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
    created_at: toIsoString(row.created_at),
    revoked_at: toIsoString(row.revoked_at),
  };
}

async function ensurePlatformSettingsRow() {
  await db
    .insertInto('platform_settings')
    .values({
      id: true,
      metadata: {} as TableInsert<'platform_settings'>['metadata'],
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
}

async function clearExistingDefault(ownerType: ModelGroupOwnerType, ownerWorkspaceId?: string | null, ownerUserId?: string | null) {
  if (ownerType === 'platform') {
    await db
      .updateTable('model_groups')
      .set({
        is_default: false,
      })
      .where('owner_type', '=', 'platform')
      .where('is_default', '=', true)
      .execute();
    await ensurePlatformSettingsRow();
    return;
  }

  if (ownerType === 'workspace') {
    if (!ownerWorkspaceId) {
      throw new ModelGroupError(400, 'ownerWorkspaceId is required for workspace defaults');
    }
    await db
      .updateTable('model_groups')
      .set({
        is_default: false,
      })
      .where('owner_type', '=', 'workspace')
      .where('owner_workspace_id', '=', ownerWorkspaceId)
      .where('is_default', '=', true)
      .execute();
    return;
  }

  if (!ownerUserId) {
    throw new ModelGroupError(400, 'ownerUserId is required for user defaults');
  }
  await db
    .updateTable('model_groups')
    .set({
      is_default: false,
    })
    .where('owner_type', '=', 'user')
    .where('owner_user_id', '=', ownerUserId)
    .where('is_default', '=', true)
    .execute();
}

async function setDefaultGroup(groupId: string, ownerType: ModelGroupOwnerType, ownerWorkspaceId?: string | null) {
  if (ownerType === 'platform') {
    await ensurePlatformSettingsRow();
    await db
      .updateTable('platform_settings')
      .set({
        default_model_group_id: groupId,
        updated_at: sql`NOW()`,
      })
      .where('id', '=', true)
      .execute();
    return;
  }

  if (ownerType === 'workspace') {
    if (!ownerWorkspaceId) {
      throw new ModelGroupError(400, 'ownerWorkspaceId is required for workspace defaults');
    }
    await db
      .updateTable('workspaces')
      .set({
        default_model_group_id: groupId,
        updated_at: sql`NOW()`,
      })
      .where('id', '=', ownerWorkspaceId)
      .execute();
  }
}

async function clearDefaultGroupPointer(groupId: string, ownerType: ModelGroupOwnerType, ownerWorkspaceId?: string | null) {
  if (ownerType === 'platform') {
    await ensurePlatformSettingsRow();
    await db
      .updateTable('platform_settings')
      .set({
        default_model_group_id: null,
        updated_at: sql`NOW()`,
      })
      .where('id', '=', true)
      .where('default_model_group_id', '=', groupId)
      .execute();
    return;
  }

  if (ownerType === 'workspace' && ownerWorkspaceId) {
    await db
      .updateTable('workspaces')
      .set({
        default_model_group_id: null,
        updated_at: sql`NOW()`,
      })
      .where('id', '=', ownerWorkspaceId)
      .where('default_model_group_id', '=', groupId)
      .execute();
  }
}

async function getGroupRow(groupId: string) {
  const row = (await db
    .selectFrom('model_groups')
    .selectAll()
    .where('id', '=', groupId)
    .limit(1)
    .executeTakeFirst()) as ModelGroupRow | undefined;
  if (!row) {
    throw new ModelGroupError(404, 'Model group not found');
  }
  return row;
}

async function listActiveGroupGrants(groupIds: string[]) {
  if (groupIds.length === 0) return new Map<string, ModelGroupGrantRow[]>();

  const result = await db
    .selectFrom('model_group_grants')
    .selectAll()
    .where('status', '=', 'active')
    .where('group_id', 'in', groupIds)
    .execute();

  const byGroup = new Map<string, ModelGroupGrantRow[]>();
  for (const row of result as Array<ModelGroupGrantRow & { group_id: string }>) {
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
  const result = await db
    .selectFrom('model_group_profiles as mgp')
    .innerJoin('model_groups as mg', 'mg.id', 'mgp.group_id')
    .innerJoin('model_profiles as mp', 'mp.id', 'mgp.profile_id')
    .select([
      'mp.id as profile_id',
      'mgp.group_id',
      sql<boolean>`(mg.is_enabled = TRUE AND mgp.is_enabled = TRUE AND mp.is_enabled = TRUE)`.as(
        'relation_enabled',
      ),
    ])
    .where('mgp.group_id', '=', groupId)
    .execute();

  return result.map((row) => ({
    profileId: row.profile_id as string,
    groupId: row.group_id as string,
    isEnabled: row.relation_enabled === true,
  }));
}

async function createProfileRevision(input: {
  profileId: string;
  version: number;
  providerType: string;
  engineKind?: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  maxTokens?: number;
  capabilityTags?: string[];
  extraConfig?: JsonMap;
  requestTimeoutMs?: number;
  maxRetries?: number;
}) {
  const validated = assertValidModelRevisionInput({
    providerType: input.providerType,
    engineKind: input.engineKind,
    modelName: input.modelName,
    maxTokens: input.maxTokens,
    extraConfig: input.extraConfig,
  });
  const effectiveMaxTokens = input.maxTokens ?? 4096;

  return db
    .insertInto('model_profile_revisions')
    .values({
      profile_id: input.profileId,
      version: input.version,
      provider_type: input.providerType,
      api_key: input.apiKey,
      base_url: input.baseUrl,
      model_name: input.modelName,
      max_tokens: effectiveMaxTokens,
      capability_tags: input.capabilityTags || [],
      extra_config:
        (withEngineKind(input.extraConfig, validated.engineKind) || {}) as TableInsert<'model_profile_revisions'>['extra_config'],
      request_timeout_ms: input.requestTimeoutMs ?? null,
      max_retries: input.maxRetries ?? null,
      metadata: {} as TableInsert<'model_profile_revisions'>['metadata'],
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function createDefaultGroupGrant(
  groupId: string,
  ownerType: ModelGroupOwnerType,
  ownerWorkspaceId?: string | null,
  ownerUserId?: string | null,
  grantedBy?: string | null,
) {
  return (await db
    .insertInto('model_group_grants')
    .values({
      group_id: groupId,
      grant_scope: ownerType === 'platform' ? 'platform' : ownerType === 'workspace' ? 'workspace' : 'user',
      workspace_id: ownerType === 'workspace' ? ownerWorkspaceId || null : null,
      user_id: ownerType === 'user' ? ownerUserId || null : null,
      actor_id: null,
      status: 'active',
      granted_by: grantedBy || null,
      reason: 'default_group_scope',
      metadata: {} as TableInsert<'model_group_grants'>['metadata'],
    })
    .returningAll()
    .executeTakeFirstOrThrow()) as ModelGroupGrantRow;
}

async function ensureWorkspaceExists(workspaceId: string) {
  const row = await db
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', workspaceId)
    .limit(1)
    .executeTakeFirst();
  if (!row) {
    throw new ModelGroupError(404, 'Workspace not found');
  }
}

async function ensureUserExists(userId: string) {
  const row = await db
    .selectFrom('users')
    .select('id')
    .where('id', '=', userId)
    .limit(1)
    .executeTakeFirst();
  if (!row) {
    throw new ModelGroupError(404, 'User not found');
  }
}

async function ensureWorkspaceMember(workspaceId: string, userId: string) {
  const row = await db
    .selectFrom('workspace_members')
    .select('workspace_id')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .limit(1)
    .executeTakeFirst();
  if (!row) {
    throw new ModelGroupError(400, 'User is not a member of the target workspace');
  }
}

async function ensureActorInWorkspace(actorId: string, workspaceId: string) {
  const row = await db
    .selectFrom('actors')
    .select('id')
    .where('id', '=', actorId)
    .where('workspace_id', '=', workspaceId)
    .limit(1)
    .executeTakeFirst();
  if (!row) {
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
  const row = await db
    .selectFrom('model_group_grants')
    .select('group_id')
    .where('group_id', '=', groupId)
    .where('status', '=', 'active')
    .where('grant_scope', '=', input.grantScope)
    .where(
      sql<boolean>`workspace_id IS NOT DISTINCT FROM ${input.workspaceId || null}::uuid`,
    )
    .where(
      sql<boolean>`user_id IS NOT DISTINCT FROM ${input.userId || null}::uuid`,
    )
    .where(
      sql<boolean>`actor_id IS NOT DISTINCT FROM ${input.actorId || null}::uuid`,
    )
    .limit(1)
    .executeTakeFirst();
  if (row) {
    throw new ModelGroupError(409, 'An identical active grant already exists');
  }
}

export async function listPlatformModelGroups() {
  const result = await db
    .selectFrom('model_groups')
    .selectAll()
    .where('owner_type', '=', 'platform')
    .where('is_enabled', '=', true)
    .orderBy('is_default', 'desc')
    .orderBy('name')
    .execute();
  return result.map((row) => mapGroupRow(row as ModelGroupRow));
}

export async function listWorkspaceModelGroups(workspaceId: string) {
  const result = await db
    .selectFrom('model_groups as mg')
    .distinct()
    .leftJoin('model_group_grants as mgg', (join) =>
      join
        .onRef('mgg.group_id', '=', 'mg.id')
        .on('mgg.status', '=', 'active'),
    )
    .selectAll('mg')
    .select(
      sql<number>`CASE mg.owner_type
        WHEN 'workspace' THEN 0
        WHEN 'platform' THEN 1
        ELSE 2
      END`.as('owner_rank'),
    )
    .where('mg.is_enabled', '=', true)
    .where((eb) =>
      eb.or([
        eb.and([
          eb('mg.owner_type', '=', 'workspace'),
          eb('mg.owner_workspace_id', '=', workspaceId),
        ]),
        eb('mgg.grant_scope', '=', 'platform'),
        eb.and([
          eb('mgg.grant_scope', '=', 'workspace'),
          eb('mgg.workspace_id', '=', workspaceId),
        ]),
        eb.and([
          eb('mgg.grant_scope', '=', 'workspace_user'),
          eb('mgg.workspace_id', '=', workspaceId),
        ]),
        eb.and([
          eb('mgg.grant_scope', '=', 'actor'),
          eb('mgg.workspace_id', '=', workspaceId),
        ]),
      ]),
    )
    .orderBy('owner_rank')
    .orderBy('mg.is_default', 'desc')
    .orderBy('mg.name')
    .execute();
  return result.map((row) => mapGroupRow(row as ModelGroupRow));
}

export async function listUserOwnedModelGroups(userId: string) {
  const result = await db
    .selectFrom('model_groups')
    .selectAll()
    .where('owner_type', '=', 'user')
    .where('owner_user_id', '=', userId)
    .where('is_enabled', '=', true)
    .orderBy('is_default', 'desc')
    .orderBy('name')
    .execute();
  return result.map((row) => mapGroupRow(row as ModelGroupRow));
}

export async function listModelGroups(workspaceId: string | null) {
  return workspaceId ? listWorkspaceModelGroups(workspaceId) : listPlatformModelGroups();
}

export async function getModelGroup(groupId: string) {
  const group = await getGroupRow(groupId);

  const [itemsResult, grantsResult] = await Promise.all([
    db
      .selectFrom('model_group_profiles as mgp')
      .innerJoin('model_profiles as mp', 'mp.id', 'mgp.profile_id')
      .leftJoin('model_profile_revisions as r', 'r.id', 'mp.current_revision_id')
      .select([
        'mgp.id as item_id',
        'mgp.group_id',
        'mgp.priority',
        'mgp.weight',
        'mgp.is_enabled as item_enabled',
        'mgp.created_at',
        'mgp.updated_at',
        'mp.id as profile_id',
        'mp.display_name',
        'mp.current_revision_id',
        'r.version',
        'r.provider_type',
        'r.base_url',
        'r.model_name',
        'r.max_tokens',
        'r.capability_tags',
        'r.extra_config',
        'r.request_timeout_ms',
        'r.max_retries',
      ])
      .where('mgp.group_id', '=', groupId)
      .orderBy('mgp.priority', 'asc')
      .orderBy('mp.display_name')
      .execute(),
    db
      .selectFrom('model_group_grants')
      .selectAll()
      .where('group_id', '=', groupId)
      .orderBy('created_at', 'desc')
      .execute(),
  ]);

  return {
    ...mapGroupRow(group),
    items: itemsResult.map(mapGroupItem),
    grants: (grantsResult as Array<ModelGroupGrantRow & { id: string; group_id: string }>).map(mapGrantRow),
  };
}

export async function isModelGroupAvailableInWorkspace(groupId: string, workspaceId: string) {
  const row = await db
    .selectFrom('model_groups as mg')
    .leftJoin('model_group_grants as mgg', (join) =>
      join
        .onRef('mgg.group_id', '=', 'mg.id')
        .on('mgg.status', '=', 'active'),
    )
    .select('mg.id')
    .where('mg.id', '=', groupId)
    .where('mg.is_enabled', '=', true)
    .where((eb) =>
      eb.or([
        eb.and([
          eb('mg.owner_type', '=', 'workspace'),
          eb('mg.owner_workspace_id', '=', workspaceId),
        ]),
        eb('mgg.grant_scope', '=', 'platform'),
        eb.and([
          eb('mgg.grant_scope', '=', 'workspace'),
          eb('mgg.workspace_id', '=', workspaceId),
        ]),
        eb.and([
          eb('mgg.grant_scope', '=', 'workspace_user'),
          eb('mgg.workspace_id', '=', workspaceId),
        ]),
        eb.and([
          eb('mgg.grant_scope', '=', 'actor'),
          eb('mgg.workspace_id', '=', workspaceId),
        ]),
      ]),
    )
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
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

  const row = (await db
    .insertInto('model_groups')
    .values({
      owner_type: ownerType,
      owner_workspace_id: ownerType === 'workspace' ? data.workspaceId || null : null,
      owner_user_id: ownerType === 'user' ? data.ownerUserId || null : null,
      name: data.name,
      description: data.description || '',
      routing_strategy: data.routingStrategy || 'priority_failover',
      attempt_policy:
        (data.attemptPolicy || {}) as TableInsert<'model_groups'>['attempt_policy'],
      is_default: data.isDefault || false,
      is_enabled: true,
      created_by: data.createdBy || null,
      metadata: {} as TableInsert<'model_groups'>['metadata'],
    })
    .returningAll()
    .executeTakeFirstOrThrow()) as ModelGroupRow;
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

  const updateData: Record<string, unknown> = {
    updated_at: sql`NOW()`,
  };

  if (data.name !== undefined) {
    updateData.name = data.name;
  }
  if (data.description !== undefined) {
    updateData.description = data.description;
  }
  if (data.routingStrategy !== undefined) {
    updateData.routing_strategy = data.routingStrategy;
  }
  if (data.attemptPolicy !== undefined) {
    updateData.attempt_policy =
      data.attemptPolicy as TableInsert<'model_groups'>['attempt_policy'];
  }
  if (data.isDefault !== undefined) {
    updateData.is_default = data.isDefault;
  }
  if (data.isActive !== undefined) {
    updateData.is_enabled = data.isActive;
  }

  if (Object.keys(updateData).length === 1) {
    return getModelGroup(groupId);
  }

  const updatedRow = (await db
    .updateTable('model_groups')
    .set(updateData as any)
    .where('id', '=', groupId)
    .returningAll()
    .executeTakeFirst()) as ModelGroupRow | undefined;
  if (!updatedRow) {
    throw new ModelGroupError(404, 'Model group not found');
  }
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

  await db
    .updateTable('model_groups')
    .set({
      is_enabled: false,
      is_default: false,
      updated_at: sql`NOW()`,
    })
    .where('id', '=', groupId)
    .execute();
  await db
    .updateTable('model_group_profiles')
    .set({
      is_enabled: false,
      updated_at: sql`NOW()`,
    })
    .where('group_id', '=', groupId)
    .execute();
  await db
    .updateTable('model_profiles')
    .set({
      is_enabled: false,
      updated_at: sql`NOW()`,
    })
    .where(
      'id',
      'in',
      db
        .selectFrom('model_group_profiles')
        .select('profile_id')
        .where('group_id', '=', groupId),
    )
    .execute();
  await db
    .deleteFrom('actor_model_group_assignments')
    .where('group_id', '=', groupId)
    .execute();
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
  engineKind?: string;
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

  const profile = await db
    .insertInto('model_profiles')
    .values({
      workspace_id: group.owner_type === 'workspace' ? group.owner_workspace_id : null,
      display_name: data.displayName,
      is_enabled: true,
      installed_by: data.installedBy || group.created_by || null,
      metadata: {} as TableInsert<'model_profiles'>['metadata'],
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const revision = await createProfileRevision({
    profileId: profile.id as string,
    version: 1,
    providerType: data.providerType,
    engineKind: data.engineKind,
    apiKey: data.apiKey,
    baseUrl: data.baseUrl,
    modelName: data.modelName,
    maxTokens: data.maxTokens,
    capabilityTags: data.capabilityTags,
    extraConfig: data.extraConfig,
    requestTimeoutMs: data.requestTimeoutMs,
    maxRetries: data.maxRetries,
  });

  await db
    .updateTable('model_profiles')
    .set({
      current_revision_id: revision.id,
      updated_at: sql`NOW()`,
    })
    .where('id', '=', profile.id)
    .execute();

  const item = await db
    .insertInto('model_group_profiles')
    .values({
      group_id: groupId,
      profile_id: profile.id,
      priority: data.priority ?? 0,
      weight: data.weight ?? 100,
      is_enabled: true,
      metadata: {} as TableInsert<'model_group_profiles'>['metadata'],
    })
    .returningAll()
    .executeTakeFirstOrThrow();

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
    ...item,
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
  engineKind?: string;
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
  maxTokens?: number;
  capabilityTags?: string[];
  extraConfig?: JsonMap;
  requestTimeoutMs?: number;
  maxRetries?: number;
}) {
  const item = await db
    .selectFrom('model_group_profiles as mgp')
    .innerJoin('model_groups as mg', 'mg.id', 'mgp.group_id')
    .innerJoin('model_profiles as mp', 'mp.id', 'mgp.profile_id')
    .leftJoin('model_profile_revisions as r', 'r.id', 'mp.current_revision_id')
    .select([
      'mgp.id as item_id',
      'mgp.group_id',
      'mgp.priority',
      'mgp.weight',
      'mgp.is_enabled as item_enabled',
      'mp.id as profile_id',
      'mp.workspace_id as profile_workspace_id',
      'mp.display_name',
      'mp.current_revision_id',
      'mp.is_enabled as profile_enabled',
      'mp.installed_by',
      'mg.is_enabled as group_enabled',
      'r.version',
      'r.provider_type',
      'r.api_key',
      'r.base_url',
      'r.model_name',
      'r.max_tokens',
      'r.capability_tags',
      'r.extra_config',
      'r.request_timeout_ms',
      'r.max_retries',
    ])
    .where('mgp.id', '=', itemId)
    .where('mgp.group_id', '=', groupId)
    .limit(1)
    .executeTakeFirst();
  if (!item) {
    throw new ModelGroupError(404, 'Model group item not found');
  }
  const previousProfileState: ModelProfileRelationState = {
    profileId: item.profile_id as string,
    groupId,
    isEnabled: Boolean(item.group_enabled) && Boolean(item.item_enabled) && Boolean(item.profile_enabled),
  };

  const itemUpdate: Record<string, unknown> = {};
  if (data.priority !== undefined) {
    itemUpdate.priority = data.priority;
  }
  if (data.weight !== undefined) {
    itemUpdate.weight = data.weight;
  }
  if (data.isEnabled !== undefined) {
    itemUpdate.is_enabled = data.isEnabled;
  }

  if (Object.keys(itemUpdate).length > 0) {
    await db
      .updateTable('model_group_profiles')
      .set({
        ...(itemUpdate as any),
        updated_at: sql`NOW()`,
      })
      .where('id', '=', itemId)
      .execute();
  }

  if (data.isEnabled !== undefined) {
    await db
      .updateTable('model_profiles')
      .set({
        is_enabled: data.isEnabled,
        updated_at: sql`NOW()`,
      })
      .where('id', '=', item.profile_id as string)
      .execute();
  }

  if (data.displayName !== undefined) {
    await db
      .updateTable('model_profiles')
      .set({
        display_name: data.displayName,
        updated_at: sql`NOW()`,
      })
      .where('id', '=', item.profile_id as string)
      .execute();
  }

  const hasConfigChange =
    data.providerType !== undefined ||
    data.engineKind !== undefined ||
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
      engineKind: data.engineKind || resolveModelEngineKind(
        data.providerType || (item.provider_type as string),
        data.extraConfig ?? asObject(item.extra_config),
      ),
      apiKey: data.apiKey || (item.api_key as string),
      baseUrl: data.baseUrl || (item.base_url as string),
      modelName: data.modelName || (item.model_name as string),
      maxTokens: data.maxTokens ?? (item.max_tokens as number | null) ?? undefined,
      capabilityTags: data.capabilityTags || (item.capability_tags as string[] | null) || [],
      extraConfig: data.extraConfig ?? asObject(item.extra_config),
      requestTimeoutMs: data.requestTimeoutMs ?? (item.request_timeout_ms as number | null) ?? undefined,
      maxRetries: data.maxRetries ?? (item.max_retries as number | null) ?? undefined,
    });
    await db
      .updateTable('model_profiles')
      .set({
        current_revision_id: revision.id,
        updated_at: sql`NOW()`,
      })
      .where('id', '=', item.profile_id as string)
      .execute();
  }

  const updated = await db
    .selectFrom('model_group_profiles as mgp')
    .innerJoin('model_groups as mg', 'mg.id', 'mgp.group_id')
    .innerJoin('model_profiles as mp', 'mp.id', 'mgp.profile_id')
    .leftJoin('model_profile_revisions as r', 'r.id', 'mp.current_revision_id')
    .select([
      'mgp.id as item_id',
      'mgp.group_id',
      'mgp.priority',
      'mgp.weight',
      'mgp.is_enabled as item_enabled',
      'mgp.created_at',
      'mgp.updated_at',
      'mp.id as profile_id',
      'mp.display_name',
      'mp.current_revision_id',
      'mp.is_enabled as profile_enabled',
      'mg.is_enabled as group_enabled',
      'r.version',
      'r.provider_type',
      'r.base_url',
      'r.model_name',
      'r.max_tokens',
      'r.capability_tags',
      'r.extra_config',
      'r.request_timeout_ms',
      'r.max_retries',
    ])
    .where('mgp.id', '=', itemId)
    .limit(1)
    .executeTakeFirstOrThrow();

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
  const item = await db
    .selectFrom('model_group_profiles as mgp')
    .innerJoin('model_groups as mg', 'mg.id', 'mgp.group_id')
    .innerJoin('model_profiles as mp', 'mp.id', 'mgp.profile_id')
    .select([
      'mgp.profile_id',
      'mgp.is_enabled as item_enabled',
      'mg.is_enabled as group_enabled',
      'mp.is_enabled as profile_enabled',
    ])
    .where('mgp.id', '=', itemId)
    .where('mgp.group_id', '=', groupId)
    .limit(1)
    .executeTakeFirst();
  if (!item) {
    throw new ModelGroupError(404, 'Model group item not found');
  }
  const previousProfileState: ModelProfileRelationState = {
    profileId: item.profile_id as string,
    groupId,
    isEnabled: Boolean(item.group_enabled) && Boolean(item.item_enabled) && Boolean(item.profile_enabled),
  };

  await db
    .updateTable('model_group_profiles')
    .set({
      is_enabled: false,
      updated_at: sql`NOW()`,
    })
    .where('id', '=', itemId)
    .where('group_id', '=', groupId)
    .execute();
  await db
    .updateTable('model_profiles')
    .set({
      is_enabled: false,
      updated_at: sql`NOW()`,
    })
    .where('id', '=', item.profile_id as string)
    .execute();

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

  const result = await db
    .selectFrom('model_groups as mg')
    .distinct()
    .leftJoin('model_group_grants as mgg', (join) =>
      join
        .onRef('mgg.group_id', '=', 'mg.id')
        .on('mgg.status', '=', 'active'),
    )
    .select('mg.id')
    .where('mg.id', 'in', groupIds)
    .where('mg.is_enabled', '=', true)
    .where((eb) =>
      eb.or([
        eb.and([
          eb('mg.owner_type', '=', 'workspace'),
          eb('mg.owner_workspace_id', '=', workspaceId),
        ]),
        eb('mgg.grant_scope', '=', 'platform'),
        eb.and([
          eb('mgg.grant_scope', '=', 'workspace'),
          eb('mgg.workspace_id', '=', workspaceId),
        ]),
        eb.and([
          eb('mgg.grant_scope', '=', 'workspace_user'),
          eb('mgg.workspace_id', '=', workspaceId),
        ]),
        eb.and([
          eb('mgg.grant_scope', '=', 'actor'),
          eb('mgg.workspace_id', '=', workspaceId),
          actorId
            ? eb('mgg.actor_id', '=', actorId)
            : sql<boolean>`TRUE`,
        ]),
      ]),
    )
    .execute();

  if (result.length !== groupIds.length) {
    throw new ModelGroupError(400, 'One or more model groups are invalid for this workspace');
  }
}

export async function getItemVersions(itemId: string, groupId?: string) {
  let itemLookup = db
    .selectFrom('model_group_profiles')
    .select('profile_id')
    .where('id', '=', itemId);
  if (groupId) {
    itemLookup = itemLookup.where('group_id', '=', groupId);
  }
  const itemRow = await itemLookup.limit(1).executeTakeFirst();
  if (!itemRow) {
    throw new ModelGroupError(404, 'Model group item not found');
  }
  const profileId = itemRow.profile_id as string;

  return db
    .selectFrom('model_profile_revisions as r')
    .select([
      'r.id',
      'r.profile_id',
      'r.version',
      'r.provider_type',
      sql<string | null>`r.extra_config->>'engine_kind'`.as('engine_kind'),
      'r.base_url',
      'r.model_name',
      'r.max_tokens',
      'r.capability_tags',
      'r.extra_config',
      'r.request_timeout_ms',
      'r.max_retries',
      'r.created_at',
    ])
    .where('r.profile_id', '=', profileId)
    .orderBy('r.version', 'desc')
    .execute();
}

export async function getActorModelGroups(actorId: string, workspaceId?: string) {
  if (workspaceId) {
    await ensureActorInWorkspace(actorId, workspaceId);
  }

  let statement = db
    .selectFrom('actor_model_group_assignments as amga')
    .innerJoin('model_groups as mg', 'mg.id', 'amga.group_id')
    .select([
      'amga.actor_id',
      'amga.group_id',
      'amga.priority',
      'amga.created_at',
      'mg.name as group_name',
      'mg.routing_strategy',
      'mg.is_default',
      'mg.owner_workspace_id as workspace_id',
      'mg.owner_type',
      'mg.owner_user_id',
    ])
    .where('amga.actor_id', '=', actorId)
    .where('mg.is_enabled', '=', true);

  if (workspaceId) {
    statement = statement.where((eb) =>
      eb.or([
        eb.and([
          eb('mg.owner_type', '=', 'workspace'),
          eb('mg.owner_workspace_id', '=', workspaceId),
        ]),
        sql<boolean>`EXISTS (
          SELECT 1
          FROM model_group_grants mgg
          WHERE mgg.group_id = mg.id
            AND mgg.status = 'active'
            AND (
              mgg.grant_scope = 'platform'
              OR (mgg.grant_scope = 'workspace' AND mgg.workspace_id = ${workspaceId})
              OR (mgg.grant_scope = 'workspace_user' AND mgg.workspace_id = ${workspaceId})
              OR (mgg.grant_scope = 'actor' AND mgg.workspace_id = ${workspaceId})
            )
        )`,
      ]),
    );
  }

  return statement.orderBy('amga.priority', 'asc').execute();
}

export async function setActorModelGroups(actorId: string, workspaceId: string, groups: { groupId: string; priority: number }[]) {
  await ensureActorInWorkspace(actorId, workspaceId);
  await ensureAssignableModelGroups(workspaceId, groups.map((group) => group.groupId), actorId);

  await db
    .deleteFrom('actor_model_group_assignments')
    .where('actor_id', '=', actorId)
    .execute();
  for (const group of groups) {
    await db
      .insertInto('actor_model_group_assignments')
      .values({
        actor_id: actorId,
        group_id: group.groupId,
        priority: group.priority,
      })
      .execute();
  }
  return getActorModelGroups(actorId, workspaceId);
}

export async function listVisibleActorModelGroups(actorId: string, workspaceId: string) {
  await ensureActorInWorkspace(actorId, workspaceId);

  const result = await db
    .selectFrom('model_groups as mg')
    .distinct()
    .leftJoin('model_group_grants as mgg', (join) =>
      join
        .onRef('mgg.group_id', '=', 'mg.id')
        .on('mgg.status', '=', 'active'),
    )
    .selectAll('mg')
    .select(
      sql<number>`CASE mg.owner_type
        WHEN 'workspace' THEN 0
        WHEN 'platform' THEN 1
        ELSE 2
      END`.as('owner_rank'),
    )
    .where('mg.is_enabled', '=', true)
    .where((eb) =>
      eb.or([
        eb.and([
          eb('mg.owner_type', '=', 'workspace'),
          eb('mg.owner_workspace_id', '=', workspaceId),
        ]),
        eb('mgg.grant_scope', '=', 'platform'),
        eb.and([
          eb('mgg.grant_scope', '=', 'workspace'),
          eb('mgg.workspace_id', '=', workspaceId),
        ]),
        eb.and([
          eb('mgg.grant_scope', '=', 'actor'),
          eb('mgg.workspace_id', '=', workspaceId),
          eb('mgg.actor_id', '=', actorId),
        ]),
      ]),
    )
    .orderBy('owner_rank')
    .orderBy('mg.is_default', 'desc')
    .orderBy('mg.name')
    .execute();

  return result.map((row) => mapGroupRow(row as ModelGroupRow));
}

export async function listModelGroupGrants(groupId: string) {
  await getGroupRow(groupId);
  const result = await db
    .selectFrom('model_group_grants')
    .selectAll()
    .where('group_id', '=', groupId)
    .orderBy('created_at', 'desc')
    .execute();
  return (result as Array<ModelGroupGrantRow & { id: string; group_id: string }>).map(mapGrantRow);
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

  const result = await db
    .insertInto('model_group_grants')
    .values({
      group_id: groupId,
      grant_scope: input.grantScope,
      workspace_id: input.workspaceId || null,
      user_id: input.userId || null,
      actor_id: input.actorId || null,
      status: 'active',
      granted_by: input.grantedBy || null,
      reason: input.reason || null,
      metadata: (input.metadata || {}) as TableInsert<'model_group_grants'>['metadata'],
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const nextState = await loadGroupAuthzState(groupId);
  const authzEntryIds = await enqueueAuthzRelationships(
    diffAuthzRelationships(
      buildModelGroupAuthzRelations(previousState),
      buildModelGroupAuthzRelations(nextState),
    ),
    {
      source: 'model_group.grant.issue',
      groupId,
      grantId: result.id,
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, 'model_group.grant.issue');

  return mapGrantRow(result as ModelGroupGrantRow & { id: string; group_id: string });
}

export async function revokeModelGroupGrant(groupId: string, grantId: string) {
  const previousState = await loadGroupAuthzState(groupId);
  const result = await db
    .updateTable('model_group_grants')
    .set({
      status: 'revoked',
      revoked_at: sql`NOW()`,
    })
    .where('id', '=', grantId)
    .where('group_id', '=', groupId)
    .where('status', '=', 'active')
    .returning('id')
    .executeTakeFirst();
  if (!result) {
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

  let providerType = config.ai.provider;
  let modelName = config.ai.model;
  if (data.profileRevisionId) {
    const revisionRow = await db
      .selectFrom('model_profile_revisions')
      .select(['provider_type', 'model_name'])
      .where('id', '=', data.profileRevisionId)
      .limit(1)
      .executeTakeFirst();
    if (revisionRow) {
      providerType = revisionRow.provider_type as string;
      modelName = revisionRow.model_name || modelName;
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

  const defaultGroupRow = await db
    .selectFrom('platform_settings as ps')
    .innerJoin('model_groups as mg', 'mg.id', 'ps.default_model_group_id')
    .select('ps.default_model_group_id as group_id')
    .where('ps.id', '=', true)
    .where('ps.default_model_group_id', 'is not', null)
    .where('mg.owner_type', '=', 'platform')
    .where('mg.is_enabled', '=', true)
    .limit(1)
    .executeTakeFirst();

  let groupId = defaultGroupRow?.group_id || null;

  if (!groupId) {
    const fallbackGroupRow = await db
      .selectFrom('model_groups')
      .select('id')
      .where('owner_type', '=', 'platform')
      .where('is_enabled', '=', true)
      .orderBy('is_default', 'desc')
      .orderBy('created_at', 'asc')
      .limit(1)
      .executeTakeFirst();

    groupId = fallbackGroupRow?.id || null;

    if (groupId) {
      await clearExistingDefault('platform');
      await db
        .updateTable('model_groups')
        .set({
          is_default: true,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', groupId)
        .execute();
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
    const existingItem = await db
      .selectFrom('model_group_profiles')
      .select('id')
      .where('group_id', '=', groupId)
      .where('is_enabled', '=', true)
      .limit(1)
      .executeTakeFirst();

    if (!existingItem) {
      await addModelItem(groupId, {
        displayName: `${config.ai.model} (env)`,
        priority: 0,
        weight: 100,
        providerType: config.ai.provider,
        engineKind: config.ai.engineKind,
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
