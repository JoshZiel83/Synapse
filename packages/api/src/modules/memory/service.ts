import type {
  CanonicalContentBlock,
  CanonicalContentBlockInput,
  CanonicalContextItem,
  Memory,
  MemoryCategory,
  MemoryGrant,
  MemoryGrantScope,
  MemoryPermission,
  MemoryRecallResult,
  MemoryRecallRun,
  MemoryRecallType,
  MemoryScope,
  MemoryStability,
  MemoryStatus,
  UUID,
} from '@synapse/shared';
import { extractText, normalizeCanonicalContentBlocks, textBlocks } from '@synapse/shared';
import { query, transaction } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { config } from '../../config/index.js';
import {
  authzEnabled,
  buildActorConversationContextId,
  buildWorkspaceUserContextId,
  diffAuthzRelationships,
  flushAuthzOutboxEntries,
  queueAuthzRelationships,
  touchActorConversationContext,
  touchRelation,
  touchWorkspaceUserContext,
  type AuthzRelationMutation,
} from '../../infrastructure/authz/index.js';
import {
  buildMemorySearchText,
  buildMemoryTextDigest,
  reindexMemoryEntry,
} from './indexing.js';
import {
  buildNormalizedMessageContent,
  itemPartsToCanonicalContentBlocks,
  type DraftConversationPart,
} from '../conversation/message-content.js';
import { v4 as uuidv4 } from 'uuid';

type MemoryRow = {
  id: string;
  workspace_id: string;
  owner_scope: MemoryScope;
  owner_actor_id: string | null;
  owner_conversation_id: string | null;
  owner_user_id: string | null;
  category: MemoryCategory;
  status: MemoryStatus;
  stability: MemoryStability;
  importance: number;
  confidence: number;
  tags: string[];
  text_digest: string;
  search_text: string;
  source_item_id: string | null;
  source_tool_call_id: string | null;
  source_turn_id: string | null;
  supersedes_memory_id: string | null;
  metadata: Record<string, unknown> | string | null;
  created_at: string;
  updated_at: string;
  actor_name?: string | null;
  conversation_title?: string | null;
  user_name?: string | null;
};

type MemoryGrantRow = {
  id: string;
  memory_entry_id: string;
  workspace_id: string;
  permission: MemoryPermission;
  grant_scope: MemoryGrantScope;
  actor_id: string | null;
  conversation_id: string | null;
  user_id: string | null;
  status: 'active' | 'revoked';
  granted_by: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | string | null;
  created_at: string;
  revoked_at: string | null;
};

type MemoryPartRow = {
  memory_entry_id: string;
  part_type: string;
  text_value?: string | null;
  file_id?: string | null;
  json_value?: unknown;
  mime_type?: string | null;
  name?: string | null;
  metadata?: Record<string, unknown> | string | null;
  original_name?: string | null;
  stored_name?: string | null;
  file_mime_type?: string | null;
  size_bytes?: number | null;
};

type SearchCandidateRow = MemoryRow & {
  matched_chunk_id: string;
  chunk_search_text: string;
  text_score?: number | null;
  similarity_score?: number | null;
  vector_score?: number | null;
};

type MemoryAccessTarget = {
  actorId?: string;
  conversationId?: string;
  userId?: string;
};

