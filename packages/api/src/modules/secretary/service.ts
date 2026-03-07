import { query } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import {
  createSessionAndEnqueue,
  getSessionsByActor,
  getSessionMessages,
  addSessionMessage,
} from '../session/service.js';
import type { Actor, UUID } from '@synapse/shared';
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
): Promise<{ messageId: UUID; workItemId: UUID; sessionId: UUID }> {
  const secretary = await findSecretary(workspaceId);
  if (!secretary) {
    throw new Error('No secretary found for this workspace');
  }

  // Also write to legacy messages table for backward compatibility
  const legacyMessageId = uuidv4();
  await query(
    `INSERT INTO messages (id, workspace_id, type, from_user_id, to_actor_id, content, metadata, created_at)
     VALUES ($1, $2, 'user_message', $3, $4, $5, $6, NOW())`,
    [legacyMessageId, workspaceId, userId, secretary.id, content, JSON.stringify({})]
  );

  // Create session and enqueue thinking
  const session = await createSessionAndEnqueue({
    workspaceId,
    actorId: secretary.id,
    channelType: 'web',
    trigger: 'user_message',
    initialMessage: content,
    userId,
  });

  // Emit events
  await emitEvent({
    type: 'user.message',
    workspaceId,
    payload: {
      messageId: legacyMessageId,
      userId,
      actorId: secretary.id,
      content,
      sessionId: session.id,
    },
    timestamp: new Date().toISOString(),
  });

  return {
    messageId: legacyMessageId,
    workItemId: session.work_item_id,
    sessionId: session.id,
  };
}

export async function clearConversation(
  workspaceId: UUID,
  userId: UUID
): Promise<void> {
  const secretary = await findSecretary(workspaceId);
  if (!secretary) {
    throw new Error('No secretary found for this workspace');
  }

  // Delete legacy conversation messages between this user and the secretary
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

  // Try session_messages first (new system)
  // Find the most recent session for this secretary (web channel)
  const sessionsResult = await query(
    `SELECT id FROM sessions
     WHERE workspace_id = $1 AND actor_id = $2 AND channel_type = 'web'
     ORDER BY created_at DESC LIMIT 10`,
    [workspaceId, secretary.id]
  );

  if (sessionsResult.rows.length > 0) {
    const sessionIds = sessionsResult.rows.map((r: any) => r.id);
    // Get session messages from recent sessions
    const sessionMsgsResult = await query(
      `SELECT sm.*,
         arl.group_id as log_group_id,
         arl.config_id as log_config_id,
         arl.input_tokens as log_input_tokens,
         arl.output_tokens as log_output_tokens,
         arl.latency_ms as log_latency_ms,
         arl.status as log_status,
         mic.provider_type as log_provider_type,
         mic.model_name as log_model_name,
         mg.name as log_group_name
       FROM session_messages sm
       LEFT JOIN LATERAL (
         SELECT * FROM ai_request_logs
         WHERE workspace_id = sm.workspace_id
           AND actor_id = sm.from_actor_id
           AND request_type = 'actor_think'
           AND created_at >= sm.created_at - interval '30 seconds'
           AND created_at <= sm.created_at + interval '5 seconds'
         ORDER BY created_at DESC
         LIMIT 1
       ) arl ON sm.role = 'assistant'
       LEFT JOIN model_item_configs mic ON mic.id = arl.config_id
       LEFT JOIN model_groups mg ON mg.id = arl.group_id
       WHERE sm.session_id = ANY($1)
         AND sm.role IN ('user', 'assistant')
       ORDER BY sm.created_at ASC`,
      [sessionIds]
    );

    if (sessionMsgsResult.rows.length > 0) {
      // Transform session messages to match legacy format
      return sessionMsgsResult.rows.map((row: any) => ({
        id: row.id,
        workspace_id: row.workspace_id,
        type: row.role === 'user' ? 'user_message' : 'secretary_response',
        from_user_id: row.from_user_id,
        from_actor_id: row.from_actor_id,
        content: row.content,
        metadata: row.metadata,
        created_at: row.created_at,
        session_id: row.session_id,
        // AI request log fields
        log_group_id: row.log_group_id,
        log_config_id: row.log_config_id,
        log_input_tokens: row.log_input_tokens,
        log_output_tokens: row.log_output_tokens,
        log_latency_ms: row.log_latency_ms,
        log_status: row.log_status,
        log_provider_type: row.log_provider_type,
        log_model_name: row.log_model_name,
        log_group_name: row.log_group_name,
      }));
    }
  }

  // Fallback: use legacy messages table
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
