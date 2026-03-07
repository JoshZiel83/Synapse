import { query } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { actorThinkingQueue } from '../../workers/queues.js';
import type { Actor, Message, WorkItem, UUID } from '@synapse/shared';
import { v4 as uuidv4 } from 'uuid';

export async function findSecretary(workspaceId: UUID): Promise<Actor | null> {
  const result = await query<Actor>(
    `SELECT * FROM actors WHERE workspace_id = $1 AND role = 'secretary' AND parent_id IS NULL LIMIT 1`,
    [workspaceId]
  );
  return result.rows[0] ?? null;
}

export async function processUserMessage(
  workspaceId: UUID,
  userId: UUID,
  content: string
): Promise<{ messageId: UUID; workItemId: UUID }> {
  const secretary = await findSecretary(workspaceId);
  if (!secretary) {
    throw new Error('No secretary found for this workspace');
  }

  const messageId = uuidv4();
  const workItemId = uuidv4();

  // Create user message
  await query(
    `INSERT INTO messages (id, workspace_id, type, from_user_id, to_actor_id, content, metadata, created_at)
     VALUES ($1, $2, 'user_message', $3, $4, $5, $6, NOW())`,
    [messageId, workspaceId, userId, secretary.id, content, JSON.stringify({})]
  );

  // Create work item
  await query(
    `INSERT INTO work_items (id, workspace_id, title, description, status, priority, source_type, created_by, assigned_to, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'created', 'medium', 'user_message', $5, $6, $7, NOW(), NOW())`,
    [
      workItemId,
      workspaceId,
      content.substring(0, 100),
      content,
      userId,
      secretary.id,
      JSON.stringify({}),
    ]
  );

  // Enqueue actor thinking job
  await actorThinkingQueue.add('think', {
    actorId: secretary.id,
    workItemId,
    workspaceId,
    trigger: 'user_message',
  });

  // Emit events
  await emitEvent({
    type: 'user.message',
    workspaceId,
    payload: { messageId, userId, actorId: secretary.id, content },
    timestamp: new Date().toISOString(),
  });

  return { messageId, workItemId };
}

export async function clearConversation(
  workspaceId: UUID,
  userId: UUID
): Promise<void> {
  const secretary = await findSecretary(workspaceId);
  if (!secretary) {
    throw new Error('No secretary found for this workspace');
  }

  // Delete conversation messages between this user and the secretary
  await query(
    `DELETE FROM messages
     WHERE workspace_id = $1
       AND (
         (from_user_id = $2 AND to_actor_id = $3)
         OR (from_actor_id = $3 AND type = 'secretary_response')
       )`,
    [workspaceId, userId, secretary.id]
  );
}

export async function getConversation(
  workspaceId: UUID,
  userId: UUID
): Promise<any[]> {
  const secretary = await findSecretary(workspaceId);
  if (!secretary) {
    throw new Error('No secretary found for this workspace');
  }

  const result = await query(
    `SELECT m.*,
       arl.group_id as log_group_id,
       arl.config_id as log_config_id,
       arl.input_tokens as log_input_tokens,
       arl.output_tokens as log_output_tokens,
       arl.latency_ms as log_latency_ms,
       arl.status as log_status,
       mic.provider_type as log_provider_type,
       mic.model_name as log_model_name,
       mg.name as log_group_name
     FROM messages m
     LEFT JOIN LATERAL (
       SELECT * FROM ai_request_logs
       WHERE workspace_id = m.workspace_id
         AND actor_id = m.from_actor_id
         AND request_type = 'actor_think'
         AND created_at >= m.created_at - interval '30 seconds'
         AND created_at <= m.created_at + interval '5 seconds'
       ORDER BY created_at DESC
       LIMIT 1
     ) arl ON m.type = 'secretary_response'
     LEFT JOIN model_item_configs mic ON mic.id = arl.config_id
     LEFT JOIN model_groups mg ON mg.id = arl.group_id
     WHERE m.workspace_id = $1
       AND (
         (m.from_user_id = $2 AND m.to_actor_id = $3)
         OR (m.from_actor_id = $3 AND m.type = 'secretary_response')
       )
     ORDER BY m.created_at ASC`,
    [workspaceId, userId, secretary.id]
  );

  return result.rows;
}