export interface MemoryGrantInput {
  permission?: MemoryPermission;
  grantScope: MemoryGrantScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

async function flushQueuedAuthzEntries(entryIds: string[], source: string) {
  if (!authzEnabled() || entryIds.length === 0) return;

  try {
    await flushAuthzOutboxEntries(entryIds);
  } catch (error) {
    console.error(`[authz] Failed to flush ${source} relationship updates:`, error);
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value as Record<string, unknown>;
}

function formatEmbeddingVector(values: number[]) {
  return `[${values.map((value) => Number.isFinite(value) ? value.toFixed(8) : '0').join(',')}]`;
}

function tokenizeQuery(queryText: string) {
  return Array.from(
    new Set(
      queryText
        .toLowerCase()
        .split(/[^a-z0-9_\u4e00-\u9fff]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  );
}

function computeMatchedTerms(queryText: string, candidateText: string) {
  const queryTokens = tokenizeQuery(queryText);
  const haystack = candidateText.toLowerCase();
  return queryTokens.filter((token) => haystack.includes(token));
}

function scopeRank(scope: MemoryScope | MemoryGrantScope) {
  switch (scope) {
    case 'actor_conversation':
      return 5;
    case 'conversation':
      return 4;
    case 'actor_global':
      return 3;
    case 'workspace_user':
      return 2;
    case 'user':
      return 2;
    case 'workspace':
      return 1;
    default:
      return 0;
  }
}

function ownerMatchesTarget(memory: Pick<MemoryRow, 'owner_scope' | 'owner_actor_id' | 'owner_conversation_id' | 'owner_user_id'>, target: MemoryAccessTarget) {
  switch (memory.owner_scope) {
    case 'workspace':
      return true;
    case 'conversation':
      return Boolean(target.conversationId && memory.owner_conversation_id === target.conversationId);
    case 'actor_global':
      return Boolean(target.actorId && memory.owner_actor_id === target.actorId);
    case 'actor_conversation':
      return Boolean(
        target.actorId &&
        target.conversationId &&
        memory.owner_actor_id === target.actorId &&
        memory.owner_conversation_id === target.conversationId,
      );
    case 'user':
      return Boolean(
        target.userId &&
        memory.owner_user_id === target.userId,
      );
    default:
      return false;
  }
}

function grantMatchesTarget(grant: MemoryGrant, target: MemoryAccessTarget) {
  switch (grant.grantScope) {
    case 'workspace':
      return true;
    case 'conversation':
      return Boolean(target.conversationId && grant.conversationId === target.conversationId);
    case 'actor_global':
      return Boolean(target.actorId && grant.actorId === target.actorId);
    case 'actor_conversation':
      return Boolean(
        target.actorId &&
        target.conversationId &&
        grant.actorId === target.actorId &&
        grant.conversationId === target.conversationId,
      );
    case 'user':
      return Boolean(
        target.userId &&
        grant.userId === target.userId,
      );
    case 'workspace_user':
      return Boolean(
        target.userId &&
        grant.userId === target.userId,
      );
    default:
      return false;
  }
}

function effectiveScopeRank(memory: Memory, target: MemoryAccessTarget) {
  let rank = ownerMatchesTarget(
    {
      owner_scope: memory.ownerScope,
      owner_actor_id: memory.ownerActorId ?? null,
      owner_conversation_id: memory.ownerConversationId ?? null,
      owner_user_id: memory.ownerUserId ?? null,
    },
    target,
  )
    ? scopeRank(memory.ownerScope)
    : 0;

  for (const grant of memory.grants) {
    if (grant.status === 'active' && grantMatchesTarget(grant, target)) {
      rank = Math.max(rank, scopeRank(grant.grantScope));
    }
  }

  return rank;
}

function deriveScopeBoost(memory: Memory, target: MemoryAccessTarget) {
  return effectiveScopeRank(memory, target) * 0.03;
}

function deriveRecencyBoost(updatedAt: string) {
  const ageMs = Math.max(0, Date.now() - new Date(updatedAt).getTime());
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.max(0, 1 - ageDays / 365) * 0.04;
}

function computeFinalScore(
  row: SearchCandidateRow,
  memory: Memory,
  target: MemoryAccessTarget,
) {
  const vectorScore = Math.max(0, row.vector_score ?? 0);
  const textScore = Math.max(0, Math.min(1, row.text_score ?? 0));
  const similarityScore = Math.max(0, Math.min(1, row.similarity_score ?? 0));
  const importanceScore = Math.max(0, Math.min(1, row.importance ?? 0));
  const confidenceScore = Math.max(0, Math.min(1, row.confidence ?? 0));

  return (
    vectorScore * 0.45 +
    textScore * 0.2 +
    similarityScore * 0.08 +
    importanceScore * 0.12 +
    confidenceScore * 0.08 +
    deriveScopeBoost(memory, target) +
    deriveRecencyBoost(row.updated_at)
  );
}

function mapMemoryGrantRow(row: MemoryGrantRow): MemoryGrant {
  return {
    id: row.id,
    memoryId: row.memory_entry_id,
    workspaceId: row.workspace_id,
    permission: row.permission,
    grantScope: row.grant_scope,
    actorId: row.actor_id ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    userId: row.user_id ?? undefined,
    status: row.status,
    grantedBy: row.granted_by ?? undefined,
    reason: row.reason ?? undefined,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? undefined,
  };
}

function normalizeGrantPermission(permission?: MemoryPermission): MemoryPermission {
  return permission || 'read';
}

function mapMemoryRow(row: MemoryRow, contentBlocks: CanonicalContentBlock[], grants: MemoryGrant[]): Memory {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerScope: row.owner_scope,
    ownerActorId: row.owner_actor_id ?? undefined,
    ownerConversationId: row.owner_conversation_id ?? undefined,
    ownerUserId: row.owner_user_id ?? undefined,
    category: row.category,
    status: row.status,
    stability: row.stability,
    importance: Number(row.importance ?? 0),
    confidence: Number(row.confidence ?? 0),
    tags: row.tags ?? [],
    textDigest: row.text_digest || '',
    searchText: row.search_text || '',
    contentBlocks,
    sourceItemId: row.source_item_id ?? undefined,
    sourceToolCallId: row.source_tool_call_id ?? undefined,
    sourceTurnId: row.source_turn_id ?? undefined,
    supersedesMemoryId: row.supersedes_memory_id ?? undefined,
    grants,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    actorName: row.actor_name ?? undefined,
    conversationTitle: row.conversation_title ?? undefined,
    userName: row.user_name ?? undefined,
  };
}

async function loadMemoryEntriesFromRows(rows: MemoryRow[]) {
  if (rows.length === 0) return [];

  const memoryIds = rows.map((row) => row.id);

  const [partsResult, grantsResult] = await Promise.all([
    query<MemoryPartRow>(
      `SELECT mep.*,
              f.original_name,
              f.stored_name,
              f.mime_type AS file_mime_type,
              f.size_bytes
       FROM memory_entry_parts mep
       LEFT JOIN files f ON f.id = mep.file_id
       WHERE mep.memory_entry_id = ANY($1)
       ORDER BY mep.memory_entry_id, mep.ordinal ASC`,
      [memoryIds],
    ),
    query<MemoryGrantRow>(
      `SELECT *
       FROM memory_grants
       WHERE memory_entry_id = ANY($1)
       ORDER BY memory_entry_id, created_at ASC`,
      [memoryIds],
    ),
  ]);

  const partsByMemoryId = new Map<string, MemoryPartRow[]>();
  for (const row of partsResult.rows) {
    if (!partsByMemoryId.has(row.memory_entry_id)) {
      partsByMemoryId.set(row.memory_entry_id, []);
    }
    partsByMemoryId.get(row.memory_entry_id)!.push(row);
  }

  const grantsByMemoryId = new Map<string, MemoryGrant[]>();
  for (const row of grantsResult.rows) {
    if (!grantsByMemoryId.has(row.memory_entry_id)) {
      grantsByMemoryId.set(row.memory_entry_id, []);
    }
    grantsByMemoryId.get(row.memory_entry_id)!.push(mapMemoryGrantRow(row));
  }

  return rows.map((row) =>
    mapMemoryRow(
      row,
      itemPartsToCanonicalContentBlocks(partsByMemoryId.get(row.id) || []),
      grantsByMemoryId.get(row.id) || [],
    ),
  );
}

async function getMemoryRow(workspaceId: string, memoryId: string) {
  const result = await query<MemoryRow>(
    `SELECT me.*,
            a.name AS actor_name,
            c.title AS conversation_title,
            u.name AS user_name
     FROM memory_entries me
     LEFT JOIN actors a ON a.id = me.owner_actor_id
     LEFT JOIN conversations c ON c.id = me.owner_conversation_id
     LEFT JOIN users u ON u.id = me.owner_user_id
     WHERE me.workspace_id = $1 AND me.id = $2
     LIMIT 1`,
    [workspaceId, memoryId],
  );
  return result.rows[0] ?? null;
}

function validateMemoryOwnerBinding(input: {
  scope: MemoryScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
}, label: string) {
  switch (input.scope) {
    case 'workspace':
      if (input.actorId || input.conversationId || input.userId) {
        throw new MemoryError(`${label} workspace scope cannot include actorId, conversationId, or userId`, 400);
      }
      break;
    case 'conversation':
      if (!input.conversationId || input.actorId || input.userId) {
        throw new MemoryError(`${label} conversation scope requires conversationId and no actorId or userId`, 400);
      }
      break;
    case 'actor_global':
      if (!input.actorId || input.conversationId || input.userId) {
        throw new MemoryError(`${label} actor_global scope requires actorId and no conversationId or userId`, 400);
      }
      break;
    case 'actor_conversation':
      if (!input.actorId || !input.conversationId || input.userId) {
        throw new MemoryError(`${label} actor_conversation scope requires actorId and conversationId and no userId`, 400);
      }
      break;
    case 'user':
      if (!input.userId || input.actorId || input.conversationId) {
        throw new MemoryError(`${label} user scope requires userId and no actorId or conversationId`, 400);
      }
      break;
  }
}

function validateMemoryGrantBinding(input: {
  scope: MemoryGrantScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
}, label: string) {
  if (input.scope === 'workspace_user') {
    if (!input.userId || input.actorId || input.conversationId) {
      throw new MemoryError(`${label} workspace_user scope requires userId and no actorId or conversationId`, 400);
    }
    return;
  }

  validateMemoryOwnerBinding(
    {
      scope: input.scope,
      actorId: input.actorId,
      conversationId: input.conversationId,
      userId: input.userId,
    },
    label,
  );
}

function normalizeGrantInputs(grants?: MemoryGrantInput[]) {
  return Array.isArray(grants)
    ? grants.map((grant) => ({
        ...grant,
        permission: normalizeGrantPermission(grant.permission),
      }))
    : [];
}

function buildMemoryOwnerRelations(params: {
  workspaceId: string;
  memoryId: string;
  scope: MemoryScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
}): AuthzRelationMutation[] {
  switch (params.scope) {
    case 'workspace':
      return [
        touchRelation('memory', params.memoryId, 'owner_workspace', 'workspace', params.workspaceId),
      ];
    case 'conversation':
      return params.conversationId
        ? [touchRelation('memory', params.memoryId, 'owner_conversation', 'conversation', params.conversationId)]
        : [];
    case 'actor_global':
      return params.actorId
        ? [touchRelation('memory', params.memoryId, 'owner_actor', 'actor', params.actorId)]
        : [];
    case 'actor_conversation':
      return params.actorId && params.conversationId
        ? [
            ...touchActorConversationContext(params.actorId, params.conversationId),
            touchRelation(
              'memory',
              params.memoryId,
              'owner_actor_conversation',
              'actor_conversation',
              buildActorConversationContextId(params.actorId, params.conversationId),
            ),
          ]
        : [];
    case 'user':
      return params.userId
        ? [touchRelation('memory', params.memoryId, 'owner_user', 'user', params.userId)]
        : [];
    default:
      return [];
  }
}

function buildMemoryGrantRelationName(permission: MemoryPermission, scope: MemoryGrantScope) {
  switch (permission) {
    case 'read':
      switch (scope) {
        case 'workspace':
          return 'reader_workspace';
        case 'workspace_user':
          return 'reader_workspace_user';
        case 'conversation':
          return 'reader_conversation';
        case 'actor_conversation':
          return 'reader_actor_conversation';
        default:
          return 'reader_principal';
      }
    case 'edit':
      switch (scope) {
        case 'workspace':
          return 'editor_workspace';
        case 'workspace_user':
          return 'editor_workspace_user';
        case 'conversation':
          return 'editor_conversation';
        case 'actor_conversation':
          return 'editor_actor_conversation';
        default:
          return 'editor_principal';
      }
    case 'grant':
      switch (scope) {
        case 'workspace':
          return 'granter_workspace';
        case 'workspace_user':
          return 'granter_workspace_user';
        case 'conversation':
          return 'granter_conversation';
        case 'actor_conversation':
          return 'granter_actor_conversation';
        default:
          return 'granter_principal';
      }
    case 'retarget':
      switch (scope) {
        case 'workspace':
          return 'retargeter_workspace';
        case 'workspace_user':
          return 'retargeter_workspace_user';
        case 'conversation':
          return 'retargeter_conversation';
        case 'actor_conversation':
          return 'retargeter_actor_conversation';
        default:
          return 'retargeter_principal';
      }
    case 'delete':
      switch (scope) {
        case 'workspace':
          return 'deleter_workspace';
        case 'workspace_user':
          return 'deleter_workspace_user';
        case 'conversation':
          return 'deleter_conversation';
        case 'actor_conversation':
          return 'deleter_actor_conversation';
        default:
          return 'deleter_principal';
      }
    default:
      return null;
  }
}

function buildMemoryGrantRelations(params: {
  workspaceId: string;
  memoryId: string;
  permission: MemoryPermission;
  scope: MemoryGrantScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
}): AuthzRelationMutation[] {
  const relation = buildMemoryGrantRelationName(params.permission, params.scope);
  if (!relation) {
    return [];
  }

  switch (params.scope) {
    case 'workspace':
      return [touchRelation('memory', params.memoryId, relation, 'workspace', params.workspaceId)];
    case 'workspace_user':
      return params.userId
        ? [
            ...touchWorkspaceUserContext(params.workspaceId, params.userId),
            touchRelation(
              'memory',
              params.memoryId,
              relation,
              'workspace_user',
              buildWorkspaceUserContextId(params.workspaceId, params.userId),
            ),
          ]
        : [];
    case 'conversation':
      return params.conversationId
        ? [touchRelation('memory', params.memoryId, relation, 'conversation', params.conversationId)]
        : [];
    case 'actor_global':
      return params.actorId
        ? [touchRelation('memory', params.memoryId, relation, 'actor', params.actorId)]
        : [];
    case 'actor_conversation':
      return params.actorId && params.conversationId
        ? [
            ...touchActorConversationContext(params.actorId, params.conversationId),
            touchRelation(
              'memory',
              params.memoryId,
              relation,
              'actor_conversation',
              buildActorConversationContextId(params.actorId, params.conversationId),
            ),
          ]
        : [];
    case 'user':
      return params.userId
        ? [touchRelation('memory', params.memoryId, relation, 'user', params.userId)]
        : [];
    default:
      return [];
  }
}

function buildMemoryAuthzRelations(params: {
  workspaceId: string;
  memoryId: string;
  ownerScope: MemoryScope;
  ownerActorId?: string;
  ownerConversationId?: string;
  ownerUserId?: string;
  grants: MemoryGrantInput[];
}): AuthzRelationMutation[] {
  return [
    touchRelation('memory', params.memoryId, 'workspace', 'workspace', params.workspaceId),
    ...buildMemoryOwnerRelations({
      workspaceId: params.workspaceId,
      memoryId: params.memoryId,
      scope: params.ownerScope,
      actorId: params.ownerActorId,
      conversationId: params.ownerConversationId,
      userId: params.ownerUserId,
    }),
    ...params.grants.flatMap((grant) =>
      buildMemoryGrantRelations({
        workspaceId: params.workspaceId,
        memoryId: params.memoryId,
        permission: normalizeGrantPermission(grant.permission),
        scope: grant.grantScope,
        actorId: grant.actorId,
        conversationId: grant.conversationId,
        userId: grant.userId,
      }),
    ),
  ];
}

async function assertUserExists(userId: string) {
  const result = await query(
    `SELECT 1
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId],
  );
  if (result.rows.length === 0) {
    throw new MemoryError('User not found', 404);
  }
}

async function assertWorkspaceMember(workspaceId: string, userId: string) {
  const result = await query(
    `SELECT 1
     FROM workspace_members
     WHERE workspace_id = $1
       AND user_id = $2
     LIMIT 1`,
    [workspaceId, userId],
  );
  if (result.rows.length === 0) {
    throw new MemoryError('User is not a member of this workspace', 400);
  }
}

async function assertActorInWorkspace(workspaceId: string, actorId: string) {
  const result = await query(
    `SELECT 1
     FROM actors
     WHERE id = $1
       AND workspace_id = $2
       AND is_active = true
     LIMIT 1`,
    [actorId, workspaceId],
  );
  if (result.rows.length === 0) {
    throw new MemoryError('Actor not found in this workspace', 404);
  }
}

async function assertConversationInWorkspace(workspaceId: string, conversationId: string) {
  const result = await query(
    `SELECT 1
     FROM conversations
     WHERE id = $1
       AND workspace_id = $2
     LIMIT 1`,
    [conversationId, workspaceId],
  );
  if (result.rows.length === 0) {
    throw new MemoryError('Conversation not found in this workspace', 404);
  }
}

async function assertActorInConversation(conversationId: string, actorId: string) {
  const result = await query(
    `SELECT 1
     FROM conversation_members
     WHERE conversation_id = $1
       AND actor_id = $2
       AND state = 'active'
     LIMIT 1`,
    [conversationId, actorId],
  );
  if (result.rows.length === 0) {
    throw new MemoryError('Actor is not an active member of this conversation', 400);
  }
}

async function validateMemoryOwnerTarget(workspaceId: string, input: {
  scope: MemoryScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
}) {
  switch (input.scope) {
    case 'workspace':
      return;
    case 'conversation':
      if (input.conversationId) {
        await assertConversationInWorkspace(workspaceId, input.conversationId);
      }
      return;
    case 'actor_global':
      if (input.actorId) {
        await assertActorInWorkspace(workspaceId, input.actorId);
      }
      return;
    case 'actor_conversation':
      if (input.actorId && input.conversationId) {
        await assertActorInWorkspace(workspaceId, input.actorId);
        await assertConversationInWorkspace(workspaceId, input.conversationId);
        await assertActorInConversation(input.conversationId, input.actorId);
      }
      return;
    case 'user':
      if (input.userId) {
        await assertUserExists(input.userId);
      }
      return;
  }
}

async function validateMemoryGrantTarget(workspaceId: string, input: {
  scope: MemoryGrantScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
}) {
  switch (input.scope) {
    case 'workspace':
      return;
    case 'workspace_user':
      if (input.userId) {
        await assertUserExists(input.userId);
        await assertWorkspaceMember(workspaceId, input.userId);
      }
      return;
    case 'conversation':
      if (input.conversationId) {
        await assertConversationInWorkspace(workspaceId, input.conversationId);
      }
      return;
    case 'actor_global':
      if (input.actorId) {
        await assertActorInWorkspace(workspaceId, input.actorId);
      }
      return;
    case 'actor_conversation':
      if (input.actorId && input.conversationId) {
        await assertActorInWorkspace(workspaceId, input.actorId);
        await assertConversationInWorkspace(workspaceId, input.conversationId);
        await assertActorInConversation(input.conversationId, input.actorId);
      }
      return;
    case 'user':
      if (input.userId) {
        await assertUserExists(input.userId);
      }
      return;
  }
}

async function normalizeMemoryContent(input: {
  content?: string;
  contentBlocks?: CanonicalContentBlockInput[];
  textDigest?: string;
  searchText?: string;
  tags?: string[];
  category?: string;
}) {
  const normalized = await buildNormalizedMessageContent({
    content: input.content || '',
    contentBlocks: input.contentBlocks,
    metadata: {},
  });

  const textDigest = (input.textDigest || '').trim() || buildMemoryTextDigest({
    contentBlocks: normalized.contentBlocks,
  });
  const searchText = (input.searchText || '').trim() || buildMemorySearchText({
    contentBlocks: normalized.contentBlocks,
    textDigest,
    tags: input.tags,
    category: input.category,
  });

  if (!textDigest && !searchText && normalized.contentBlocks.length === 0) {
    throw new MemoryError('Memory content is required', 400);
  }

  return {
    parts: normalized.parts,
    contentBlocks: normalized.contentBlocks,
    textDigest,
    searchText,
  };
}

async function insertMemoryParts(client: { query: (...args: any[]) => Promise<any> }, memoryId: string, parts: DraftConversationPart[]) {
  for (let ordinal = 0; ordinal < parts.length; ordinal += 1) {
    const part = parts[ordinal];
    await client.query(
      `INSERT INTO memory_entry_parts
         (id, memory_entry_id, ordinal, part_type, text_value, file_id, json_value, mime_type, name, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        uuidv4(),
        memoryId,
        ordinal,
        part.type,
        part.type === 'text' ? part.text || '' : null,
        part.type === 'file_ref' ? part.fileId || null : null,
        part.type === 'json' ? JSON.stringify(part.json ?? {}) : null,
        part.mimeType || null,
        part.name || null,
        JSON.stringify(part.metadata || {}),
      ],
    );
  }
}

async function replaceMemoryGrants(
  client: { query: (...args: any[]) => Promise<any> },
  workspaceId: string,
  memoryId: string,
  grants: MemoryGrantInput[],
  grantedBy?: string,
) {
  await client.query(`DELETE FROM memory_grants WHERE memory_entry_id = $1`, [memoryId]);

  for (const grant of grants) {
    const permission = normalizeGrantPermission(grant.permission);
    validateMemoryGrantBinding(
      {
        scope: grant.grantScope,
        actorId: grant.actorId,
        conversationId: grant.conversationId,
        userId: grant.userId,
      },
      'Memory grant',
    );
    await validateMemoryGrantTarget(workspaceId, {
      scope: grant.grantScope,
      actorId: grant.actorId,
      conversationId: grant.conversationId,
      userId: grant.userId,
    });

    await client.query(
      `INSERT INTO memory_grants
         (id, memory_entry_id, workspace_id, permission, grant_scope, actor_id, conversation_id, user_id, status, granted_by, reason, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, $11, NOW())`,
      [
        uuidv4(),
        memoryId,
        workspaceId,
        permission,
        grant.grantScope,
        grant.actorId || null,
        grant.conversationId || null,
        grant.userId || null,
        grantedBy || null,
        grant.reason || null,
        JSON.stringify(grant.metadata || {}),
      ],
    );
  }
}

async function maybeMarkSuperseded(client: { query: (...args: any[]) => Promise<any> }, memoryId?: string) {
  if (!memoryId) return;
  await client.query(
    `UPDATE memory_entries
     SET status = 'superseded'
     WHERE id = $1`,
    [memoryId],
  );
}

export interface CreateMemoryInput {
  ownerScope: MemoryScope;
  ownerActorId?: string;
  ownerConversationId?: string;
  ownerUserId?: string;
  grants?: MemoryGrantInput[];
  category: MemoryCategory;
  status?: MemoryStatus;
  stability?: MemoryStability;
  importance?: number;
  confidence?: number;
  tags?: string[];
  content?: string;
  contentBlocks?: CanonicalContentBlockInput[];
  textDigest?: string;
  searchText?: string;
  sourceItemId?: string;
  sourceToolCallId?: string;
  sourceTurnId?: string;
  supersedesMemoryId?: string;
  metadata?: Record<string, unknown>;
  grantedBy?: string;
}

export interface UpdateMemoryInput {
  ownerScope?: MemoryScope;
  ownerActorId?: string;
  ownerConversationId?: string;
  ownerUserId?: string;
  grants?: MemoryGrantInput[];
  category?: MemoryCategory;
  status?: MemoryStatus;
  stability?: MemoryStability;
  importance?: number;
  confidence?: number;
  tags?: string[];
  content?: string;
  contentBlocks?: CanonicalContentBlockInput[];
  textDigest?: string;
  searchText?: string;
  sourceItemId?: string;
  sourceToolCallId?: string;
  sourceTurnId?: string;
  supersedesMemoryId?: string;
  metadata?: Record<string, unknown>;
  grantedBy?: string;
}

export interface ListMemoriesInput extends MemoryAccessTarget {
  ownerScope?: MemoryScope;
  category?: MemoryCategory;
  status?: MemoryStatus;
  stability?: MemoryStability;
  tags?: string[];
  limit?: number;
}

export interface SearchMemoriesInput extends MemoryAccessTarget {
  queryText: string;
  scopes?: MemoryScope[];
  categories?: MemoryCategory[];
  statuses?: MemoryStatus[];
  stabilities?: MemoryStability[];
  limit?: number;
  metadata?: Record<string, unknown>;
}

export interface RecallMemoriesInput extends SearchMemoriesInput {
  recallType: Exclude<MemoryRecallType, 'manual_search'>;
  queryBlocks?: CanonicalContentBlockInput[];
}

function buildVisibilityClause(target: MemoryAccessTarget, startIndex: number, alias = 'me') {
  const ownerClauses = [`${alias}.owner_scope = 'workspace'`];
  const grantClauses = [`(mg.permission = 'read' AND mg.grant_scope = 'workspace')`];
  const params: unknown[] = [];
  let index = startIndex;

  if (target.conversationId) {
    ownerClauses.push(`(${alias}.owner_scope = 'conversation' AND ${alias}.owner_conversation_id = $${index})`);
    grantClauses.push(`(mg.permission = 'read' AND mg.grant_scope = 'conversation' AND mg.conversation_id = $${index})`);
    params.push(target.conversationId);
    index += 1;
  }

  if (target.actorId) {
    ownerClauses.push(`(${alias}.owner_scope = 'actor_global' AND ${alias}.owner_actor_id = $${index})`);
    grantClauses.push(`(mg.permission = 'read' AND mg.grant_scope = 'actor_global' AND mg.actor_id = $${index})`);
    params.push(target.actorId);
    index += 1;
  }

  if (target.actorId && target.conversationId) {
    ownerClauses.push(
      `(${alias}.owner_scope = 'actor_conversation' AND ${alias}.owner_actor_id = $${index} AND ${alias}.owner_conversation_id = $${index + 1})`,
    );
    grantClauses.push(
      `(mg.permission = 'read' AND mg.grant_scope = 'actor_conversation' AND mg.actor_id = $${index} AND mg.conversation_id = $${index + 1})`,
    );
    params.push(target.actorId, target.conversationId);
    index += 2;
  }

  if (target.userId) {
    ownerClauses.push(
      `(${alias}.owner_scope = 'user' AND ${alias}.owner_user_id = $${index})`,
    );
    grantClauses.push(
      `(mg.permission = 'read' AND ((mg.grant_scope = 'user' AND mg.user_id = $${index}) OR (mg.grant_scope = 'workspace_user' AND mg.user_id = $${index})))`,
    );
    params.push(target.userId);
    index += 1;
  }

  const clause = `(${ownerClauses.join(' OR ')} OR EXISTS (
    SELECT 1
    FROM memory_grants mg
    WHERE mg.memory_entry_id = ${alias}.id
      AND mg.status = 'active'
      AND (${grantClauses.join(' OR ')})
  ))`;

  return { clause, params, nextIndex: index };
}

function buildListWhereClause(workspaceId: string, input: ListMemoriesInput) {
  const conditions = ['me.workspace_id = $1'];
  const params: unknown[] = [workspaceId];
  let index = 2;

  if (input.actorId || input.conversationId || input.userId) {
    const visibility = buildVisibilityClause(input, index);
    conditions.push(visibility.clause);
    params.push(...visibility.params);
    index = visibility.nextIndex;
  }

  if (input.ownerScope) {
    conditions.push(`me.owner_scope = $${index}`);
    params.push(input.ownerScope);
    index += 1;
  }
  if (input.category) {
    conditions.push(`me.category = $${index}`);
    params.push(input.category);
    index += 1;
  }
  if (input.status) {
    conditions.push(`me.status = $${index}`);
    params.push(input.status);
    index += 1;
  }
  if (input.stability) {
    conditions.push(`me.stability = $${index}`);
    params.push(input.stability);
    index += 1;
  }
  if (input.tags && input.tags.length > 0) {
    conditions.push(`me.tags && $${index}`);
    params.push(input.tags);
    index += 1;
  }

  return { whereClause: conditions.join(' AND '), params, nextIndex: index };
}

function buildSearchFilters(workspaceId: string, input: SearchMemoriesInput, alias = 'me') {
  const conditions = [`${alias}.workspace_id = $1`];
  const params: unknown[] = [workspaceId];
  let index = 2;

  if (input.actorId || input.conversationId || input.userId) {
    const visibility = buildVisibilityClause(input, index, alias);
    conditions.push(visibility.clause);
    params.push(...visibility.params);
    index = visibility.nextIndex;
  }

  const scopes = input.scopes && input.scopes.length > 0 ? input.scopes : undefined;
  if (scopes) {
    conditions.push(
      `(${alias}.owner_scope = ANY($${index}::text[]) OR EXISTS (
         SELECT 1 FROM memory_grants mg_scope
         WHERE mg_scope.memory_entry_id = ${alias}.id
           AND mg_scope.status = 'active'
           AND mg_scope.permission = 'read'
           AND mg_scope.grant_scope = ANY($${index}::text[])
       ))`,
    );
    params.push(scopes);
    index += 1;
  }

  if (input.categories && input.categories.length > 0) {
    conditions.push(`${alias}.category = ANY($${index}::text[])`);
    params.push(input.categories);
    index += 1;
  }

  const statuses = input.statuses && input.statuses.length > 0 ? input.statuses : ['established'];
  conditions.push(`${alias}.status = ANY($${index}::text[])`);
  params.push(statuses);
  index += 1;

  const stabilities = input.stabilities && input.stabilities.length > 0 ? input.stabilities : ['durable'];
  conditions.push(`${alias}.stability = ANY($${index}::text[])`);
  params.push(stabilities);
  index += 1;

  return { whereClause: conditions.join(' AND '), params, nextIndex: index };
}

async function generateSearchEmbedding(queryText: string) {
  if (!queryText.trim()) return null;
  const baseUrl = config.memory.embeddings.baseUrl.replace(/\/+$/, '');
  if (!config.memory.embeddings.apiKey || !baseUrl || !config.memory.embeddings.model || config.memory.embeddings.dimensions !== 1536) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.memory.embeddings.timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.memory.embeddings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.memory.embeddings.model,
        input: queryText,
        dimensions: config.memory.embeddings.dimensions,
      }),
      signal: controller.signal,
    });

    if (!response.ok) return null;
    const data = await response.json() as { data?: Array<{ embedding: number[] }> };
    return data.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function searchLexicalCandidates(workspaceId: string, input: SearchMemoriesInput, candidateLimit: number) {
  const { whereClause, params, nextIndex } = buildSearchFilters(workspaceId, input);
  const queryText = input.queryText.trim();
  const result = await query<SearchCandidateRow>(
    `SELECT me.*,
            a.name AS actor_name,
            c.title AS conversation_title,
            u.name AS user_name,
            mic.id AS matched_chunk_id,
            mic.search_text AS chunk_search_text,
            ts_rank_cd(to_tsvector('simple', mic.search_text), websearch_to_tsquery('simple', $${nextIndex})) AS text_score,
            similarity(mic.search_text, $${nextIndex}) AS similarity_score,
            NULL::real AS vector_score
     FROM memory_index_chunks mic
     JOIN memory_entries me ON me.id = mic.memory_entry_id
     LEFT JOIN actors a ON a.id = me.owner_actor_id
     LEFT JOIN conversations c ON c.id = me.owner_conversation_id
     LEFT JOIN users u ON u.id = me.owner_user_id
     WHERE ${whereClause}
       AND (
         to_tsvector('simple', mic.search_text) @@ websearch_to_tsquery('simple', $${nextIndex})
         OR similarity(mic.search_text, $${nextIndex}) > 0.08
       )
     ORDER BY text_score DESC, similarity_score DESC, me.importance DESC, me.updated_at DESC
     LIMIT $${nextIndex + 1}`,
    [...params, queryText, candidateLimit],
  );

  return result.rows;
}

