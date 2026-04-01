import type {
  CanonicalContentBlock,
  CanonicalContentBlockInput,
  CanonicalContextItem,
  Memory,
  MemoryCategory,
  MemoryRecallResult,
  MemoryRecallRun,
  MemoryRecallType,
  MemoryScope,
  MemoryStability,
  MemoryStatus,
  UUID,
} from '@synapse/shared';
import { sql, type RawBuilder } from 'kysely';
import { extractText, normalizeCanonicalContentBlocks, textBlocks } from '@synapse/shared';
import { transaction } from '../../infrastructure/database/index.js';
import {
  db,
  executeCompiledQuery,
  executeSqlOn,
  type TableInsert,
} from '../../infrastructure/database/kysely.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { config } from '../../config/index.js';
import {
  buildActorConversationContextId,
  diffAuthzRelationships,
  flushAuthzOutboxEntries,
  queueAuthzRelationships,
  touchActorConversationContext,
  touchRelation,
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
  owner_workspace_member_id: string | null;
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
  created_at: string | Date;
  updated_at: string | Date;
  actor_name?: string | null;
  conversation_title?: string | null;
  workspace_member_name?: string | null;
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
  workspaceMemberId?: string;
};

async function flushQueuedAuthzEntries(entryIds: string[], source: string) {
  if (entryIds.length === 0) return;

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

function toIsoString(value: string | Date | null | undefined) {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function formatEmbeddingVector(values: number[]) {
  return `[${values.map((value) => Number.isFinite(value) ? value.toFixed(8) : '0').join(',')}]`;
}

const MEMORY_RECALL_MAX_CONTEXT_SNIPPETS = 8;
const MEMORY_RECALL_SNIPPET_MAX_CHARS = 240;
const MEMORY_RECALL_QUERY_MAX_CHARS = 1_200;
const MEMORY_LEXICAL_TOKEN_LIMIT = 24;
const MEMORY_LEXICAL_TOKEN_MAX_CHARS = 64;
const MEMORY_LEXICAL_QUERY_MAX_CHARS = 512;

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return value.slice(0, Math.max(0, maxChars - 3)).trimEnd() + '...';
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

function buildLexicalSearchQuery(queryText: string) {
  const normalized = normalizeWhitespace(queryText);
  if (!normalized) return '';

  const tokens = tokenizeQuery(normalized)
    .map((token) => token.slice(0, MEMORY_LEXICAL_TOKEN_MAX_CHARS))
    .filter(Boolean)
    .slice(0, MEMORY_LEXICAL_TOKEN_LIMIT);

  if (tokens.length > 0) {
    return truncateText(tokens.join(' '), MEMORY_LEXICAL_QUERY_MAX_CHARS);
  }

  return truncateText(normalized, MEMORY_LEXICAL_QUERY_MAX_CHARS);
}

function isTsqueryStackOverflow(error: unknown) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string' &&
    /tsquery stack too small/i.test((error as { message: string }).message),
  );
}

function computeMatchedTerms(queryText: string, candidateText: string) {
  const queryTokens = tokenizeQuery(queryText);
  const haystack = candidateText.toLowerCase();
  return queryTokens.filter((token) => haystack.includes(token));
}

function scopeRank(scope: MemoryScope) {
  switch (scope) {
    case 'actor_conversation':
      return 5;
    case 'conversation':
      return 4;
    case 'actor_global':
      return 3;
    case 'workspace_member':
      return 2;
    case 'workspace':
      return 1;
    default:
      return 0;
  }
}

function ownerMatchesTarget(memory: Pick<MemoryRow, 'owner_scope' | 'owner_actor_id' | 'owner_conversation_id' | 'owner_workspace_member_id'>, target: MemoryAccessTarget) {
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
    case 'workspace_member':
      return Boolean(
        target.workspaceMemberId &&
        memory.owner_workspace_member_id === target.workspaceMemberId,
      );
    default:
      return false;
  }
}

