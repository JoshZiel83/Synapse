import { query } from '../../infrastructure/database/index.js';
import { generateId, nowISO } from '@synapse/shared';
import type { A2AApp, UUID } from '@synapse/shared';
import bcryptjs from 'bcryptjs';
import { randomBytes } from 'crypto';

const API_KEY_PREFIX = 'syn_a2a_';

function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(24).toString('hex');
}

function mapAppRow(row: any): A2AApp {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description || '',
    apiKeyPrefix: row.api_key_prefix,
    rateLimitRpm: row.rate_limit_rpm,
    isActive: row.is_active,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createA2AApp(params: {
  workspaceId: UUID;
  name: string;
  description?: string;
  actorIds: UUID[];
  rateLimitRpm?: number;
  createdBy: UUID;
}): Promise<{ app: A2AApp; apiKey: string }> {
  const id = generateId();
  const apiKey = generateApiKey();
  const apiKeyHash = await bcryptjs.hash(apiKey, 10);
  const apiKeyPrefix = apiKey.substring(0, 16);

  const result = await query(
    `INSERT INTO a2a_apps (id, workspace_id, name, description, api_key_hash, api_key_prefix, rate_limit_rpm, is_active, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, NOW(), NOW())
     RETURNING *`,
    [id, params.workspaceId, params.name, params.description || '', apiKeyHash, apiKeyPrefix, params.rateLimitRpm || 60, params.createdBy]
  );

  // Add actor associations
  for (const actorId of params.actorIds) {
    await query(
      `INSERT INTO a2a_app_actors (id, app_id, actor_id, created_at) VALUES ($1, $2, $3, NOW())`,
      [generateId(), id, actorId]
    );
  }

  return { app: mapAppRow(result.rows[0]), apiKey };
}

export async function listA2AApps(workspaceId: UUID): Promise<A2AApp[]> {
  const result = await query(
    `SELECT * FROM a2a_apps WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId]
  );
  return result.rows.map(mapAppRow);
}

export async function getA2AAppById(appId: UUID): Promise<A2AApp | null> {
  const result = await query(`SELECT * FROM a2a_apps WHERE id = $1`, [appId]);
  return result.rows.length ? mapAppRow(result.rows[0]) : null;
}

export async function authenticateApiKey(apiKey: string): Promise<{ app: A2AApp; workspaceId: UUID } | null> {
  if (!apiKey.startsWith(API_KEY_PREFIX)) return null;
  const prefix = apiKey.substring(0, 16);

  // Find apps matching prefix (narrows bcrypt comparisons)
  const result = await query(
    `SELECT * FROM a2a_apps WHERE api_key_prefix = $1 AND is_active = true`,
    [prefix]
  );

  for (const row of result.rows) {
    const match = await bcryptjs.compare(apiKey, row.api_key_hash);
    if (match) {
      return { app: mapAppRow(row), workspaceId: row.workspace_id };
    }
  }
  return null;
}

export async function updateA2AApp(appId: UUID, updates: Partial<{
  name: string;
  description: string;
  rateLimitRpm: number;
  isActive: boolean;
}>): Promise<A2AApp | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;

  const columnMap: Record<string, string> = {
    name: 'name',
    description: 'description',
    rateLimitRpm: 'rate_limit_rpm',
    isActive: 'is_active',
  };

  for (const [key, col] of Object.entries(columnMap)) {
    if (key in updates) {
      fields.push(`${col} = $${idx++}`);
      values.push((updates as any)[key]);
    }
  }

  if (fields.length === 0) return getA2AAppById(appId);

  values.push(appId);
  const result = await query(
    `UPDATE a2a_apps SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
    values
  );

  return result.rows.length ? mapAppRow(result.rows[0]) : null;
}

export async function deleteA2AApp(appId: UUID): Promise<boolean> {
  const result = await query(`DELETE FROM a2a_apps WHERE id = $1 RETURNING id`, [appId]);
  return (result.rowCount ?? 0) > 0;
}

export async function regenerateApiKey(appId: UUID): Promise<{ apiKey: string } | null> {
  const apiKey = generateApiKey();
  const apiKeyHash = await bcryptjs.hash(apiKey, 10);
  const apiKeyPrefix = apiKey.substring(0, 16);

  const result = await query(
    `UPDATE a2a_apps SET api_key_hash = $1, api_key_prefix = $2, updated_at = NOW() WHERE id = $3 RETURNING id`,
    [apiKeyHash, apiKeyPrefix, appId]
  );

  if ((result.rowCount ?? 0) === 0) return null;
  return { apiKey };
}

export async function setAppActors(appId: UUID, actorIds: UUID[]): Promise<void> {
  await query(`DELETE FROM a2a_app_actors WHERE app_id = $1`, [appId]);
  for (const actorId of actorIds) {
    await query(
      `INSERT INTO a2a_app_actors (id, app_id, actor_id, created_at) VALUES ($1, $2, $3, NOW())`,
      [generateId(), appId, actorId]
    );
  }
}

export async function getAppActors(appId: UUID): Promise<any[]> {
  const result = await query(
    `SELECT a.id, a.name, a.title, a.charter, a.role, a.skills, a.capabilities
     FROM actors a
     JOIN a2a_app_actors aaa ON aaa.actor_id = a.id
     WHERE aaa.app_id = $1 AND a.is_active = true
     ORDER BY a.name`,
    [appId]
  );
  return result.rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    title: r.title,
    charter: r.charter,
    role: r.role,
    skills: r.skills ? (typeof r.skills === 'string' ? JSON.parse(r.skills) : r.skills) : [],
    capabilities: r.capabilities,
  }));
}

// ============ A2A Tasks ============

export async function createA2ATask(appId: UUID, sessionId: UUID, contextId?: string): Promise<string> {
  const id = generateId();
  await query(
    `INSERT INTO a2a_tasks (id, app_id, context_id, session_id, created_at) VALUES ($1, $2, $3, $4, NOW())`,
    [id, appId, contextId || null, sessionId]
  );
  return id;
}

export async function getA2ATaskBySession(appId: UUID, sessionId: UUID): Promise<any | null> {
  const result = await query(
    `SELECT * FROM a2a_tasks WHERE app_id = $1 AND session_id = $2`,
    [appId, sessionId]
  );
  return result.rows[0] ?? null;
}

export async function getA2ATask(taskId: UUID): Promise<any | null> {
  const result = await query(`SELECT * FROM a2a_tasks WHERE id = $1`, [taskId]);
  return result.rows[0] ?? null;
}

export async function listA2ATasks(appId: UUID, limit = 50, offset = 0): Promise<any[]> {
  const result = await query(
    `SELECT t.*, s.status as session_status, s.created_at as session_created_at, s.completed_at as session_completed_at
     FROM a2a_tasks t
     JOIN sessions s ON s.id = t.session_id
     WHERE t.app_id = $1
     ORDER BY t.created_at DESC
     LIMIT $2 OFFSET $3`,
    [appId, limit, offset]
  );
  return result.rows;
}
