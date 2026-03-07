import { query, transaction } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { generateId, nowISO, isValidTransition } from '@synapse/shared';
import type { WorkItem, WorkItemStatus, WorkItemPriority, WorkItemParticipant, ParticipantRole, UUID } from '@synapse/shared';
import { validateTransition, getAvailableTransitions } from './state-machine.js';

// ─── WorkItem CRUD ───

export async function createWorkItem(params: {
  workspaceId: UUID;
  title: string;
  description: string;
  priority: WorkItemPriority;
  createdBy: UUID;
  assignedTo?: UUID;
  accountableId?: UUID;
  parentId?: UUID;
  sourceType: WorkItem['sourceType'];
  sourceId?: UUID;
  dueAt?: string;
  metadata?: Record<string, unknown>;
}): Promise<WorkItem> {
  const id = generateId();
  const now = nowISO();
  const metadata = params.metadata ?? {};

  const result = await query(
    `INSERT INTO work_items (id, workspace_id, title, description, status, priority, parent_id, created_by, assigned_to, accountable_id, source_type, source_id, due_at, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'created', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
     RETURNING *`,
    [id, params.workspaceId, params.title, params.description, params.priority, params.parentId ?? null, params.createdBy, params.assignedTo ?? null, params.accountableId ?? null, params.sourceType, params.sourceId ?? null, params.dueAt ?? null, JSON.stringify(metadata), now]
  );

  const workItem = mapRow(result.rows[0]);

  await emitEvent({
    type: 'work_item.created',
    workspaceId: params.workspaceId,
    payload: { workItem },
    timestamp: now,
  });

  return workItem;
}

export async function listWorkItems(workspaceId: UUID, filters?: {
  status?: WorkItemStatus;
  assignedTo?: UUID;
  priority?: WorkItemPriority;
}): Promise<WorkItem[]> {
  const conditions = ['workspace_id = $1'];
  const values: any[] = [workspaceId];
  let idx = 2;

  if (filters?.status) {
    conditions.push(`status = $${idx++}`);
    values.push(filters.status);
  }
  if (filters?.assignedTo) {
    conditions.push(`assigned_to = $${idx++}`);
    values.push(filters.assignedTo);
  }
  if (filters?.priority) {
    conditions.push(`priority = $${idx++}`);
    values.push(filters.priority);
  }

  const result = await query(
    `SELECT * FROM work_items WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    values
  );
  return result.rows.map(mapRow);
}

export async function getWorkItem(workItemId: UUID, workspaceId: UUID): Promise<WorkItem | null> {
  const result = await query(
    `SELECT * FROM work_items WHERE id = $1 AND workspace_id = $2`,
    [workItemId, workspaceId]
  );
  return result.rows.length ? mapRow(result.rows[0]) : null;
}

export async function getWorkItemWithDetails(workItemId: UUID, workspaceId: UUID): Promise<{
  workItem: WorkItem;
  participants: WorkItemParticipant[];
} | null> {
  const workItem = await getWorkItem(workItemId, workspaceId);
  if (!workItem) return null;

  const participants = await getParticipants(workItemId);
  return { workItem, participants };
}

export async function updateWorkItem(workItemId: UUID, workspaceId: UUID, updates: Partial<{
  title: string;
  description: string;
  priority: WorkItemPriority;
  assignedTo: UUID | null;
  accountableId: UUID | null;
  dueAt: string | null;
  result: string;
  metadata: Record<string, unknown>;
}>): Promise<WorkItem | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;

  const columnMap: Record<string, string> = {
    title: 'title',
    description: 'description',
    priority: 'priority',
    assignedTo: 'assigned_to',
    accountableId: 'accountable_id',
    dueAt: 'due_at',
    result: 'result',
    metadata: 'metadata',
  };

  for (const [key, col] of Object.entries(columnMap)) {
    if (key in updates) {
      const val = (updates as any)[key];
      fields.push(`${col} = $${idx++}`);
      values.push(key === 'metadata' ? JSON.stringify(val) : val);
    }
  }

  if (fields.length === 0) return getWorkItem(workItemId, workspaceId);

  fields.push(`updated_at = $${idx++}`);
  values.push(nowISO());

  values.push(workItemId, workspaceId);
  const result = await query(
    `UPDATE work_items SET ${fields.join(', ')} WHERE id = $${idx++} AND workspace_id = $${idx} RETURNING *`,
    values
  );

  if (!result.rows.length) return null;

  const workItem = mapRow(result.rows[0]);

  await emitEvent({
    type: 'work_item.updated',
    workspaceId,
    payload: { workItem },
    timestamp: nowISO(),
  });

  return workItem;
}

// ─── Transitions ───

export async function transitionWorkItem(workItemId: UUID, workspaceId: UUID, toStatus: WorkItemStatus): Promise<WorkItem> {
  return transaction(async (client) => {
    const current = await client.query(
      `SELECT * FROM work_items WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [workItemId, workspaceId]
    );

    if (!current.rows.length) {
      throw new Error('Work item not found');
    }

    const currentStatus = current.rows[0].status as WorkItemStatus;

    if (!validateTransition(currentStatus, toStatus)) {
      throw new Error(`Invalid transition from '${currentStatus}' to '${toStatus}'. Allowed: ${getAvailableTransitions(currentStatus).join(', ') || 'none'}`);
    }

    const now = nowISO();
    const extraSets: string[] = [];
    const extraValues: any[] = [];
    let idx = 4;

    if (toStatus === 'in_progress') {
      extraSets.push(`started_at = $${idx++}`);
      extraValues.push(now);
    }
    if (toStatus === 'completed') {
      extraSets.push(`completed_at = $${idx++}`);
      extraValues.push(now);
    }

    const setClauses = [`status = $1`, `updated_at = $2`, ...extraSets].join(', ');

    const result = await client.query(
      `UPDATE work_items SET ${setClauses} WHERE id = $3 RETURNING *`,
      [toStatus, now, workItemId, ...extraValues]
    );

    const workItem = mapRow(result.rows[0]);

    await emitEvent({
      type: 'work_item.transitioned',
      workspaceId,
      payload: {
        workItem,
        from: currentStatus,
        to: toStatus,
      },
      timestamp: now,
    });

    return workItem;
  });
}

// ─── Participants ───

export async function addParticipant(params: {
  workItemId: UUID;
  actorId: UUID;
  role: ParticipantRole;
}): Promise<WorkItemParticipant> {
  const id = generateId();
  const now = nowISO();

  const result = await query(
    `INSERT INTO work_item_participants (id, work_item_id, actor_id, role, added_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [id, params.workItemId, params.actorId, params.role, now]
  );

  return mapParticipantRow(result.rows[0]);
}

export async function getParticipants(workItemId: UUID): Promise<WorkItemParticipant[]> {
  const result = await query(
    `SELECT * FROM work_item_participants WHERE work_item_id = $1 ORDER BY added_at`,
    [workItemId]
  );
  return result.rows.map(mapParticipantRow);
}

// ─── Row mappers ───

function mapRow(row: any): WorkItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    parentId: row.parent_id ?? undefined,
    createdBy: row.created_by,
    assignedTo: row.assigned_to ?? undefined,
    accountableId: row.accountable_id ?? undefined,
    sourceType: row.source_type,
    sourceId: row.source_id ?? undefined,
    dueAt: row.due_at ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    result: row.result ?? undefined,
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapParticipantRow(row: any): WorkItemParticipant {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    actorId: row.actor_id,
    role: row.role,
    addedAt: row.added_at,
  };
}