async function searchFallbackCandidates(workspaceId: string, input: SearchMemoriesInput, candidateLimit: number) {
  const { whereClause, params, nextIndex } = buildSearchFilters(workspaceId, input);
  const result = await query<SearchCandidateRow>(
    `SELECT me.*,
            a.name AS actor_name,
            c.title AS conversation_title,
            u.name AS user_name,
            mic.id AS matched_chunk_id,
            COALESCE(mic.search_text, me.search_text) AS chunk_search_text,
            NULL::real AS text_score,
            NULL::real AS similarity_score,
            NULL::real AS vector_score
     FROM memory_entries me
     LEFT JOIN actors a ON a.id = me.owner_actor_id
     LEFT JOIN conversations c ON c.id = me.owner_conversation_id
     LEFT JOIN users u ON u.id = me.owner_user_id
     LEFT JOIN LATERAL (
       SELECT id, search_text
       FROM memory_index_chunks
       WHERE memory_entry_id = me.id
       ORDER BY chunk_index ASC
       LIMIT 1
     ) mic ON TRUE
     WHERE ${whereClause}
     ORDER BY me.importance DESC, me.confidence DESC, me.updated_at DESC
     LIMIT $${nextIndex}`,
    [...params, candidateLimit],
  );

  return result.rows;
}

