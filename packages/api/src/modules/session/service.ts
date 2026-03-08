import { query, transaction } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { sessionThinkingQueue } from '../../workers/queues.js';
import type { UUID } from '@synapse/shared';
import { MAX_SESSION_DEPTH, nowISO } from '@synapse/shared';
import { v4 as uuidv4 } from 'uuid';

// DB rows come back as snake_case — use `any` like the rest of the codebase.

// ============ Session CRUD ============

export async function createSession(params: {
  workspaceId: UUID;
  actorId: UUID;
  channelType?: string;
  channelId?: string;
  parentSessionId?: UUID;
  rootSessionId?: UUID;
  depth?: number;
  trigger?: string;
  metadata?: Record<string, unknown>;
}): Promise<any> {
  const {
    workspaceId, actorId, channelType = 'web', channelId,
    parentSessionId, rootSessionId, depth = 0,
    trigger = 'user_message', metadata = {},
  } = params;

  if (depth >= MAX_SESSION_DEPTH) {
    throw new Error(`Max session depth (${MAX_SESSION_DEPTH}) exceeded`);
  }

  const id = uuidv4();
  const workItemId = uuidv4();

  const session = await transaction(async (client) => {
    // Create a work item for this session
    await client.query(
      `INSERT INTO work_items (id, workspace_id, title, description, status, priority, source_type, created_by, assigned_to, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'created', 'medium', $5, $6, $6, $7, NOW(), NOW())`,
      [
        workItemId, workspaceId, `Session ${id.substring(0, 8)}`, '',
        trigger === 'delegation' ? 'delegation' : 'user_message',
        actorId, JSON.stringify({}),
      ]
    );

    // Create the session
    const result = await client.query(
      `INSERT INTO sessions (id, workspace_id, actor_id, parent_session_id, root_session_id, depth, channel_type, channel_id, work_item_id, trigger, status, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11, NOW(), NOW())
       RETURNING *`,
      [
        id, workspaceId, actorId,
        parentSessionId || null,
        rootSessionId || id, // root is self if no parent
        depth,
        channelType, channelId || null,
        workItemId,
        trigger,
        JSON.stringify(metadata),
      ]
    );

    return result.rows[0];
  });

  return session;
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
  extra?: { waitingFor?: UUID[]; waitTimeoutAt?: string; errorMessage?: string; resumeContext?: Record<string, unknown> }
): Promise<void> {
  const sets = ['status = $2', 'updated_at = NOW()'];
  const params: any[] = [sessionId, status];
  let idx = 3;

  if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timed_out') {
    sets.push(`completed_at = NOW()`);
  }
  if (extra?.waitingFor !== undefined) {
    sets.push(`waiting_for = $${idx}`);
    params.push(extra.waitingFor);
    idx++;
  }
  if (extra?.waitTimeoutAt !== undefined) {
    sets.push(`wait_timeout_at = $${idx}`);
    params.push(extra.waitTimeoutAt);
    idx++;
  }
  if (extra?.errorMessage !== undefined) {
    sets.push(`error_message = $${idx}`);
    params.push(extra.errorMessage);
    idx++;
  }
  if (extra?.resumeContext !== undefined) {
    sets.push(`resume_context = $${idx}`);
    params.push(JSON.stringify(extra.resumeContext));
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

  // Emit session.message.new for chat UI
  const session = await getSession(sessionId);
  if (session) {
    let actorName: string | undefined;
    if (fromActorId) {
      const actorResult = await query('SELECT name FROM actors WHERE id = $1', [fromActorId]);
      actorName = actorResult.rows[0]?.name;
    }
    await emitEvent({
      type: 'session.message.new',
      workspaceId,
      payload: {
        rootSessionId: session.root_session_id || sessionId,
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

// ============ Session Tree ============

export async function getSessionTree(sessionId: UUID): Promise<any[]> {
  const session = await getSession(sessionId);
  if (!session) return [];

  const rootId = session.root_session_id || sessionId;

  const result = await query(
    `SELECT s.*, a.name as actor_name, a.role as actor_role
     FROM sessions s
     JOIN actors a ON a.id = s.actor_id
     WHERE s.root_session_id = $1 OR s.id = $1
     ORDER BY s.depth ASC, s.created_at ASC`,
    [rootId]
  );

  return result.rows;
}

// ============ Create Session + Enqueue Thinking ============

export async function createSessionAndEnqueue(params: {
  workspaceId: UUID;
  actorId: UUID;
  channelType?: string;
  channelId?: string;
  parentSessionId?: UUID;
  rootSessionId?: UUID;
  depth?: number;
  trigger?: string;
  initialMessage: string;
  userId?: UUID;
  fromActorId?: UUID;
  metadata?: Record<string, unknown>;
}): Promise<any> {
  const session = await createSession({
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    channelType: params.channelType,
    channelId: params.channelId,
    parentSessionId: params.parentSessionId,
    rootSessionId: params.rootSessionId,
    depth: params.depth,
    trigger: params.trigger,
    metadata: params.metadata,
  });

  // Add the initial message
  const role = params.trigger === 'delegation' ? 'system' : 'user';
  await addSessionMessage({
    sessionId: session.id,
    workspaceId: params.workspaceId,
    role,
    content: params.initialMessage,
    fromUserId: params.userId,
    fromActorId: params.fromActorId,
  });

  // Enqueue session-thinking job
  await sessionThinkingQueue.add('think', {
    sessionId: session.id,
    actorId: params.actorId,
    workspaceId: params.workspaceId,
    workItemId: session.work_item_id,
    trigger: params.trigger || 'user_message',
    userId: params.userId,
  });

  // Emit event
  await emitEvent({
    type: 'work_item.created',
    workspaceId: params.workspaceId,
    payload: { sessionId: session.id, actorId: params.actorId },
    timestamp: new Date().toISOString(),
  });

  // If child session (has parent), emit group.updated for the chat UI
  if (params.parentSessionId) {
    const actorResult = await query('SELECT name, role, config FROM actors WHERE id = $1', [params.actorId]);
    const actor = actorResult.rows[0];
    await emitEvent({
      type: 'group.updated',
      workspaceId: params.workspaceId,
      payload: {
        rootSessionId: params.rootSessionId || session.id,
        sessionId: session.id,
        newParticipant: {
          id: params.actorId,
          name: actor?.name,
          role: actor?.role,
          emoji: actor?.config?.avatar_emoji,
        },
      },
      timestamp: nowISO(),
    });
  }

  return session;
}

// ============ Cancel Session ============

export async function cancelSession(sessionId: UUID): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) throw new Error('Session not found');
  if (session.status === 'completed' || session.status === 'cancelled') {
    throw new Error(`Session already ${session.status}`);
  }

  await updateSessionStatus(sessionId, 'cancelled');

  // Also cancel any active child sessions
  const children = await query(
    `SELECT id FROM sessions WHERE parent_session_id = $1 AND status IN ('active', 'waiting')`,
    [sessionId]
  );
  for (const child of children.rows) {
    await cancelSession(child.id);
  }
}

// ============ Actor concurrent session count ============

export async function getActiveSessionCount(actorId: UUID): Promise<number> {
  const result = await query(
    `SELECT COUNT(*) as count FROM sessions WHERE actor_id = $1 AND status IN ('active', 'waiting')`,
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
