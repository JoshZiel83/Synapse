import { query, transaction } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { sessionThinkingQueue } from '../../workers/queues.js';
import { shutdownSessionInstances } from '../mcp-plugins/instance-manager.js';
import type { UUID } from '@synapse/shared';
import { nowISO } from '@synapse/shared';
import { v4 as uuidv4 } from 'uuid';

// DB rows come back as snake_case — use `any` like the rest of the codebase.

// ============ Session CRUD ============

export async function createSession(params: {
  workspaceId: UUID;
  actorId: UUID;
  groupId?: UUID;
  channelType?: string;
  trigger?: string;
  metadata?: Record<string, unknown>;
}): Promise<any> {
  const {
    workspaceId, actorId, groupId,
    channelType = 'web',
    trigger = 'user_message', metadata = {},
  } = params;

  const id = uuidv4();

  const result = await query(
    `INSERT INTO sessions (id, workspace_id, actor_id, group_id, channel_type, trigger, status, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, NOW(), NOW())
     RETURNING *`,
    [id, workspaceId, actorId, groupId || null, channelType, trigger, JSON.stringify(metadata)]
  );

  return result.rows[0];
}

export async function getSession(sessionId: UUID): Promise<any | null> {
  const result = await query(
    'SELECT * FROM sessions WHERE id = $1',
    [sessionId]
  );
  return result.rows[0] ?? null;
}

export async function getSessionsByActor(
  workspaceId: UUID,
  actorId: UUID,
  status?: string
): Promise<any[]> {
  if (status) {
    const result = await query(
      'SELECT * FROM sessions WHERE workspace_id = $1 AND actor_id = $2 AND status = $3 ORDER BY created_at DESC',
      [workspaceId, actorId, status]
    );
    return result.rows;
  }
  const result = await query(
    'SELECT * FROM sessions WHERE workspace_id = $1 AND actor_id = $2 ORDER BY created_at DESC',
    [workspaceId, actorId]
  );
  return result.rows;
}

export async function updateSessionStatus(
  sessionId: UUID,
  status: string,
  extra?: { errorMessage?: string }
): Promise<void> {
  const sets = ['status = $2', 'updated_at = NOW()'];
  const params: any[] = [sessionId, status];
  let idx = 3;

  if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timed_out') {
    sets.push(`completed_at = NOW()`);
  }
  if (extra?.errorMessage !== undefined) {
    sets.push(`error_message = $${idx}`);
    params.push(extra.errorMessage);
    idx++;
  }

  await query(
    `UPDATE sessions SET ${sets.join(', ')} WHERE id = $1`,
    params
  );
}

// ============ Session Messages ============

export async function addSessionMessage(params: {
  sessionId: UUID;
  workspaceId: UUID;
  role: string;
  content: string;
  fromActorId?: UUID;
  fromUserId?: UUID;
  metadata?: Record<string, unknown>;
}): Promise<any> {
  const { sessionId, workspaceId, role, content, fromActorId, fromUserId, metadata = {} } = params;
  const id = uuidv4();

  const result = await query(
    `INSERT INTO session_messages (id, session_id, workspace_id, role, content, from_actor_id, from_user_id, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     RETURNING *`,
    [id, sessionId, workspaceId, role, content, fromActorId || null, fromUserId || null, JSON.stringify(metadata)]
  );

  // Emit session.message.new for chat UI — but only for non-group sessions.
  // Group sessions emit events via sendGroupMessage() to avoid duplicates.
  const session = await getSession(sessionId);
  if (session && !session.group_id) {
    let actorName: string | undefined;
    if (fromActorId) {
      const actorResult = await query('SELECT name FROM actors WHERE id = $1', [fromActorId]);
      actorName = actorResult.rows[0]?.name;
    }
    await emitEvent({
      type: 'session.message.new',
      workspaceId,
      payload: {
        sessionId,
        messageId: id,
        role,
        content,
        fromActorId,
        fromActorName: actorName,
        fromUserId,
        metadata,
      },
      timestamp: nowISO(),
    });
  }

  return result.rows[0];
}

export async function getSessionMessages(sessionId: UUID): Promise<any[]> {
  const result = await query(
    'SELECT * FROM session_messages WHERE session_id = $1 ORDER BY created_at ASC',
    [sessionId]
  );
  return result.rows;
}

// ============ Session Interrupts ============

export async function consumeInterrupts(sessionId: UUID): Promise<any[]> {
  const result = await query(
    `UPDATE session_interrupts SET is_consumed = TRUE
     WHERE target_session_id = $1 AND is_consumed = FALSE
     RETURNING *`,
    [sessionId]
  );
  return result.rows;
}

export async function createInterrupt(params: {
  targetSessionId: UUID;
  type: string;
  content: string;
  fromSessionId?: UUID;
}): Promise<void> {
  await query(
    `INSERT INTO session_interrupts (id, target_session_id, type, content, from_session_id, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [uuidv4(), params.targetSessionId, params.type, params.content, params.fromSessionId || null]
  );
}

// ============ Cancel Session ============

export async function cancelSession(sessionId: UUID): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) throw new Error('Session not found');
  if (session.status === 'completed' || session.status === 'cancelled') {
    throw new Error(`Session already ${session.status}`);
  }

  await updateSessionStatus(sessionId, 'cancelled');

  // Cleanup session-scoped MCP instances
  await shutdownSessionInstances(sessionId).catch(() => {});
}

// ============ Actor concurrent session count ============

export async function getActiveSessionCount(actorId: UUID): Promise<number> {
  const result = await query(
    `SELECT COUNT(*) as count FROM sessions WHERE actor_id = $1 AND status IN ('active', 'sleeping')`,
    [actorId]
  );
  return parseInt(result.rows[0].count, 10);
}

export async function getMaxConcurrentSessions(actorId: UUID): Promise<number> {
  const result = await query(
    'SELECT max_concurrent_sessions FROM actors WHERE id = $1',
    [actorId]
  );
  return result.rows[0]?.max_concurrent_sessions ?? 3;
}