function effectiveScopeRank(memory: Memory, target: MemoryAccessTarget) {
  return ownerMatchesTarget(
    {
      owner_scope: memory.ownerScope,
      owner_actor_id: memory.ownerActorId ?? null,
      owner_conversation_id: memory.ownerConversationId ?? null,
      owner_workspace_member_id: memory.ownerWorkspaceMemberId ?? null,
    },
    target,
  )
    ? scopeRank(memory.ownerScope)
    : 0;
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
    deriveRecencyBoost(toIsoString(row.updated_at)!)
  );
}

function mapMemoryRow(row: MemoryRow, contentBlocks: CanonicalContentBlock[]): Memory {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerScope: row.owner_scope,
    ownerActorId: row.owner_actor_id ?? undefined,
    ownerConversationId: row.owner_conversation_id ?? undefined,
    ownerWorkspaceMemberId: row.owner_workspace_member_id ?? undefined,
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
    metadata: parseJsonObject(row.metadata),
    createdAt: toIsoString(row.created_at)!,
    updatedAt: toIsoString(row.updated_at)!,
    actorName: row.actor_name ?? undefined,
    conversationTitle: row.conversation_title ?? undefined,
    workspaceMemberName: row.workspace_member_name ?? undefined,
  };
}

async function loadMemoryEntriesFromRows(rows: MemoryRow[]) {
  if (rows.length === 0) return [];

  const memoryIds = rows.map((row) => row.id);

  const partsResult = await db
    .selectFrom('memory_entry_parts as mep')
    .leftJoin('files as f', 'f.id', 'mep.file_id')
    .select([
      'mep.memory_entry_id',
      'mep.part_type',
      'mep.text_value',
      'mep.file_id',
      'mep.json_value',
      'mep.mime_type',
      'mep.name',
      'mep.metadata',
      'f.original_name',
      'f.stored_name',
      'f.mime_type as file_mime_type',
      'f.size_bytes',
    ])
    .where('mep.memory_entry_id', 'in', memoryIds)
    .orderBy('mep.memory_entry_id', 'asc')
    .orderBy('mep.ordinal', 'asc')
    .execute();

  const partsByMemoryId = new Map<string, MemoryPartRow[]>();
  for (const row of partsResult as MemoryPartRow[]) {
    if (!partsByMemoryId.has(row.memory_entry_id)) {
      partsByMemoryId.set(row.memory_entry_id, []);
    }
    partsByMemoryId.get(row.memory_entry_id)!.push(row);
  }

  return rows.map((row) => mapMemoryRow(row, itemPartsToCanonicalContentBlocks(partsByMemoryId.get(row.id) || [])));
}

async function getMemoryRow(workspaceId: string, memoryId: string) {
  const row = await db
    .selectFrom('memory_entries as me')
    .leftJoin('actors as a', 'a.id', 'me.owner_actor_id')
    .leftJoin('conversations as c', 'c.id', 'me.owner_conversation_id')
    .leftJoin('workspace_members as wm', 'wm.id', 'me.owner_workspace_member_id')
    .leftJoin('users as u', 'u.id', 'wm.user_id')
    .selectAll('me')
    .select([
      'a.name as actor_name',
      'c.title as conversation_title',
      'u.name as workspace_member_name',
    ])
    .where('me.workspace_id', '=', workspaceId)
    .where('me.id', '=', memoryId)
    .limit(1)
    .executeTakeFirst();
  return (row as MemoryRow | undefined) ?? null;
}

