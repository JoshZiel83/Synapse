import { query } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import type { MemoryCategory, MemoryScope, UUID } from '@synapse/shared';
import { generateId, nowISO, paginate } from '@synapse/shared';

interface MemoryRow {
  id: string;
  workspace_id: string;
  actor_id: string | null;
  category: MemoryCategory;
  scope: MemoryScope;
  content: string;
  summary: string | null;
  tags: string[];
  source_work_item_id: string | null;
  importance: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MemoryRowWithScore extends MemoryRow {
  relevance_score?: number;
}

function mapMemoryRow(row: MemoryRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    actorId: row.actor_id ?? undefined,
    category: row.category,
    scope: row.scope,
    content: row.content,
    summary: row.summary ?? undefined,
    tags: row.tags ?? [],
    sourceWorkItemId: row.source_work_item_id ?? undefined,
    importance: row.importance,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateMemoryInput {
  actorId?: string;
  category: MemoryCategory;
  scope: MemoryScope;
  content: string;
  summary?: string;
  tags?: string[];
  importance?: number;
  sourceWorkItemId?: string;
}

export interface UpdateMemoryInput {
  category?: MemoryCategory;
  scope?: MemoryScope;
  content?: string;
  summary?: string;
  tags?: string[];
  importance?: number;
}

export interface ListMemoriesInput {
  actorId?: string;
  category?: MemoryCategory;
  scope?: MemoryScope;
  tags?: string[];
}

export interface SearchMemoriesInput {
  query: string;
  actorId?: string;
  category?: MemoryCategory;
  scope?: MemoryScope;
  tags?: string[];
  limit?: number;
}

export interface RecallMemoriesInput {
  actorId: string;
  context: string;
  categories?: MemoryCategory[];
  limit?: number;
}

export async function createMemory(workspaceId: UUID, input: CreateMemoryInput) {
  const id = generateId();
  const now = nowISO();

  const result = await query<MemoryRow>(
    `INSERT INTO memories (id, workspace_id, actor_id, category, scope, content, summary, tags, importance, source_work_item_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      id,
      workspaceId,
      input.actorId ?? null,
      input.category,
      input.scope,
      input.content,
      input.summary ?? null,
      input.tags ?? [],
      input.importance ?? 0.5,
      input.sourceWorkItemId ?? null,
      now,
      now,
    ],
  );

  const memory = mapMemoryRow(result.rows[0]);

  await emitEvent({
    type: 'memory.created',
    workspaceId,
    payload: { memory },
    timestamp: now,
  });

  return memory;
}

export async function getMemory(workspaceId: UUID, memoryId: UUID) {
  const result = await query<MemoryRow>(
    'SELECT * FROM memories WHERE id = $1 AND workspace_id = $2',
    [memoryId, workspaceId],
  );

  if (result.rowCount === 0) {
    throw new MemoryError('Memory not found', 404);
  }

  return mapMemoryRow(result.rows[0]);
}

export async function updateMemory(workspaceId: UUID, memoryId: UUID, input: UpdateMemoryInput) {
  const now = nowISO();
  const setClauses: string[] = ['updated_at = $3'];
  const params: any[] = [memoryId, workspaceId, now];
  let paramIndex = 4;

  if (input.category !== undefined) {
    setClauses.push(`category = $${paramIndex++}`);
    params.push(input.category);
  }
  if (input.scope !== undefined) {
    setClauses.push(`scope = $${paramIndex++}`);
    params.push(input.scope);
  }
  if (input.content !== undefined) {
    setClauses.push(`content = $${paramIndex++}`);
    params.push(input.content);
  }
  if (input.summary !== undefined) {
    setClauses.push(`summary = $${paramIndex++}`);
    params.push(input.summary);
  }
  if (input.tags !== undefined) {
    setClauses.push(`tags = $${paramIndex++}`);
    params.push(input.tags);
  }
  if (input.importance !== undefined) {
    setClauses.push(`importance = $${paramIndex++}`);
    params.push(input.importance);
  }

  const result = await query<MemoryRow>(
    `UPDATE memories SET ${setClauses.join(', ')} WHERE id = $1 AND workspace_id = $2 RETURNING *`,
    params,
  );

  if (result.rowCount === 0) {
    throw new MemoryError('Memory not found', 404);
  }

  return mapMemoryRow(result.rows[0]);
}

export async function deleteMemory(workspaceId: UUID, memoryId: UUID) {
  const result = await query(
    'DELETE FROM memories WHERE id = $1 AND workspace_id = $2',
    [memoryId, workspaceId],
  );

  if (result.rowCount === 0) {
    throw new MemoryError('Memory not found', 404);
  }
}

export async function listMemories(workspaceId: UUID, input: ListMemoriesInput) {
  const conditions: string[] = ['workspace_id = $1'];
  const params: any[] = [workspaceId];
  let paramIndex = 2;

  if (input.actorId) {
    conditions.push(`actor_id = $${paramIndex++}`);
    params.push(input.actorId);
  }
  if (input.category) {
    conditions.push(`category = $${paramIndex++}`);
    params.push(input.category);
  }
  if (input.scope) {
    conditions.push(`scope = $${paramIndex++}`);
    params.push(input.scope);
  }
  if (input.tags && input.tags.length > 0) {
    conditions.push(`tags && $${paramIndex++}`);
    params.push(input.tags);
  }

  const whereClause = conditions.join(' AND ');

  const result = await query<MemoryRow>(
    `SELECT * FROM memories WHERE ${whereClause} ORDER BY created_at DESC`,
    params,
  );

  return result.rows.map(mapMemoryRow);
}

export async function searchMemories(workspaceId: UUID, input: SearchMemoriesInput) {
  const conditions: string[] = ['workspace_id = $1', "content ILIKE '%' || $2 || '%'"];
  const params: any[] = [workspaceId, input.query];
  let paramIndex = 3;

  if (input.actorId) {
    conditions.push(`actor_id = $${paramIndex++}`);
    params.push(input.actorId);
  }
  if (input.category) {
    conditions.push(`category = $${paramIndex++}`);
    params.push(input.category);
  }
  if (input.scope) {
    conditions.push(`scope = $${paramIndex++}`);
    params.push(input.scope);
  }
  if (input.tags && input.tags.length > 0) {
    conditions.push(`tags && $${paramIndex++}`);
    params.push(input.tags);
  }

  const limit = input.limit ?? 20;
  const whereClause = conditions.join(' AND ');

  const result = await query<MemoryRow>(
    `SELECT * FROM memories WHERE ${whereClause} ORDER BY importance DESC, created_at DESC LIMIT $${paramIndex}`,
    [...params, limit],
  );

  return result.rows.map(mapMemoryRow);
}

export async function recallMemories(workspaceId: UUID, input: RecallMemoriesInput) {
  const limit = input.limit ?? 10;

  const result = await query<MemoryRowWithScore>(
    `SELECT *,
       CASE WHEN content ILIKE '%' || $1 || '%' THEN 0.5 ELSE 0 END + importance as relevance_score
     FROM memories
     WHERE (actor_id = $2 OR scope IN ('team', 'workspace'))
       AND workspace_id = $3
       AND ($4::text[] IS NULL OR category = ANY($4))
     ORDER BY relevance_score DESC, created_at DESC
     LIMIT $5`,
    [
      input.context,
      input.actorId,
      workspaceId,
      input.categories && input.categories.length > 0 ? input.categories : null,
      limit,
    ],
  );

  return result.rows.map((row) => ({
    ...mapMemoryRow(row),
    relevanceScore: row.relevance_score ?? 0,
  }));
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