async function searchVectorCandidates(workspaceId: string, input: SearchMemoriesInput, embedding: number[], candidateLimit: number) {
  const { whereClause, params, nextIndex } = buildSearchFilters(workspaceId, input);
  const result = await query<SearchCandidateRow>(
    `SELECT me.*,
            a.name AS actor_name,
            c.title AS conversation_title,
            u.name AS user_name,
            mic.id AS matched_chunk_id,
            mic.search_text AS chunk_search_text,
            NULL::real AS text_score,
            NULL::real AS similarity_score,
            (1 - (mic.embedding <=> $${nextIndex}::vector))::real AS vector_score
     FROM memory_index_chunks mic
     JOIN memory_entries me ON me.id = mic.memory_entry_id
     LEFT JOIN actors a ON a.id = me.owner_actor_id
     LEFT JOIN conversations c ON c.id = me.owner_conversation_id
     LEFT JOIN users u ON u.id = me.owner_user_id
     WHERE ${whereClause}
       AND mic.embedding IS NOT NULL
     ORDER BY mic.embedding <=> $${nextIndex}::vector ASC
     LIMIT $${nextIndex + 1}`,
    [...params, formatEmbeddingVector(embedding), candidateLimit],
  );

  return result.rows;
}

async function buildSearchHits(rows: SearchCandidateRow[], queryText: string, target: MemoryAccessTarget, limit: number) {
  const bestByMemoryId = new Map<string, SearchCandidateRow>();
  for (const row of rows) {
    const existing = bestByMemoryId.get(row.id);
    if (!existing || (existing.vector_score ?? 0) + (existing.text_score ?? 0) + (existing.similarity_score ?? 0) < (row.vector_score ?? 0) + (row.text_score ?? 0) + (row.similarity_score ?? 0)) {
      bestByMemoryId.set(row.id, row);
    }
  }

  const candidateRows = Array.from(bestByMemoryId.values());
  const memories = await loadMemoryEntriesFromRows(candidateRows);
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));

  const orderedRows = candidateRows
    .map((row) => {
      const memory = memoryById.get(row.id)!;
      return {
        row,
        memory,
        finalScore: computeFinalScore(row, memory, target),
      };
    })
    .sort((left, right) => right.finalScore - left.finalScore)
    .slice(0, limit);

  return orderedRows.map(({ row, memory, finalScore }, index) => {
    const matchedGrantIds = memory.grants
      .filter((grant) => grant.status === 'active' && grantMatchesTarget(grant, target))
      .map((grant) => grant.id);

    return {
      ...memory,
      matchedChunkId: row.matched_chunk_id,
      rank: index + 1,
      finalScore,
      vectorScore: row.vector_score ?? undefined,
      textScore: row.text_score ?? undefined,
      similarityScore: row.similarity_score ?? undefined,
      matchedTerms: computeMatchedTerms(queryText, row.chunk_search_text),
      matchedGrantIds,
    } satisfies MemoryRecallResult;
  });
}