function validateMemoryOwnerBinding(input: {
  scope: MemoryScope;
  actorId?: string;
  conversationId?: string;
  workspaceMemberId?: string;
}, label: string) {
  switch (input.scope) {
    case 'workspace':
      if (input.actorId || input.conversationId || input.workspaceMemberId) {
        throw new MemoryError(`${label} workspace scope cannot include actorId, conversationId, or workspaceMemberId`, 400);
      }
      break;
    case 'conversation':
      if (!input.conversationId || input.actorId || input.workspaceMemberId) {
        throw new MemoryError(`${label} conversation scope requires conversationId and no actorId or workspaceMemberId`, 400);
      }
      break;
    case 'actor_global':
      if (!input.actorId || input.conversationId || input.workspaceMemberId) {
        throw new MemoryError(`${label} actor_global scope requires actorId and no conversationId or workspaceMemberId`, 400);
      }
      break;
    case 'actor_conversation':
      if (!input.actorId || !input.conversationId || input.workspaceMemberId) {
        throw new MemoryError(`${label} actor_conversation scope requires actorId and conversationId and no workspaceMemberId`, 400);
      }
      break;
    case 'workspace_member':
      if (!input.workspaceMemberId || input.actorId || input.conversationId) {
        throw new MemoryError(`${label} workspace_member scope requires workspaceMemberId and no actorId or conversationId`, 400);
      }
      break;
  }
}

function buildMemoryOwnerRelations(params: {
  workspaceId: string;
  memoryId: string;
  scope: MemoryScope;
  actorId?: string;
  conversationId?: string;
  workspaceMemberId?: string;
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
    case 'workspace_member':
      return params.workspaceMemberId
        ? [
            touchRelation(
              'memory',
              params.memoryId,
              'owner_workspace_member',
              'workspace_member',
              params.workspaceMemberId,
            ),
          ]
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
  ownerWorkspaceMemberId?: string;
}): AuthzRelationMutation[] {
  return [
    touchRelation('memory', params.memoryId, 'workspace', 'workspace', params.workspaceId),
    ...buildMemoryOwnerRelations({
      workspaceId: params.workspaceId,
      memoryId: params.memoryId,
      scope: params.ownerScope,
      actorId: params.ownerActorId,
      conversationId: params.ownerConversationId,
      workspaceMemberId: params.ownerWorkspaceMemberId,
    }),
  ];
}

async function assertWorkspaceMemberExists(
  workspaceId: string,
  workspaceMemberId: string,
) {
  const row = await db
    .selectFrom('workspace_members')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', workspaceMemberId)
    .limit(1)
    .executeTakeFirst();
  if (!row) {
    throw new MemoryError('Workspace member not found', 404);
  }
}

async function assertActorInWorkspace(workspaceId: string, actorId: string) {
  const row = await db
    .selectFrom('actors')
    .select('id')
    .where('id', '=', actorId)
    .where('workspace_id', '=', workspaceId)
    .where('is_active', '=', true)
    .limit(1)
    .executeTakeFirst();
  if (!row) {
    throw new MemoryError('Actor not found in this workspace', 404);
  }
}

async function assertConversationInWorkspace(workspaceId: string, conversationId: string) {
  const row = await db
    .selectFrom('conversation_members as cm')
    .leftJoin('workspace_members as wm', 'wm.id', 'cm.workspace_member_id')
    .leftJoin('actors as a', 'a.id', 'cm.actor_id')
    .select('cm.id')
    .where('cm.conversation_id', '=', conversationId)
    .where((eb) =>
      eb.or([
        eb('wm.workspace_id', '=', workspaceId),
        eb('a.workspace_id', '=', workspaceId),
      ]),
    )
    .limit(1)
    .executeTakeFirst();
  if (!row) {
    throw new MemoryError('Conversation not found in this workspace', 404);
  }
}

async function assertActorInConversation(conversationId: string, actorId: string) {
  const row = await db
    .selectFrom('conversation_members')
    .select('id')
    .where('conversation_id', '=', conversationId)
    .where('actor_id', '=', actorId)
    .where('state', '=', 'active')
    .limit(1)
    .executeTakeFirst();
  if (!row) {
    throw new MemoryError('Actor is not an active member of this conversation', 400);
  }
}

