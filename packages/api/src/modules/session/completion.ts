import { query } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { sessionThinkingQueue } from '../../workers/queues.js';
import { addSessionMessage, getSession, updateSessionStatus } from './service.js';
import type { UUID } from '@synapse/shared';
import { nowISO } from '@synapse/shared';

/**
 * Called when a child session completes (success or failure).
 * Handles the cascade: insert child_result in parent, update waiting_for,
 * and resume parent if all children are done.
 */
export async function onSessionCompleted(
  childSessionId: UUID,
  result: string,
  success: boolean
): Promise<void> {
  const childSession = await getSession(childSessionId);
  if (!childSession) return;
  if (!childSession.parent_session_id) return; // root session, no parent to notify

  const parentSession = await getSession(childSession.parent_session_id);
  if (!parentSession) return;

  // Get child actor name for the result message
  const actorResult = await query('SELECT name FROM actors WHERE id = $1', [childSession.actor_id]);
  const actorName = actorResult.rows[0]?.name || 'Unknown';

  // Insert child_result message in parent session
  const content = success
    ? `[子任务完成] ${actorName} 的结果:\n${result}`
    : `[子任务失败] ${actorName} 报告错误:\n${result}`;

  await addSessionMessage({
    sessionId: parentSession.id,
    workspaceId: parentSession.workspace_id,
    role: 'child_result',
    content,
    fromActorId: childSession.actor_id,
    metadata: {
      childSessionId,
      childActorId: childSession.actor_id,
      childActorName: actorName,
      success,
    },
  });

  // Atomically remove from waiting_for — only the transaction that empties the array triggers resume
  if (parentSession.status === 'waiting') {
    const updateResult = await query(
      `UPDATE sessions SET waiting_for = array_remove(waiting_for, $1), updated_at = NOW()
       WHERE id = $2
       RETURNING waiting_for`,
      [childSessionId, parentSession.id]
    );

    const remainingWaiting = updateResult.rows[0]?.waiting_for || [];

    if (remainingWaiting.length === 0) {
      // All children done — resume parent session
      await resumeSession(parentSession.id);
    }
  }
}

/**
 * Resume a waiting session by setting it back to active and enqueueing a thinking job.
 */
export async function resumeSession(sessionId: UUID): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) return;

  await updateSessionStatus(sessionId, 'active', {
    waitingFor: [],
  });

  // Emit session.status.changed
  await emitEvent({
    type: 'session.status.changed',
    workspaceId: session.workspace_id,
    payload: { rootSessionId: session.root_session_id || sessionId, sessionId, status: 'active' },
    timestamp: nowISO(),
  });

  // Enqueue a new thinking job for the resumed session
  await sessionThinkingQueue.add('think', {
    sessionId: session.id,
    actorId: session.actor_id,
    workspaceId: session.workspace_id,
    workItemId: session.work_item_id,
    trigger: 'resume',
  });

  console.log(`[session-completion] Resumed session ${sessionId}`);
}
