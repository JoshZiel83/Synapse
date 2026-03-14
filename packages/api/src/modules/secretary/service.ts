import { query } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import {
  createSession,
  getSessionsByActor,
  getSessionMessages,
  addSessionMessage,
} from '../session/service.js';
import { getToolHistoryForSession } from '../execution/service.js';
import { sessionThinkingQueue } from '../../workers/queues.js';
import type { Actor, UUID } from '@synapse/shared';

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
): Promise<{ sessionId: UUID }> {
  const secretary = await findSecretary(workspaceId);
  if (!secretary) {
    throw new Error('No secretary found for this workspace');
  }

  // Create session and enqueue thinking
  const session = await createSession({
    workspaceId,
    actorId: secretary.id,
    channelType: 'web',
    trigger: 'user_message',
    metadata: { userId },
  });

  // Add the initial message
  await addSessionMessage({
    sessionId: session.id,
    workspaceId,
    role: 'user',
    content,
    fromUserId: userId,
  });

  // Enqueue thinking
  await sessionThinkingQueue.add('think', {
    sessionId: session.id,
    actorId: secretary.id,
    workspaceId,
    trigger: 'user_message',
    userId,
  });

  // Emit events
  await emitEvent({
    type: 'user.message',
    workspaceId,
    payload: {
      userId,
      actorId: secretary.id,
      content,
      sessionId: session.id,
    },
    timestamp: new Date().toISOString(),
  });

  return {
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

  // Cancel active sessions and mark session messages as cleared
  await query(
    `UPDATE sessions SET status = 'cancelled', updated_at = NOW()
     WHERE workspace_id = $1 AND actor_id = $2 AND channel_type = 'web'
       AND status NOT IN ('completed', 'failed', 'cancelled', 'timed_out')`,
    [workspaceId, secretary.id]
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

  // Get recent web sessions for this secretary
  const sessionsResult = await query(
    `SELECT id FROM sessions
     WHERE workspace_id = $1 AND actor_id = $2 AND channel_type = 'web'
     ORDER BY created_at DESC LIMIT 10`,
    [workspaceId, secretary.id]
  );

  if (sessionsResult.rows.length === 0) return [];

  const rows: any[] = [];
  for (const sessionRow of sessionsResult.rows) {
    const [messages, providerSteps, toolHistory] = await Promise.all([
      getSessionMessages(sessionRow.id),
      query(
        `SELECT ps.*, mg.name AS model_group_name, mpr.provider_type, mpr.model_name
         FROM provider_steps ps
         LEFT JOIN model_groups mg ON mg.id = ps.model_group_id
         LEFT JOIN model_profile_revisions mpr ON mpr.id = ps.model_profile_revision_id
         JOIN turns t ON t.id = ps.turn_id
         WHERE t.session_id = $1
         ORDER BY ps.created_at DESC`,
        [sessionRow.id],
      ),
      getToolHistoryForSession(sessionRow.id),
    ]);

    const latestStep = providerSteps.rows[0];
    const hasToolHistory = toolHistory.length > 0;

    for (const message of messages) {
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      rows.push({
        id: message.id,
        workspace_id: workspaceId,
        type: message.role === 'user' ? 'user_message' : 'secretary_response',
        from_user_id: message.from_user_id,
        from_actor_id: message.from_actor_id,
        content: message.content,
        metadata: message.metadata,
        created_at: message.created_at,
        session_id: message.session_id,
        log_group_id: latestStep?.model_group_id,
        log_config_id: latestStep?.model_profile_revision_id,
        log_input_tokens: latestStep?.input_tokens,
        log_output_tokens: latestStep?.output_tokens,
        log_latency_ms: latestStep?.latency_ms,
        log_status: latestStep?.status,
        log_provider_type: latestStep?.provider_type,
        log_model_name: latestStep?.model_name,
        log_group_name: latestStep?.model_group_name,
        has_tool_history: hasToolHistory,
      });
    }
  }

  rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return rows;
}