async function validateMemoryOwnerTarget(workspaceId: string, input: {
  scope: MemoryScope;
  actorId?: string;
  conversationId?: string;
  workspaceMemberId?: string;
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
    case 'workspace_member':
      if (input.workspaceMemberId) {
        await assertWorkspaceMemberExists(workspaceId, input.workspaceMemberId);
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

async function insertMemoryParts(
  client: { query: (...args: any[]) => Promise<any> },
  memoryId: string,
  parts: DraftConversationPart[],
) {
  for (let ordinal = 0; ordinal < parts.length; ordinal += 1) {
    const part = parts[ordinal];
    await executeCompiledQuery(
      client,
      db
        .insertInto('memory_entry_parts')
        .values({
          id: uuidv4(),
          memory_entry_id: memoryId,
          ordinal,
          part_type: part.type,
          text_value: part.type === 'text' ? part.text || '' : null,
          file_id: part.type === 'file_ref' ? part.fileId || null : null,
          json_value:
            part.type === 'json'
              ? sql`${JSON.stringify(part.json ?? {})}::jsonb`
              : null,
          mime_type: part.mimeType || null,
          name: part.name || null,
          metadata: (part.metadata || {}) as TableInsert<'memory_entry_parts'>['metadata'],
        }),
    );
  }
}

async function maybeMarkSuperseded(
  client: { query: (...args: any[]) => Promise<any> },
  memoryId?: string,
) {
  if (!memoryId) return;
  await executeCompiledQuery(
    client,
    db
      .updateTable('memory_entries')
      .set({
        status: 'superseded',
      })
      .where('id', '=', memoryId),
  );
}

export interface CreateMemoryInput {
  ownerScope: MemoryScope;
  ownerActorId?: string;
  ownerConversationId?: string;
  ownerWorkspaceMemberId?: string;
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
}

export interface UpdateMemoryInput {
  ownerScope?: MemoryScope;
  ownerActorId?: string;
  ownerConversationId?: string;
  ownerWorkspaceMemberId?: string;
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

function buildVisibilityClause(target: MemoryAccessTarget, alias = 'me') {
  const table = sql.raw(alias);
  const ownerClauses: RawBuilder<unknown>[] = [
    sql`${table}.owner_scope = 'workspace'`,
  ];

  if (target.conversationId) {
    ownerClauses.push(
      sql`(${table}.owner_scope = 'conversation' AND ${table}.owner_conversation_id = ${target.conversationId})`,
    );
  }

  if (target.actorId) {
    ownerClauses.push(
      sql`(${table}.owner_scope = 'actor_global' AND ${table}.owner_actor_id = ${target.actorId})`,
    );
  }

  if (target.actorId && target.conversationId) {
    ownerClauses.push(
      sql`(${table}.owner_scope = 'actor_conversation' AND ${table}.owner_actor_id = ${target.actorId} AND ${table}.owner_conversation_id = ${target.conversationId})`,
    );
  }

  if (target.workspaceMemberId) {
    ownerClauses.push(
      sql`(${table}.owner_scope = 'workspace_member' AND ${table}.owner_workspace_member_id = ${target.workspaceMemberId})`,
    );
  }

  return sql`(${sql.join(ownerClauses, sql` OR `)})`;
}

function buildListWhereClause(workspaceId: string, input: ListMemoriesInput) {
  const conditions: RawBuilder<unknown>[] = [sql`me.workspace_id = ${workspaceId}`];

  if (input.actorId || input.conversationId || input.workspaceMemberId) {
    conditions.push(buildVisibilityClause(input));
  }

  if (input.ownerScope) {
    conditions.push(sql`me.owner_scope = ${input.ownerScope}`);
  }
  if (input.category) {
    conditions.push(sql`me.category = ${input.category}`);
  }
  if (input.status) {
    conditions.push(sql`me.status = ${input.status}`);
  }
  if (input.stability) {
    conditions.push(sql`me.stability = ${input.stability}`);
  }
  if (input.tags && input.tags.length > 0) {
    conditions.push(sql`me.tags && ${input.tags}`);
  }

  return sql`${sql.join(conditions, sql` AND `)}`;
}

function buildSearchFilters(workspaceId: string, input: SearchMemoriesInput, alias = 'me') {
  const table = sql.raw(alias);
  const conditions: RawBuilder<unknown>[] = [sql`${table}.workspace_id = ${workspaceId}`];

  if (input.actorId || input.conversationId || input.workspaceMemberId) {
    conditions.push(buildVisibilityClause(input, alias));
  }

  const scopes = input.scopes && input.scopes.length > 0 ? input.scopes : undefined;
  if (scopes) {
    conditions.push(sql`${table}.owner_scope::text = ANY(${scopes}::text[])`);
  }

  if (input.categories && input.categories.length > 0) {
    conditions.push(sql`${table}.category::text = ANY(${input.categories}::text[])`);
  }

  const statuses = input.statuses && input.statuses.length > 0 ? input.statuses : ['established'];
  conditions.push(sql`${table}.status::text = ANY(${statuses}::text[])`);

  const stabilities = input.stabilities && input.stabilities.length > 0 ? input.stabilities : ['durable'];
  conditions.push(sql`${table}.stability::text = ANY(${stabilities}::text[])`);

  return sql`${sql.join(conditions, sql` AND `)}`;
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
  const whereClause = buildSearchFilters(workspaceId, input);
  const queryText = buildLexicalSearchQuery(input.queryText);
  if (!queryText) return [];
  const result = await db.executeQuery(
    sql<SearchCandidateRow>`SELECT me.*,
        a.name AS actor_name,
        c.title AS conversation_title,
        u.name AS workspace_member_name,
        mic.id AS matched_chunk_id,
        mic.search_text AS chunk_search_text,
        ts_rank_cd(to_tsvector('simple', mic.search_text), websearch_to_tsquery('simple', ${queryText})) AS text_score,
        similarity(mic.search_text, ${queryText}) AS similarity_score,
        NULL::real AS vector_score
      FROM memory_index_chunks mic
      JOIN memory_entries me ON me.id = mic.memory_entry_id
      LEFT JOIN actors a ON a.id = me.owner_actor_id
      LEFT JOIN conversations c ON c.id = me.owner_conversation_id
      LEFT JOIN workspace_members wm ON wm.id = me.owner_workspace_member_id
      LEFT JOIN users u ON u.id = wm.user_id
      WHERE ${whereClause}
        AND (
          to_tsvector('simple', mic.search_text) @@ websearch_to_tsquery('simple', ${queryText})
          OR similarity(mic.search_text, ${queryText}) > 0.08
        )
      ORDER BY text_score DESC, similarity_score DESC, me.importance DESC, me.updated_at DESC
      LIMIT ${candidateLimit}`.compile(db),
  );

  return result.rows;
}

async function searchFallbackCandidates(workspaceId: string, input: SearchMemoriesInput, candidateLimit: number) {
  const whereClause = buildSearchFilters(workspaceId, input);
  const result = await db.executeQuery(
    sql<SearchCandidateRow>`SELECT me.*,
        a.name AS actor_name,
        c.title AS conversation_title,
        u.name AS workspace_member_name,
        mic.id AS matched_chunk_id,
        COALESCE(mic.search_text, me.search_text) AS chunk_search_text,
        NULL::real AS text_score,
        NULL::real AS similarity_score,
        NULL::real AS vector_score
      FROM memory_entries me
      LEFT JOIN actors a ON a.id = me.owner_actor_id
      LEFT JOIN conversations c ON c.id = me.owner_conversation_id
      LEFT JOIN workspace_members wm ON wm.id = me.owner_workspace_member_id
      LEFT JOIN users u ON u.id = wm.user_id
      LEFT JOIN LATERAL (
        SELECT id, search_text
        FROM memory_index_chunks
        WHERE memory_entry_id = me.id
        ORDER BY chunk_index ASC
        LIMIT 1
      ) mic ON TRUE
      WHERE ${whereClause}
      ORDER BY me.importance DESC, me.confidence DESC, me.updated_at DESC
      LIMIT ${candidateLimit}`.compile(db),
  );

  return result.rows;
}

async function searchVectorCandidates(workspaceId: string, input: SearchMemoriesInput, embedding: number[], candidateLimit: number) {
  const whereClause = buildSearchFilters(workspaceId, input);
  const formattedEmbedding = formatEmbeddingVector(embedding);
  const result = await db.executeQuery(
    sql<SearchCandidateRow>`SELECT me.*,
        a.name AS actor_name,
        c.title AS conversation_title,
        u.name AS workspace_member_name,
        mic.id AS matched_chunk_id,
        mic.search_text AS chunk_search_text,
        NULL::real AS text_score,
        NULL::real AS similarity_score,
        (1 - (mic.embedding <=> ${formattedEmbedding}::vector))::real AS vector_score
      FROM memory_index_chunks mic
      JOIN memory_entries me ON me.id = mic.memory_entry_id
      LEFT JOIN actors a ON a.id = me.owner_actor_id
      LEFT JOIN conversations c ON c.id = me.owner_conversation_id
      LEFT JOIN workspace_members wm ON wm.id = me.owner_workspace_member_id
      LEFT JOIN users u ON u.id = wm.user_id
      WHERE ${whereClause}
        AND mic.embedding IS NOT NULL
      ORDER BY mic.embedding <=> ${formattedEmbedding}::vector ASC
      LIMIT ${candidateLimit}`.compile(db),
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

  return orderedRows.map(({ row, memory, finalScore }, index) => ({
    ...memory,
    matchedChunkId: row.matched_chunk_id,
    rank: index + 1,
    finalScore,
    vectorScore: row.vector_score ?? undefined,
    textScore: row.text_score ?? undefined,
    similarityScore: row.similarity_score ?? undefined,
    matchedTerms: computeMatchedTerms(queryText, row.chunk_search_text),
  } satisfies MemoryRecallResult));
}

async function recordMemoryRecallRun(params: {
  workspaceId: string;
  actorId?: string;
  conversationId?: string;
  workspaceMemberId?: string;
  recallType: MemoryRecallType;
  queryText: string;
  queryBlocks?: CanonicalContentBlockInput[];
  metadata?: Record<string, unknown>;
  results: MemoryRecallResult[];
}): Promise<MemoryRecallRun> {
  const normalizedQueryBlocks = normalizeCanonicalContentBlocks(params.queryBlocks || []);
  const runId = uuidv4();
  await transaction(async (client) => {
    await executeSqlOn(
      client,
      `INSERT INTO memory_recall_runs (
         id,
         workspace_id,
         actor_id,
         conversation_id,
         workspace_member_id,
         recall_type,
         query_text,
         query_blocks,
         metadata,
         created_at
       )
       VALUES (
         $1,
         $2,
         $3,
         $4,
         $5,
         $6,
         $7,
         $8::jsonb,
         $9::jsonb,
         NOW()
       )`,
      [
        runId,
        params.workspaceId,
        params.actorId || null,
        params.conversationId || null,
        params.workspaceMemberId || null,
        params.recallType,
        params.queryText,
        JSON.stringify(normalizedQueryBlocks),
        JSON.stringify(params.metadata || {}),
      ],
    );

    for (const result of params.results) {
      await executeCompiledQuery(
        client,
        db
          .insertInto('memory_recall_run_results')
          .values({
            id: uuidv4(),
            run_id: runId,
            memory_entry_id: result.id,
            matched_chunk_id: result.matchedChunkId || null,
            rank: result.rank,
            final_score: result.finalScore,
            vector_score: result.vectorScore ?? null,
            text_score: result.textScore ?? null,
            similarity_score: result.similarityScore ?? null,
            matched_terms: (result.matchedTerms ?? []) as TableInsert<'memory_recall_run_results'>['matched_terms'],
            recall_reason: result.recallReason || null,
            metadata: {
              ownerScope: result.ownerScope,
              category: result.category,
            } as TableInsert<'memory_recall_run_results'>['metadata'],
            created_at: sql`NOW()`,
          }),
      );
    }
  });

  return {
    id: runId,
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    conversationId: params.conversationId,
    workspaceMemberId: params.workspaceMemberId,
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
      return 'Workspace-member memory matched the current member context';
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
      workspaceMemberId: input.ownerWorkspaceMemberId,
    },
    'Memory owner',
  );
  await validateMemoryOwnerTarget(workspaceId, {
    scope: input.ownerScope,
    actorId: input.ownerActorId,
    conversationId: input.ownerConversationId,
    workspaceMemberId: input.ownerWorkspaceMemberId,
  });

  const normalizedContent = await normalizeMemoryContent(input);
  const memoryId = uuidv4();

  const authzEntryIds = await transaction(async (client) => {
    await executeCompiledQuery(
      client,
      db
        .insertInto('memory_entries')
        .values({
          id: memoryId,
          workspace_id: workspaceId,
          owner_scope: input.ownerScope,
          owner_actor_id: input.ownerActorId || null,
          owner_conversation_id: input.ownerConversationId || null,
          owner_workspace_member_id: input.ownerWorkspaceMemberId || null,
          category: input.category,
          status: input.status || 'established',
          stability: input.stability || 'durable',
          importance: input.importance ?? 0.5,
          confidence: input.confidence ?? 0.8,
          tags: input.tags || [],
          text_digest: normalizedContent.textDigest,
          search_text: normalizedContent.searchText,
          source_item_id: input.sourceItemId || null,
          source_tool_call_id: input.sourceToolCallId || null,
          source_turn_id: input.sourceTurnId || null,
          supersedes_memory_id: input.supersedesMemoryId || null,
          metadata: (input.metadata || {}) as TableInsert<'memory_entries'>['metadata'],
          created_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        }),
    );
    await insertMemoryParts(client, memoryId, normalizedContent.parts);
    await maybeMarkSuperseded(client, input.supersedesMemoryId);
    return queueAuthzRelationships(
      client,
      buildMemoryAuthzRelations({
        workspaceId,
        memoryId,
        ownerScope: input.ownerScope,
        ownerActorId: input.ownerActorId,
        ownerConversationId: input.ownerConversationId,
        ownerWorkspaceMemberId: input.ownerWorkspaceMemberId,
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
      ownerWorkspaceMemberId: memory.ownerWorkspaceMemberId,
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
  const ownerWorkspaceMemberId =
    input.ownerWorkspaceMemberId !== undefined
      ? input.ownerWorkspaceMemberId
      : existing.ownerWorkspaceMemberId;

  validateMemoryOwnerBinding(
    {
      scope: ownerScope,
      actorId: ownerActorId,
      conversationId: ownerConversationId,
      workspaceMemberId: ownerWorkspaceMemberId,
    },
    'Memory owner',
  );
  await validateMemoryOwnerTarget(workspaceId, {
    scope: ownerScope,
    actorId: ownerActorId || undefined,
    conversationId: ownerConversationId || undefined,
    workspaceMemberId: ownerWorkspaceMemberId || undefined,
  });

  const normalizedContent = await normalizeMemoryContent({
    content: input.content,
    contentBlocks: input.contentBlocks || (input.content === undefined ? existing.contentBlocks : undefined),
    textDigest: input.textDigest || (input.content === undefined && !input.contentBlocks ? existing.textDigest : undefined),
    searchText: input.searchText,
    tags: input.tags || existing.tags,
    category: input.category || existing.category,
  });

  const authzEntryIds = await transaction(async (client) => {
    await executeCompiledQuery(
      client,
      db
        .updateTable('memory_entries')
        .set({
          owner_scope: ownerScope,
          owner_actor_id: ownerActorId || null,
          owner_conversation_id: ownerConversationId || null,
          owner_workspace_member_id: ownerWorkspaceMemberId || null,
          category: input.category || existing.category,
          status: input.status || existing.status,
          stability: input.stability || existing.stability,
          importance: input.importance ?? existing.importance,
          confidence: input.confidence ?? existing.confidence,
          tags: input.tags || existing.tags,
          text_digest: normalizedContent.textDigest,
          search_text: normalizedContent.searchText,
          source_item_id: input.sourceItemId !== undefined ? input.sourceItemId : existing.sourceItemId || null,
          source_tool_call_id: input.sourceToolCallId !== undefined ? input.sourceToolCallId : existing.sourceToolCallId || null,
          source_turn_id: input.sourceTurnId !== undefined ? input.sourceTurnId : existing.sourceTurnId || null,
          supersedes_memory_id: input.supersedesMemoryId !== undefined ? input.supersedesMemoryId : existing.supersedesMemoryId || null,
          metadata: (input.metadata || existing.metadata || {}) as TableInsert<'memory_entries'>['metadata'],
          updated_at: sql`NOW()`,
        })
        .where('id', '=', memoryId)
        .where('workspace_id', '=', workspaceId),
    );

    await executeCompiledQuery(
      client,
      db.deleteFrom('memory_entry_parts').where('memory_entry_id', '=', memoryId),
    );
    await insertMemoryParts(client, memoryId, normalizedContent.parts);
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
          ownerWorkspaceMemberId: existing.ownerWorkspaceMemberId,
        }),
        buildMemoryAuthzRelations({
          workspaceId,
          memoryId,
          ownerScope,
          ownerActorId: ownerActorId || undefined,
          ownerConversationId: ownerConversationId || undefined,
          ownerWorkspaceMemberId: ownerWorkspaceMemberId || undefined,
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
    const deleted = await executeCompiledQuery(
      client,
      db
        .deleteFrom('memory_entries')
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', memoryId),
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
          ownerWorkspaceMemberId: existing.ownerWorkspaceMemberId,
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
  const whereClause = buildListWhereClause(workspaceId, input);
  const limit = Math.max(1, Math.min(200, input.limit ?? 200));
  const result = await db.executeQuery(
    sql<MemoryRow>`SELECT me.*,
        a.name AS actor_name,
        c.title AS conversation_title,
        u.name AS workspace_member_name
      FROM memory_entries me
      LEFT JOIN actors a ON a.id = me.owner_actor_id
      LEFT JOIN conversations c ON c.id = me.owner_conversation_id
      LEFT JOIN workspace_members wm ON wm.id = me.owner_workspace_member_id
      LEFT JOIN users u ON u.id = wm.user_id
      WHERE ${whereClause}
      ORDER BY me.updated_at DESC, me.created_at DESC
      LIMIT ${limit}`.compile(db),
  );
  return loadMemoryEntriesFromRows(result.rows);
}

export async function searchMemories(workspaceId: UUID, input: SearchMemoriesInput): Promise<MemoryRecallResult[]> {
  const candidateLimit = Math.max(input.limit ?? config.memory.recallLimit, config.memory.searchCandidateLimit);
  const queryText = input.queryText.trim();
  let lexicalRows: SearchCandidateRow[] = [];
  if (queryText) {
    try {
      lexicalRows = await searchLexicalCandidates(workspaceId, input, candidateLimit);
    } catch (error) {
      if (!isTsqueryStackOverflow(error)) throw error;
      console.warn('[memory] lexical search degraded due to tsquery stack overflow', {
        workspaceId,
        actorId: input.actorId,
        conversationId: input.conversationId,
        queryLength: queryText.length,
      });
    }
  }
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
    workspaceMemberId: input.workspaceMemberId,
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
    workspaceMemberId: input.workspaceMemberId,
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
    snippets.push(truncateText(normalizeWhitespace(`conversation:${params.conversationTitle}`), MEMORY_RECALL_SNIPPET_MAX_CHARS));
  }
  if (params.actorName) {
    snippets.push(truncateText(normalizeWhitespace(`actor:${params.actorName}`), MEMORY_RECALL_SNIPPET_MAX_CHARS));
  }

  for (const item of params.contextItems.slice(-MEMORY_RECALL_MAX_CONTEXT_SNIPPETS)) {
    const parts = 'parts' in item ? item.parts : undefined;
    const text = normalizeWhitespace(extractText(parts || []).trim());
    if (text) {
      snippets.push(truncateText(text, MEMORY_RECALL_SNIPPET_MAX_CHARS));
    }
  }

  return truncateText(snippets.join('\n').trim(), MEMORY_RECALL_QUERY_MAX_CHARS);
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
