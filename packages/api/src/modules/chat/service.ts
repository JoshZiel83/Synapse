import { query } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { redis } from '../../infrastructure/redis/index.js';
import {
  createSessionAndEnqueue,
  getSession,
  addSessionMessage,
  updateSessionStatus,
  cancelSession,
} from '../session/service.js';
import { sessionThinkingQueue } from '../../workers/queues.js';
import type { UUID } from '@synapse/shared';
import { nowISO } from '@synapse/shared';

/**
 * List groups (root session trees) for a workspace, with last message, unread count, participants.
 */
export async function listGroups(workspaceId: UUID, userId: UUID) {
  const result = await query(
    `WITH root_sessions AS (
      SELECT s.id, s.actor_id, s.status, s.created_at
      FROM sessions s
      WHERE s.workspace_id = $1
        AND s.root_session_id = s.id
      ORDER BY s.created_at DESC
      LIMIT 50
    ),
    last_msgs AS (
      SELECT DISTINCT ON (s.root_session_id)
        s.root_session_id,
        sm.content,
        sm.role,
        sm.created_at,
        sm.from_actor_id,
        a.name as actor_name
      FROM session_messages sm
      JOIN sessions s ON s.id = sm.session_id
      LEFT JOIN actors a ON a.id = sm.from_actor_id
      WHERE s.root_session_id IN (SELECT id FROM root_sessions)
      ORDER BY s.root_session_id, sm.created_at DESC
    ),
    unread_counts AS (
      SELECT s.root_session_id,
        COUNT(sm.id)::int as unread_count
      FROM session_messages sm
      JOIN sessions s ON s.id = sm.session_id
      LEFT JOIN user_session_reads usr ON usr.root_session_id = s.root_session_id AND usr.user_id = $2
      WHERE s.root_session_id IN (SELECT id FROM root_sessions)
        AND sm.role != 'user'
        AND sm.role != 'system'
        AND sm.role != 'tool_result'
        AND (usr.last_read_at IS NULL OR sm.created_at > usr.last_read_at)
      GROUP BY s.root_session_id
    ),
    participants AS (
      SELECT s.root_session_id,
        json_agg(DISTINCT jsonb_build_object(
          'id', a.id,
          'name', a.name,
          'role', a.role,
          'emoji', a.config->>'avatar_emoji'
        )) as actors
      FROM sessions s
      JOIN actors a ON a.id = s.actor_id
      WHERE s.root_session_id IN (SELECT id FROM root_sessions)
      GROUP BY s.root_session_id
    ),
    agg_status AS (
      SELECT s.root_session_id,
        CASE
          WHEN bool_or(s.status IN ('active', 'waiting')) THEN 'active'
          WHEN bool_or(s.status = 'failed') THEN 'failed'
          ELSE 'completed'
        END as status
      FROM sessions s
      WHERE s.root_session_id IN (SELECT id FROM root_sessions)
      GROUP BY s.root_session_id
    ),
    first_user_msg AS (
      SELECT DISTINCT ON (s.root_session_id)
        s.root_session_id,
        sm.content as title
      FROM session_messages sm
      JOIN sessions s ON s.id = sm.session_id
      WHERE s.root_session_id IN (SELECT id FROM root_sessions)
        AND sm.role = 'user'
      ORDER BY s.root_session_id, sm.created_at ASC
    )
    SELECT
      rs.id,
      rs.created_at,
      COALESCE(ast.status, rs.status) as status,
      p.actors as participants,
      json_build_object(
        'content', lm.content,
        'role', lm.role,
        'actorName', lm.actor_name,
        'createdAt', lm.created_at
      ) as last_message,
      COALESCE(uc.unread_count, 0) as unread_count,
      LEFT(fum.title, 100) as title
    FROM root_sessions rs
    LEFT JOIN last_msgs lm ON lm.root_session_id = rs.id
    LEFT JOIN unread_counts uc ON uc.root_session_id = rs.id
    LEFT JOIN participants p ON p.root_session_id = rs.id
    LEFT JOIN agg_status ast ON ast.root_session_id = rs.id
    LEFT JOIN first_user_msg fum ON fum.root_session_id = rs.id
    ORDER BY COALESCE(lm.created_at, rs.created_at) DESC`,
    [workspaceId, userId]
  );

  const groups = result.rows.map((row: any) => ({
    id: row.id,
    status: row.status,
    participants: row.participants || [],
    lastMessage: row.last_message?.content ? row.last_message : undefined,
    unreadCount: row.unread_count,
    createdAt: row.created_at,
    title: row.title,
  }));

  // Recover thinking states from Redis for active groups
  const activeGroupIds = groups.filter((g: any) => g.status === 'active').map((g: any) => g.id);
  const thinkingMap: Record<string, any> = {};
  if (activeGroupIds.length > 0) {
    const keys = activeGroupIds.map((id: string) => `thinking:${id}`);
    const values = await redis.mget(...keys);
    for (let i = 0; i < activeGroupIds.length; i++) {
      if (values[i]) {
        try {
          thinkingMap[activeGroupIds[i]] = JSON.parse(values[i]!);
        } catch { /* ignore parse errors */ }
      }
    }
  }

  return { groups, thinkingMap };
}

