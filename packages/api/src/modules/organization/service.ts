import { query, transaction } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { generateId, nowISO } from '@synapse/shared';
import type { Actor, ActorRole, ActorSkill, ActorCollaboration, UUID } from '@synapse/shared';

// ─── Actor CRUD ───

export async function createActor(params: {
  workspaceId: UUID;
  name: string;
  role: ActorRole;
  title: string;
  charter: string;
  systemPrompt: string;
  parentId?: UUID;
  capabilities?: string[];
  skills?: ActorSkill[];
  config?: Record<string, unknown>;
}): Promise<Actor> {
  const id = generateId();
  const now = nowISO();
  const capabilities = params.capabilities ?? [];
  const skills = params.skills ?? [];
  const config = params.config ?? {};

  const result = await query(
    `INSERT INTO actors (id, workspace_id, name, role, title, charter, system_prompt, parent_id, capabilities, skills, config, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12, $12)
     RETURNING *`,
    [id, params.workspaceId, params.name, params.role, params.title, params.charter, params.systemPrompt, params.parentId ?? null, capabilities, JSON.stringify(skills), JSON.stringify(config), now]
  );

  // Create initial version (version=1)
  await query(
    `INSERT INTO actor_versions (actor_id, version, name, role, title, charter, system_prompt, skills, config, capabilities, created_at)
     VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, params.name, params.role, params.title, params.charter, params.systemPrompt, JSON.stringify(skills), JSON.stringify(config), capabilities, now]
  );

  return mapRow(result.rows[0]);
}

export async function listActors(workspaceId: UUID): Promise<Actor[]> {
  const result = await query(
    `SELECT * FROM actors WHERE workspace_id = $1 AND is_active = true ORDER BY name`,
    [workspaceId]
  );
  return result.rows.map(mapRow);
}

export async function getActor(actorId: UUID, workspaceId: UUID): Promise<Actor | null> {
  const result = await query(
    `SELECT * FROM actors WHERE id = $1 AND workspace_id = $2`,
    [actorId, workspaceId]
  );
  return result.rows.length ? mapRow(result.rows[0]) : null;
}

export async function updateActor(actorId: UUID, workspaceId: UUID, updates: Partial<{
  name: string;
  role: ActorRole;
  title: string;
  charter: string;
  systemPrompt: string;
  parentId: UUID | null;
  capabilities: string[];
  skills: ActorSkill[];
  config: Record<string, unknown>;
}>): Promise<Actor | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;

  const columnMap: Record<string, string> = {
    name: 'name',
    role: 'role',
    title: 'title',
    charter: 'charter',
    systemPrompt: 'system_prompt',
    parentId: 'parent_id',
    capabilities: 'capabilities',
    skills: 'skills',
    config: 'config',
  };

  for (const [key, col] of Object.entries(columnMap)) {
    if (key in updates) {
      const val = (updates as any)[key];
      fields.push(`${col} = $${idx++}`);
      values.push(key === 'config' || key === 'skills' ? JSON.stringify(val) : val);
    }
  }

  if (fields.length === 0) return getActor(actorId, workspaceId);

  fields.push(`updated_at = $${idx++}`);
  values.push(nowISO());

  values.push(actorId, workspaceId);
  const result = await query(
    `UPDATE actors SET ${fields.join(', ')} WHERE id = $${idx++} AND workspace_id = $${idx} RETURNING *`,
    values
  );

  if (result.rows.length === 0) return null;

  // Insert new version into actor_versions
  const actorRow = result.rows[0];
  await query(
    `INSERT INTO actor_versions (actor_id, version, name, role, title, charter, system_prompt, skills, config, capabilities, created_at)
     SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3, $4, $5, $6, $7, $8, $9, NOW()
     FROM actor_versions WHERE actor_id = $1`,
    [actorId, actorRow.name, actorRow.role, actorRow.title, actorRow.charter, actorRow.system_prompt,
     typeof actorRow.skills === 'string' ? actorRow.skills : JSON.stringify(actorRow.skills || []),
     typeof actorRow.config === 'string' ? actorRow.config : JSON.stringify(actorRow.config || {}),
     actorRow.capabilities || []]
  );

  // Emit WebSocket event for real-time frontend updates
  await emitEvent({
    type: 'actor.version_changed',
    workspaceId: actorRow.workspace_id,
    payload: { actorId, name: actorRow.name },
    timestamp: nowISO(),
  });

  return mapRow(result.rows[0]);
}

export async function deleteActor(actorId: UUID, workspaceId: UUID): Promise<boolean> {
  const result = await query(
    `UPDATE actors SET is_active = false, updated_at = $1 WHERE id = $2 AND workspace_id = $3 RETURNING id`,
    [nowISO(), actorId, workspaceId]
  );
  return result.rowCount !== null && result.rowCount > 0;
}

// ─── Org Tree ───

export async function getChildren(actorId: UUID, workspaceId: UUID): Promise<Actor[]> {
  const result = await query(
    `SELECT * FROM actors WHERE parent_id = $1 AND workspace_id = $2 AND is_active = true ORDER BY name`,
    [actorId, workspaceId]
  );
  return result.rows.map(mapRow);
}

export async function getSubtree(actorId: UUID): Promise<(Actor & { depth: number })[]> {
  const result = await query(
    `WITH RECURSIVE tree AS (
      SELECT *, 0 as depth FROM actors WHERE id = $1
      UNION ALL
      SELECT a.*, t.depth + 1 FROM actors a JOIN tree t ON a.parent_id = t.id
    ) SELECT * FROM tree WHERE is_active = true ORDER BY depth`,
    [actorId]
  );
  return result.rows.map((r) => ({ ...mapRow(r), depth: r.depth }));
}

export async function getFullOrgTree(workspaceId: UUID): Promise<(Actor & { depth: number })[]> {
  const result = await query(
    `WITH RECURSIVE tree AS (
      SELECT *, 0 as depth FROM actors WHERE workspace_id = $1 AND parent_id IS NULL
      UNION ALL
      SELECT a.*, t.depth + 1 FROM actors a JOIN tree t ON a.parent_id = t.id WHERE a.workspace_id = $1
    ) SELECT * FROM tree WHERE is_active = true ORDER BY depth, name`,
    [workspaceId]
  );
  return result.rows.map((r) => ({ ...mapRow(r), depth: r.depth }));
}

// ─── Collaborations ───

export async function addCollaboration(params: {
  actorId: UUID;
  collaboratorId: UUID;
  relationship: string;
  description?: string;
}): Promise<ActorCollaboration> {
  const id = generateId();
  const now = nowISO();

  const result = await query(
    `INSERT INTO actor_collaborations (id, actor_id, collaborator_id, relationship, description, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [id, params.actorId, params.collaboratorId, params.relationship, params.description ?? null, now]
  );

  return mapCollabRow(result.rows[0]);
}

export async function getCollaborations(actorId: UUID): Promise<ActorCollaboration[]> {
  const result = await query(
    `SELECT * FROM actor_collaborations WHERE actor_id = $1 OR collaborator_id = $1 ORDER BY created_at`,
    [actorId]
  );
  return result.rows.map(mapCollabRow);
}

// ─── Row mappers ───

function mapRow(row: any): Actor {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    role: row.role,
    title: row.title,
    charter: row.charter,
    systemPrompt: row.system_prompt,
    parentId: row.parent_id ?? undefined,
    capabilities: typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) : row.capabilities,
    skills: row.skills ? (typeof row.skills === 'string' ? JSON.parse(row.skills) : row.skills) : [],
    config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCollabRow(row: any): ActorCollaboration {
  return {
    id: row.id,
    actorId: row.actor_id,
    collaboratorId: row.collaborator_id,
    relationship: row.relationship,
    description: row.description ?? undefined,
    createdAt: row.created_at,
  };
}