async function recordMemoryRecallRun(params: {
  workspaceId: string;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  recallType: MemoryRecallType;
  queryText: string;
  queryBlocks?: CanonicalContentBlockInput[];
  metadata?: Record<string, unknown>;
  results: MemoryRecallResult[];
}): Promise<MemoryRecallRun> {
  const normalizedQueryBlocks = normalizeCanonicalContentBlocks(params.queryBlocks || []);
  const runId = uuidv4();
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO memory_recall_runs
         (id, workspace_id, actor_id, conversation_id, user_id, recall_type, query_text, query_blocks, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [
        runId,
        params.workspaceId,
        params.actorId || null,
        params.conversationId || null,
        params.userId || null,
        params.recallType,
        params.queryText,
        JSON.stringify(normalizedQueryBlocks),
        JSON.stringify(params.metadata || {}),
      ],
    );

    for (const result of params.results) {
      await client.query(
        `INSERT INTO memory_recall_run_results
           (id, run_id, memory_entry_id, matched_chunk_id, rank, final_score, vector_score, text_score, similarity_score, matched_terms, recall_reason, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
        [
          uuidv4(),
          runId,
          result.id,
          result.matchedChunkId || null,
          result.rank,
          result.finalScore,
          result.vectorScore ?? null,
          result.textScore ?? null,
          result.similarityScore ?? null,
          result.matchedTerms ?? [],
          result.recallReason || null,
          JSON.stringify({
            ownerScope: result.ownerScope,
            category: result.category,
            matchedGrantIds: result.matchedGrantIds || [],
          }),
        ],
      );
    }
  });

  return {
    id: runId,
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    conversationId: params.conversationId,
    userId: params.userId,
    recallType: params.recallType,
    queryText: params.queryText,
    queryBlocks: normalizedQueryBlocks,
    metadata: params.metadata || {},
    createdAt: new Date().toISOString(),
    results: params.results,
  };
}

function buildDefaultRecallReason(memory: Memory, target: MemoryAccessTarget) {
  const bestRank = effectiveScopeRank(memory, target);
  switch (bestRank) {
    case 5:
      return 'Private actor-conversation memory strongly matched the current task';
    case 4:
      return 'Conversation-shared memory matched the current discussion';
    case 3:
      return 'Actor global memory matched the current task';
    case 2:
      return 'User-scoped memory matched the current user context';
    default:
      return 'Workspace memory matched the current task';
  }
}

export async function createMemory(workspaceId: UUID, input: CreateMemoryInput) {
  validateMemoryOwnerBinding(
    {
      scope: input.ownerScope,
      actorId: input.ownerActorId,
      conversationId: input.ownerConversationId,
      userId: input.ownerUserId,
    },
    'Memory owner',
  );
  await validateMemoryOwnerTarget(workspaceId, {
    scope: input.ownerScope,
    actorId: input.ownerActorId,
    conversationId: input.ownerConversationId,
    userId: input.ownerUserId,
  });

  const grants = normalizeGrantInputs(input.grants);
  const normalizedContent = await normalizeMemoryContent(input);
  const memoryId = uuidv4();

  const authzEntryIds = await transaction(async (client) => {
    await client.query(
      `INSERT INTO memory_entries
         (id, workspace_id, owner_scope, owner_actor_id, owner_conversation_id, owner_user_id, category, status, stability, importance, confidence,
          tags, text_digest, search_text, source_item_id, source_tool_call_id, source_turn_id, supersedes_memory_id, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               $12, $13, $14, $15, $16, $17, $18, $19, NOW(), NOW())`,
      [
        memoryId,
        workspaceId,
        input.ownerScope,
        input.ownerActorId || null,
        input.ownerConversationId || null,
        input.ownerUserId || null,
        input.category,
        input.status || 'established',
        input.stability || 'durable',
        input.importance ?? 0.5,
        input.confidence ?? 0.8,
        input.tags || [],
        normalizedContent.textDigest,
        normalizedContent.searchText,
        input.sourceItemId || null,
        input.sourceToolCallId || null,
        input.sourceTurnId || null,
        input.supersedesMemoryId || null,
        JSON.stringify(input.metadata || {}),
      ],
    );
    await insertMemoryParts(client, memoryId, normalizedContent.parts);
    await replaceMemoryGrants(client, workspaceId, memoryId, grants, input.grantedBy);
    await maybeMarkSuperseded(client, input.supersedesMemoryId);
    return queueAuthzRelationships(
      client,
      buildMemoryAuthzRelations({
        workspaceId,
        memoryId,
        ownerScope: input.ownerScope,
        ownerActorId: input.ownerActorId,
        ownerConversationId: input.ownerConversationId,
        ownerUserId: input.ownerUserId,
        grants,
      }),
      {
        source: 'memory.create',
        workspaceId,
        memoryId,
      },
    );
  });

  await flushQueuedAuthzEntries(authzEntryIds, 'memory.create');

  await reindexMemoryEntry(memoryId);

  const memory = await getMemory(workspaceId, memoryId);
  await emitEvent({
    type: 'memory.created',
    workspaceId,
    payload: {
      memoryId: memory.id,
      ownerScope: memory.ownerScope,
      ownerActorId: memory.ownerActorId,
      ownerConversationId: memory.ownerConversationId,
      ownerUserId: memory.ownerUserId,
      grantCount: memory.grants.length,
    },
    timestamp: new Date().toISOString(),
  });
  return memory;
}

export async function getMemory(workspaceId: UUID, memoryId: UUID) {
  const row = await getMemoryRow(workspaceId, memoryId);
  if (!row) {
    throw new MemoryError('Memory not found', 404);
  }
  const [memory] = await loadMemoryEntriesFromRows([row]);
  return memory;
}

export async function updateMemory(workspaceId: UUID, memoryId: UUID, input: UpdateMemoryInput) {
  const existing = await getMemory(workspaceId, memoryId);
  const ownerScope = input.ownerScope || existing.ownerScope;
  const ownerActorId = input.ownerActorId !== undefined ? input.ownerActorId : existing.ownerActorId;
  const ownerConversationId = input.ownerConversationId !== undefined ? input.ownerConversationId : existing.ownerConversationId;
  const ownerUserId = input.ownerUserId !== undefined ? input.ownerUserId : existing.ownerUserId;

  validateMemoryOwnerBinding(
    {
      scope: ownerScope,
      actorId: ownerActorId,
      conversationId: ownerConversationId,
      userId: ownerUserId,
    },
    'Memory owner',
  );
  await validateMemoryOwnerTarget(workspaceId, {
    scope: ownerScope,
    actorId: ownerActorId || undefined,
    conversationId: ownerConversationId || undefined,
    userId: ownerUserId || undefined,
  });

  const normalizedContent = await normalizeMemoryContent({
    content: input.content,
    contentBlocks: input.contentBlocks || (input.content === undefined ? existing.contentBlocks : undefined),
    textDigest: input.textDigest || (input.content === undefined && !input.contentBlocks ? existing.textDigest : undefined),
    searchText: input.searchText,
    tags: input.tags || existing.tags,
    category: input.category || existing.category,
  });

  const nextGrants = input.grants !== undefined
    ? normalizeGrantInputs(input.grants)
    : existing.grants.map((grant) => ({
        permission: grant.permission,
        grantScope: grant.grantScope,
        actorId: grant.actorId,
        conversationId: grant.conversationId,
        userId: grant.userId,
        reason: grant.reason,
        metadata: grant.metadata,
      }));

  const authzEntryIds = await transaction(async (client) => {
    await client.query(
      `UPDATE memory_entries
       SET owner_scope = $3,
           owner_actor_id = $4,
           owner_conversation_id = $5,
           owner_user_id = $6,
           category = $7,
           status = $8,
           stability = $9,
           importance = $10,
           confidence = $11,
           tags = $12,
           text_digest = $13,
           search_text = $14,
           source_item_id = $15,
           source_tool_call_id = $16,
           source_turn_id = $17,
           supersedes_memory_id = $18,
           metadata = $19,
           updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2`,
      [
        memoryId,
        workspaceId,
        ownerScope,
        ownerActorId || null,
        ownerConversationId || null,
        ownerUserId || null,
        input.category || existing.category,
        input.status || existing.status,
        input.stability || existing.stability,
        input.importance ?? existing.importance,
        input.confidence ?? existing.confidence,
        input.tags || existing.tags,
        normalizedContent.textDigest,
        normalizedContent.searchText,
        input.sourceItemId !== undefined ? input.sourceItemId : existing.sourceItemId || null,
        input.sourceToolCallId !== undefined ? input.sourceToolCallId : existing.sourceToolCallId || null,
        input.sourceTurnId !== undefined ? input.sourceTurnId : existing.sourceTurnId || null,
        input.supersedesMemoryId !== undefined ? input.supersedesMemoryId : existing.supersedesMemoryId || null,
        JSON.stringify(input.metadata || existing.metadata || {}),
      ],
    );

    await client.query('DELETE FROM memory_entry_parts WHERE memory_entry_id = $1', [memoryId]);
    await insertMemoryParts(client, memoryId, normalizedContent.parts);
    await replaceMemoryGrants(client, workspaceId, memoryId, nextGrants, input.grantedBy);
    await maybeMarkSuperseded(client, input.supersedesMemoryId);
    return queueAuthzRelationships(
      client,
      diffAuthzRelationships(
        buildMemoryAuthzRelations({
          workspaceId,
          memoryId,
          ownerScope: existing.ownerScope,
          ownerActorId: existing.ownerActorId,
          ownerConversationId: existing.ownerConversationId,
          ownerUserId: existing.ownerUserId,
          grants: existing.grants.map((grant) => ({
            permission: grant.permission,
            grantScope: grant.grantScope,
            actorId: grant.actorId,
            conversationId: grant.conversationId,
            userId: grant.userId,
            reason: grant.reason,
            metadata: grant.metadata,
          })),
        }),
        buildMemoryAuthzRelations({
          workspaceId,
          memoryId,
          ownerScope,
          ownerActorId: ownerActorId || undefined,
          ownerConversationId: ownerConversationId || undefined,
          ownerUserId: ownerUserId || undefined,
          grants: nextGrants,
        }),
      ),
      {
        source: 'memory.update',
        workspaceId,
        memoryId,
      },
    );
  });

  await flushQueuedAuthzEntries(authzEntryIds, 'memory.update');

  await reindexMemoryEntry(memoryId);
  return getMemory(workspaceId, memoryId);
}

export async function deleteMemory(workspaceId: UUID, memoryId: UUID) {
  const existing = await getMemory(workspaceId, memoryId);
  const result = await transaction(async (client) => {
    const deleted = await client.query(
      `DELETE FROM memory_entries WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, memoryId],
    );
    if ((deleted.rowCount ?? 0) === 0) {
      return null;
    }

    const authzEntryIds = await queueAuthzRelationships(
      client,
      diffAuthzRelationships(
        buildMemoryAuthzRelations({
          workspaceId,
          memoryId,
          ownerScope: existing.ownerScope,
          ownerActorId: existing.ownerActorId,
          ownerConversationId: existing.ownerConversationId,
          ownerUserId: existing.ownerUserId,
          grants: existing.grants.map((grant) => ({
            permission: grant.permission,
            grantScope: grant.grantScope,
            actorId: grant.actorId,
            conversationId: grant.conversationId,
            userId: grant.userId,
            reason: grant.reason,
            metadata: grant.metadata,
          })),
        }),
        [],
      ),
      {
        source: 'memory.delete',
        workspaceId,
        memoryId,
      },
    );

    return { authzEntryIds };
  });

  if (!result) {
    throw new MemoryError('Memory not found', 404);
  }

  await flushQueuedAuthzEntries(result.authzEntryIds, 'memory.delete');
}