/**
 * Get messages for a group (root session tree).
 */
export async function getGroupMessages(
  rootSessionId: UUID,
  limit = 50,
  before?: string
) {
  let whereClause = `WHERE s.root_session_id = $1 AND sm.role IN ('user', 'assistant')`;
  const params: any[] = [rootSessionId];

  if (before) {
    whereClause += ` AND sm.created_at < $${params.length + 1}`;
    params.push(before);
  }

  params.push(limit);

  const result = await query(
    `SELECT sm.id, sm.session_id, sm.role, sm.content, sm.from_actor_id, sm.from_user_id,
       sm.created_at, sm.metadata,
       a.name as actor_name, a.role as actor_role, a.config->>'avatar_emoji' as actor_emoji
     FROM session_messages sm
     JOIN sessions s ON s.id = sm.session_id
     LEFT JOIN actors a ON a.id = sm.from_actor_id
     ${whereClause}
     ORDER BY sm.created_at ASC
     LIMIT $${params.length}`,
    params
  );

  return result.rows.map((row: any) => ({
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    fromActorId: row.from_actor_id,
    fromUserId: row.from_user_id,
    actorName: row.actor_name,
    actorRole: row.actor_role,
    actorEmoji: row.actor_emoji,
    createdAt: row.created_at,
    metadata: row.metadata,
  }));
}

/**
 * Send a message to a group (root session tree).
 * Finds the root session's actor, looks for an active/waiting session, or creates a new one.
 */
export async function sendMessageToGroup(
  workspaceId: UUID,
  rootSessionId: UUID,
  userId: UUID,
  content: string,
  attachments?: { id: string; url: string; fullUrl?: string; storedName?: string; originalName: string; mimeType: string; sizeBytes: number }[],
) {
  const rootSession = await getSession(rootSessionId);
  if (!rootSession) throw new Error('Group not found');
  if (rootSession.workspace_id !== workspaceId) throw new Error('Group not in workspace');

  const actorId = rootSession.actor_id;

  // Look for existing active/waiting session for the root actor in this tree
  const existingResult = await query(
    `SELECT id, status, work_item_id FROM sessions
     WHERE root_session_id = $1 AND actor_id = $2 AND status IN ('active', 'waiting')
     ORDER BY created_at DESC LIMIT 1`,
    [rootSessionId, actorId]
  );

  let targetSessionId: string;

  if (existingResult.rows.length > 0) {
    const existing = existingResult.rows[0];
    targetSessionId = existing.id;

    // Add user message
    const msgMetadata: Record<string, unknown> = {};
    if (attachments && attachments.length > 0) {
      msgMetadata.attachments = attachments;
    }

    await addSessionMessage({
      sessionId: targetSessionId,
      workspaceId,
      role: 'user',
      content,
      fromUserId: userId,
      metadata: Object.keys(msgMetadata).length > 0 ? msgMetadata : undefined,
    });

    // Re-enqueue thinking if waiting
    if (existing.status === 'waiting') {
      await updateSessionStatus(targetSessionId, 'active');
    }

    await sessionThinkingQueue.add('think', {
      sessionId: targetSessionId,
      actorId,
      workspaceId,
      workItemId: existing.work_item_id,
      trigger: 'user_message',
      userId,
    });
  } else {
    // All sessions completed — re-activate the root session with new user message
    targetSessionId = rootSessionId;

    const reactivateMetadata: Record<string, unknown> = {};
    if (attachments && attachments.length > 0) {
      reactivateMetadata.attachments = attachments;
    }

    await addSessionMessage({
      sessionId: rootSessionId,
      workspaceId,
      role: 'user',
      content,
      fromUserId: userId,
      metadata: Object.keys(reactivateMetadata).length > 0 ? reactivateMetadata : undefined,
    });

    await updateSessionStatus(rootSessionId, 'active');

    await sessionThinkingQueue.add('think', {
      sessionId: rootSessionId,
      actorId,
      workspaceId,
      workItemId: rootSession.work_item_id,
      trigger: 'user_message',
      userId,
    });
  }

  return { sessionId: targetSessionId };
}

/**
 * Mark a group as read for a user.
 */
export async function markGroupAsRead(userId: UUID, rootSessionId: UUID) {
  await query(
    `INSERT INTO user_session_reads (user_id, root_session_id, last_read_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, root_session_id)
     DO UPDATE SET last_read_at = NOW()`,
    [userId, rootSessionId]
  );
}

/**
 * Create a new group by starting a session with an actor.
 */
export async function createGroup(
  workspaceId: UUID,
  actorId: UUID,
  userId: UUID,
  content: string
) {
  const session = await createSessionAndEnqueue({
    workspaceId,
    actorId,
    channelType: 'web',
    trigger: 'user_message',
    initialMessage: content,
    userId,
  });

  return {
    id: session.id,
    sessionId: session.id,
    status: 'active',
  };
}

/**
 * Cancel a group (root session and all its children).
 */
export async function cancelGroup(rootSessionId: UUID, workspaceId: UUID) {
  const session = await getSession(rootSessionId);
  if (!session) throw new Error('Group not found');
  if (session.workspace_id !== workspaceId) throw new Error('Group not in workspace');

  await cancelSession(rootSessionId);
}
