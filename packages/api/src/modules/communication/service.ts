import { query } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import type { MessageType, UUID } from '@synapse/shared';
import { generateId, nowISO, paginate } from '@synapse/shared';

const ALLOWED_MESSAGE_TYPES: MessageType[] = [
  'assign',
  'accept',
  'reject',
  'info_request',
  'info_response',
  'progress',
  'escalate',
  'assist_request',
  'assist_response',
  'transfer',
  'complete',
  'feedback',
  'rework',
  'user_message',
];

interface MessageRow {
  id: string;
  workspace_id: string;
  work_item_id: string | null;
  type: MessageType;
  from_actor_id: string | null;
  to_actor_id: string | null;
  from_user_id: string | null;
  to_user_id: string | null;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

function mapMessageRow(row: MessageRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workItemId: row.work_item_id ?? undefined,
    type: row.type,
    fromActorId: row.from_actor_id ?? undefined,
    toActorId: row.to_actor_id ?? undefined,
    fromUserId: row.from_user_id ?? undefined,
    toUserId: row.to_user_id ?? undefined,
    content: row.content,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export interface CreateMessageInput {
  type: MessageType;
  content: string;
  fromActorId?: string;
  toActorId?: string;
  fromUserId?: string;
  toUserId?: string;
  workItemId?: string;
  metadata?: Record<string, unknown>;
}

export interface ListMessagesInput {
  workItemId?: string;
  actorId?: string;
  type?: MessageType;
  page: number;
  pageSize: number;
}

export async function createMessage(workspaceId: UUID, input: CreateMessageInput) {
  if (!ALLOWED_MESSAGE_TYPES.includes(input.type)) {
    throw new MessageError(`Invalid message type: ${input.type}`, 400);
  }

  const id = generateId();
  const now = nowISO();

  const result = await query<MessageRow>(
    `INSERT INTO messages (id, workspace_id, type, content, from_actor_id, to_actor_id, from_user_id, to_user_id, work_item_id, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      id,
      workspaceId,
      input.type,
      input.content,
      input.fromActorId ?? null,
      input.toActorId ?? null,
      input.fromUserId ?? null,
      input.toUserId ?? null,
      input.workItemId ?? null,
      JSON.stringify(input.metadata ?? {}),
      now,
    ],
  );

  const message = mapMessageRow(result.rows[0]);

  await emitEvent({
    type: 'message.created',
    workspaceId,
    payload: { message },
    timestamp: now,
  });

  return message;
}

export async function listMessages(workspaceId: UUID, input: ListMessagesInput) {
  const { offset, limit, page, pageSize } = paginate(input.page, input.pageSize);

  const conditions: string[] = ['workspace_id = $1'];
  const params: any[] = [workspaceId];
  let paramIndex = 2;

  if (input.workItemId) {
    conditions.push(`work_item_id = $${paramIndex++}`);
    params.push(input.workItemId);
  }

  if (input.actorId) {
    conditions.push(`(from_actor_id = $${paramIndex} OR to_actor_id = $${paramIndex})`);
    paramIndex++;
    params.push(input.actorId);
  }

  if (input.type) {
    conditions.push(`type = $${paramIndex++}`);
    params.push(input.type);
  }

  const whereClause = conditions.join(' AND ');

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM messages WHERE ${whereClause}`,
    params,
  );

  const total = parseInt(countResult.rows[0].count, 10);

  const dataResult = await query<MessageRow>(
    `SELECT * FROM messages WHERE ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...params, limit, offset],
  );

  return {
    data: dataResult.rows.map(mapMessageRow),
    total,
    page,
    pageSize,
  };
}

export async function getConversation(workspaceId: UUID, actorId: UUID) {
  const result = await query<MessageRow>(
    `SELECT * FROM messages
     WHERE workspace_id = $1 AND (from_actor_id = $2 OR to_actor_id = $2)
     ORDER BY created_at ASC`,
    [workspaceId, actorId],
  );

  return result.rows.map(mapMessageRow);
}

export async function getWorkItemMessages(workspaceId: UUID, workItemId: UUID) {
  const result = await query<MessageRow>(
    `SELECT * FROM messages
     WHERE workspace_id = $1 AND work_item_id = $2
     ORDER BY created_at ASC`,
    [workspaceId, workItemId],
  );

  return result.rows.map(mapMessageRow);
}

export class MessageError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'MessageError';
  }
}