export async function listMemories(workspaceId: UUID, input: ListMemoriesInput) {
  const { whereClause, params, nextIndex } = buildListWhereClause(workspaceId, input);
  const limit = Math.max(1, Math.min(200, input.limit ?? 200));
  const result = await query<MemoryRow>(
    `SELECT me.*,
            a.name AS actor_name,
            c.title AS conversation_title,
            u.name AS user_name
     FROM memory_entries me
     LEFT JOIN actors a ON a.id = me.owner_actor_id
     LEFT JOIN conversations c ON c.id = me.owner_conversation_id
     LEFT JOIN users u ON u.id = me.owner_user_id
     WHERE ${whereClause}
     ORDER BY me.updated_at DESC, me.created_at DESC
     LIMIT $${nextIndex}`,
    [...params, limit],
  );
  return loadMemoryEntriesFromRows(result.rows);
}

export async function searchMemories(workspaceId: UUID, input: SearchMemoriesInput): Promise<MemoryRecallResult[]> {
  const candidateLimit = Math.max(input.limit ?? config.memory.recallLimit, config.memory.searchCandidateLimit);
  const queryText = input.queryText.trim();
  const lexicalRows = queryText ? await searchLexicalCandidates(workspaceId, input, candidateLimit) : [];
  const embedding = queryText ? await generateSearchEmbedding(queryText) : null;
  const vectorRows = embedding
    ? await searchVectorCandidates(workspaceId, input, embedding, candidateLimit)
    : [];
  const fallbackRows = lexicalRows.length === 0 && vectorRows.length === 0
    ? await searchFallbackCandidates(workspaceId, input, candidateLimit)
    : [];

  return buildSearchHits(
    [...lexicalRows, ...vectorRows, ...fallbackRows],
    queryText,
    input,
    Math.max(1, Math.min(50, input.limit ?? config.memory.recallLimit)),
  );
}

export async function runMemorySearch(workspaceId: UUID, input: SearchMemoriesInput) {
  const results = await searchMemories(workspaceId, input);
  const run = await recordMemoryRecallRun({
    workspaceId,
    actorId: input.actorId,
    conversationId: input.conversationId,
    userId: input.userId,
    recallType: 'manual_search',
    queryText: input.queryText,
    queryBlocks: input.queryText ? textBlocks(input.queryText) : [],
    metadata: input.metadata,
    results,
  });
  return { run, memories: results };
}

export async function recallMemories(workspaceId: UUID, input: RecallMemoriesInput) {
  const results = await searchMemories(workspaceId, input);
  const enrichedResults = results.map((result, index) => ({
    ...result,
    rank: index + 1,
    recallReason: buildDefaultRecallReason(result, input),
  }));

  const run = await recordMemoryRecallRun({
    workspaceId,
    actorId: input.actorId,
    conversationId: input.conversationId,
    userId: input.userId,
    recallType: input.recallType,
    queryText: input.queryText,
    queryBlocks: input.queryBlocks,
    metadata: input.metadata,
    results: enrichedResults,
  });

  return { run, memories: enrichedResults };
}

export function buildMemoryRecallQuery(params: {
  actorName?: string;
  conversationTitle?: string;
  contextItems: CanonicalContextItem[];
}) {
  const snippets: string[] = [];
  if (params.conversationTitle) {
    snippets.push(`conversation:${params.conversationTitle}`);
  }
  if (params.actorName) {
    snippets.push(`actor:${params.actorName}`);
  }

  for (const item of params.contextItems.slice(-12)) {
    const parts = 'parts' in item ? item.parts : undefined;
    const text = extractText(parts || []).trim();
    if (text) snippets.push(text);
  }

  return snippets.join('\n').trim();
}

export class MemoryError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'MemoryError';
  }
}
