import { query, transaction } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { sessionThinkingQueue } from '../../workers/queues.js';
import { nowISO } from '@synapse/shared';
import { v4 as uuidv4 } from 'uuid';

// ============ Group CRUD ============

export async function createGroup(params: {
  workspaceId: string;
  createdBy: string;
  title?: string;
  actorIds: string[];
  initialMessage?: string;
  targetActorId?: string;
}): Promise<{ group: any; members: any[]; message: any }> {
  const { workspaceId, createdBy, title, actorIds, initialMessage, targetActorId } = params;
  const groupId = uuidv4();
  const batchId = uuidv4(); // Shared batch_id for all initial members

  return transaction(async (client) => {
    // 1. Create group
    const groupResult = await client.query(
      `INSERT INTO groups (id, workspace_id, title, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW()) RETURNING *`,
      [groupId, workspaceId, title || null, createdBy]
    );
    const group = groupResult.rows[0];

    // 2. Add user as member + event
    await client.query(
      `INSERT INTO group_members (id, group_id, user_id, joined_at)
       VALUES ($1, $2, $3, NOW())`,
      [uuidv4(), groupId, createdBy]
    );
    await client.query(
      `INSERT INTO group_member_events (id, group_id, user_id, event_type, batch_id, created_at)
       VALUES ($1, $2, $3, 'joined', $4, NOW())`,
      [uuidv4(), groupId, createdBy, batchId]
    );

    // 3. Create sessions and add actors as members + events
    const members: any[] = [];
    for (const actorId of actorIds) {
      const sessionId = uuidv4();
      await client.query(
        `INSERT INTO sessions (id, workspace_id, actor_id, group_id, channel_type, trigger, status, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'web', 'user_message', 'sleeping', '{}', NOW(), NOW())`,
        [sessionId, workspaceId, actorId, groupId]
      );
      const memberId = uuidv4();
      await client.query(
        `INSERT INTO group_members (id, group_id, actor_id, session_id, joined_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [memberId, groupId, actorId, sessionId]
      );
      await client.query(
        `INSERT INTO group_member_events (id, group_id, actor_id, event_type, batch_id, created_at)
         VALUES ($1, $2, $3, 'joined', $4, NOW())`,
        [uuidv4(), groupId, actorId, batchId]
      );
      members.push({ id: memberId, actorId, sessionId });
    }

    // 4. Write initial group message if provided
    let msgId: string | null = null;
    if (initialMessage && targetActorId) {
      msgId = uuidv4();
      await client.query(
        `INSERT INTO group_messages (id, group_id, sender_type, sender_user_id, target_actor_ids, target_user_ids, content, metadata, created_at)
         VALUES ($1, $2, 'user', $3, $4, '{}', $5, '{}', NOW())`,
        [msgId, groupId, createdBy, [targetActorId], initialMessage]
      );

      // 5. Also write to session_messages for the target actor's session (so AI sees it)
      const targetMember = members.find(m => m.actorId === targetActorId);
      if (targetMember) {
        await client.query(
          `INSERT INTO session_messages (id, session_id, workspace_id, role, content, from_user_id, metadata, created_at)
           VALUES ($1, $2, $3, 'user', $4, $5, '{}', NOW())`,
          [uuidv4(), targetMember.sessionId, workspaceId, initialMessage, createdBy]
        );
      }
    }

    return { group, members, message: msgId ? { id: msgId } : null };
  }).then(async (result) => {
    // Wake the target actor (outside transaction) — only if an initial message was sent
    if (targetActorId && initialMessage) {
      const targetMember = result.members.find((m: any) => m.actorId === targetActorId);
      if (targetMember) {
        await wakeActor(groupId, targetActorId);
      }
    }

    // Emit event
    await emitEvent({
      type: 'group.updated',
      workspaceId: params.workspaceId,
      payload: { groupId, action: 'created' },
      timestamp: nowISO(),
    });

    return result;
  });
}

export async function getGroup(groupId: string): Promise<any | null> {
  const result = await query('SELECT * FROM groups WHERE id = $1', [groupId]);
  return result.rows[0] ?? null;
}

export async function getGroupsByWorkspace(workspaceId: string, userId: string): Promise<any[]> {
  const result = await query(
    `SELECT g.*,
       (SELECT content FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) as last_message,
       (SELECT sender_type FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) as last_message_sender_type,
       (SELECT COALESCE(a2.name, u2.name, 'System')
        FROM group_messages gm2
        LEFT JOIN actors a2 ON a2.id = gm2.sender_actor_id
        LEFT JOIN users u2 ON u2.id = gm2.sender_user_id
        WHERE gm2.group_id = g.id ORDER BY gm2.created_at DESC LIMIT 1) as last_message_sender_name,
       (SELECT created_at FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) as last_message_at,
       (SELECT COUNT(*) FROM group_messages WHERE group_id = g.id
        AND (sender_user_id = $2 OR $2 = ANY(target_user_ids))
        AND created_at > COALESCE(
          (SELECT last_read_at FROM user_group_reads WHERE user_id = $2 AND group_id = g.id),
          '1970-01-01'
        ))::int as unread_count,
       (SELECT COUNT(*) FROM group_members gm
        JOIN sessions s ON s.id = gm.session_id
        WHERE gm.group_id = g.id AND s.status = 'active')::int as active_count
     FROM groups g
     JOIN group_members gm ON gm.group_id = g.id
     WHERE g.workspace_id = $1 AND gm.user_id = $2
     ORDER BY COALESCE(
       (SELECT created_at FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1),
       g.created_at
     ) DESC`,
    [workspaceId, userId]
  );
  return result.rows;
}

// ============ Member Management ============

export async function addActorToGroup(
  groupId: string,
  actorId: string,
  _inviterActorName?: string,
  batchId?: string,
): Promise<{ member: any; session: any }> {
  const group = await getGroup(groupId);
  if (!group) throw new Error('Group not found');

  // Check if already a member
  const existing = await query(
    'SELECT id FROM group_members WHERE group_id = $1 AND actor_id = $2',
    [groupId, actorId]
  );
  if (existing.rows.length > 0) throw new Error('Actor already in group');

  const sessionId = uuidv4();
  const memberId = uuidv4();
  const eventBatchId = batchId || uuidv4();

  // Create session for the actor
  await query(
    `INSERT INTO sessions (id, workspace_id, actor_id, group_id, channel_type, trigger, status, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'web', 'actor_invite', 'sleeping', '{}', NOW(), NOW())`,
    [sessionId, group.workspace_id, actorId, groupId]
  );

  // Add as member
  await query(
    `INSERT INTO group_members (id, group_id, actor_id, session_id, joined_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [memberId, groupId, actorId, sessionId]
  );

  // Record member event
  await query(
    `INSERT INTO group_member_events (id, group_id, actor_id, event_type, batch_id, created_at)
     VALUES ($1, $2, $3, 'joined', $4, NOW())`,
    [uuidv4(), groupId, actorId, eventBatchId]
  );

  // Emit event for real-time frontend
  const actorResult = await query('SELECT name FROM actors WHERE id = $1', [actorId]);
  const actorName = actorResult.rows[0]?.name || 'Unknown';

  await emitEvent({
    type: 'group.member_joined',
    workspaceId: group.workspace_id,
    payload: { groupId, actorId, actorName, batchId: eventBatchId },
    timestamp: nowISO(),
  });

  return {
    member: { id: memberId, groupId, actorId, sessionId },
    session: { id: sessionId },
  };
}

export async function removeActorFromGroup(groupId: string, actorId: string): Promise<void> {
  const group = await getGroup(groupId);
  if (!group) throw new Error('Group not found');

  // Cancel the actor's session
  await query(
    `UPDATE sessions SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
     WHERE group_id = $1 AND actor_id = $2 AND status IN ('active', 'sleeping')`,
    [groupId, actorId]
  );

  // Remove from group_members
  await query(
    'DELETE FROM group_members WHERE group_id = $1 AND actor_id = $2',
    [groupId, actorId]
  );

  // Record kicked event
  const eventBatchId = uuidv4();
  await query(
    `INSERT INTO group_member_events (id, group_id, actor_id, event_type, batch_id, created_at)
     VALUES ($1, $2, $3, 'kicked', $4, NOW())`,
    [uuidv4(), groupId, actorId, eventBatchId]
  );

  // Emit event
  const actorResult = await query('SELECT name FROM actors WHERE id = $1', [actorId]);
  const actorName = actorResult.rows[0]?.name || 'Unknown';

  await emitEvent({
    type: 'group.member_kicked',
    workspaceId: group.workspace_id,
    payload: { groupId, actorId, actorName, batchId: eventBatchId },
    timestamp: nowISO(),
  });
}

export async function getGroupMembers(groupId: string): Promise<any[]> {
  const result = await query(
    `SELECT gm.*,
       a.name as actor_name, a.title as actor_title, a.role as actor_role,
       u.name as user_name,
       s.status as session_status
     FROM group_members gm
     LEFT JOIN actors a ON a.id = gm.actor_id
     LEFT JOIN users u ON u.id = gm.user_id
     LEFT JOIN sessions s ON s.id = gm.session_id
     WHERE gm.group_id = $1
     ORDER BY gm.joined_at ASC`,
    [groupId]
  );
  return result.rows;
}

// ============ Group Messages ============

export async function sendGroupMessage(params: {
  groupId: string;
  senderType: 'user' | 'actor';
  senderUserId?: string;
  senderActorId?: string;
  senderSessionId?: string;
  targetActorIds: string[];
  targetUserIds?: string[];
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<any> {
  const { groupId, senderType, senderUserId, senderActorId, senderSessionId, targetActorIds, targetUserIds = [], content, metadata = {} } = params;
  const msgId = uuidv4();

  await query(
    `INSERT INTO group_messages (id, group_id, sender_type, sender_user_id, sender_actor_id, sender_session_id, target_actor_ids, target_user_ids, content, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
    [msgId, groupId, senderType, senderUserId || null, senderActorId || null, senderSessionId || null, targetActorIds, targetUserIds, content, JSON.stringify(metadata)]
  );

  // Get sender name for event
  let senderName: string | undefined;
  if (senderActorId) {
    const r = await query('SELECT name FROM actors WHERE id = $1', [senderActorId]);
    senderName = r.rows[0]?.name;
  } else if (senderUserId) {
    const r = await query('SELECT name FROM users WHERE id = $1', [senderUserId]);
    senderName = r.rows[0]?.name;
  }

  // Get group workspace
  const group = await getGroup(groupId);

  // Resolve target names for the event
  let targetActorNames: string[] = [];
  if (targetActorIds.length > 0) {
    const namesResult = await query('SELECT name FROM actors WHERE id = ANY($1)', [targetActorIds]);
    targetActorNames = namesResult.rows.map((r: any) => r.name);
  }
  let targetUserNames: string[] = [];
  if (targetUserIds.length > 0) {
    const namesResult = await query('SELECT name FROM users WHERE id = ANY($1)', [targetUserIds]);
    targetUserNames = namesResult.rows.map((r: any) => r.name);
  }

  // Emit event for WebSocket
  if (group) {
    await emitEvent({
      type: 'session.message.new',
      workspaceId: group.workspace_id,
      payload: {
        groupId,
        messageId: msgId,
        senderType,
        senderActorId,
        senderUserId,
        senderName,
        targetActorIds,
        targetUserIds,
        targetActorNames,
        targetUserNames,
        content,
        metadata,
      },
      timestamp: nowISO(),
    });
  }

  // Wake target actors
  for (const targetActorId of targetActorIds) {
    await wakeActor(groupId, targetActorId).catch((err) => {
      console.error(`Failed to wake actor ${targetActorId}:`, err.message);
    });
  }

  return { id: msgId, groupId, senderType, content, targetActorIds, targetUserIds };
}

/**
 * Get group messages with visibility filtering and derived system events.
 * For users: sees messages sent by them or targeting them + system events.
 * For actors: sees messages sent by them or targeting them + system events.
 */
export async function getGroupMessages(
  groupId: string,
  viewer: { userId?: string; actorId?: string },
  limit = 100,
  before?: string
): Promise<any[]> {
  // 1. Get the viewer's join time for filtering system events
  let viewerJoinTime: Date;
  if (viewer.userId) {
    const joinResult = await query(
      'SELECT joined_at FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, viewer.userId]
    );
    viewerJoinTime = joinResult.rows[0]?.joined_at || new Date(0);
  } else if (viewer.actorId) {
    const joinResult = await query(
      'SELECT joined_at FROM group_members WHERE group_id = $1 AND actor_id = $2',
      [groupId, viewer.actorId]
    );
    viewerJoinTime = joinResult.rows[0]?.joined_at || new Date(0);
  } else {
    viewerJoinTime = new Date(0);
  }

  // 2. Get chat messages (visibility filtered)
  let chatWhereClause: string;
  const chatParams: any[] = [groupId];

  if (viewer.userId) {
    chatWhereClause = `gm.group_id = $1 AND (gm.sender_user_id = $2 OR $2 = ANY(gm.target_user_ids))`;
    chatParams.push(viewer.userId);
  } else if (viewer.actorId) {
    chatWhereClause = `gm.group_id = $1 AND (gm.sender_actor_id = $2 OR $2 = ANY(gm.target_actor_ids))`;
    chatParams.push(viewer.actorId);
  } else {
    chatWhereClause = `gm.group_id = $1`;
  }

  if (before) {
    chatParams.push(before);
    chatWhereClause += ` AND gm.created_at < $${chatParams.length}`;
  }

  chatParams.push(limit);
  const chatMsgs = await query(
    `SELECT gm.*,
       COALESCE(a.name, u.name) as sender_name,
       (SELECT ARRAY_AGG(ta.name) FROM unnest(gm.target_actor_ids) tid JOIN actors ta ON ta.id = tid) as target_actor_names,
       (SELECT ARRAY_AGG(tu.name) FROM unnest(gm.target_user_ids) tuid JOIN users tu ON tu.id = tuid) as target_user_names
     FROM group_messages gm
     LEFT JOIN actors a ON a.id = gm.sender_actor_id
     LEFT JOIN users u ON u.id = gm.sender_user_id
     WHERE ${chatWhereClause}
     ORDER BY gm.created_at ASC
     LIMIT $${chatParams.length}`,
    chatParams
  );

  // 3. Get member events (after viewer joined)
  const memberEvents = await query(
    `SELECT gme.*,
       COALESCE(av.name, a_direct.name, u.name) as member_name,
       COALESCE(av.title, a_direct.title) as member_title,
       COALESCE(av.charter, a_direct.charter) as member_charter
     FROM group_member_events gme
     LEFT JOIN LATERAL (
       SELECT * FROM actor_versions av2
       WHERE av2.actor_id = gme.actor_id AND av2.created_at <= gme.created_at
       ORDER BY av2.version DESC LIMIT 1
     ) av ON true
     LEFT JOIN actors a_direct ON a_direct.id = gme.actor_id
     LEFT JOIN users u ON u.id = gme.user_id
     WHERE gme.group_id = $1 AND gme.created_at > $2
     ORDER BY gme.created_at`,
    [groupId, viewerJoinTime.toISOString()]
  );

  // 4. Get actor version changes (after viewer joined)
  const versionChanges = await query(
    `SELECT av.*, a.name as current_name
     FROM actor_versions av
     JOIN actors a ON a.id = av.actor_id
     WHERE av.actor_id IN (
       SELECT DISTINCT actor_id FROM group_member_events WHERE group_id = $1 AND actor_id IS NOT NULL
     )
     AND av.created_at > $2
     AND av.version > 1
     ORDER BY av.created_at`,
    [groupId, viewerJoinTime.toISOString()]
  );

  // 5. Merge and sort all events by timestamp
  const allEvents: any[] = [];

  // Chat messages
  for (const msg of chatMsgs.rows) {
    allEvents.push({
      ...msg,
      _eventType: 'chat',
      _sortTime: new Date(msg.created_at),
    });
  }

  // Member events — group by batch_id
  const batchGroups = new Map<string, any[]>();
  for (const evt of memberEvents.rows) {
    const bid = evt.batch_id || evt.id;
    if (!batchGroups.has(bid)) batchGroups.set(bid, []);
    batchGroups.get(bid)!.push(evt);
  }

  for (const [batchId, events] of batchGroups) {
    const eventType = events[0].event_type;
    const names = events.map((e: any) => e.member_name || 'Unknown').join(', ');
    let content: string;
    if (eventType === 'joined') {
      content = `${names} joined the group`;
      const firstWithCharter = events.find((e: any) => e.member_title);
      if (firstWithCharter && events.length === 1) {
        content += ` (${firstWithCharter.member_title})`;
      }
    } else if (eventType === 'kicked') {
      content = `${names} was removed from the group`;
    } else {
      content = `${names} left the group`;
    }

    allEvents.push({
      id: `system-member-${batchId}`,
      group_id: groupId,
      sender_type: 'system',
      content,
      created_at: events[0].created_at,
      _eventType: 'system',
      _sortTime: new Date(events[0].created_at),
    });
  }

  // Actor version changes
  for (const vc of versionChanges.rows) {
    const changes: string[] = [];
    if (vc.title) changes.push(`title: ${vc.title}`);
    if (vc.charter) {
      const brief = vc.charter.split('\n')[0].substring(0, 120);
      changes.push(`charter: ${brief}`);
    }
    allEvents.push({
      id: `system-version-${vc.id}`,
      group_id: groupId,
      sender_type: 'system',
      content: `${vc.current_name || vc.name}'s profile was updated${changes.length > 0 ? ': ' + changes.join(', ') : ''}`,
      created_at: vc.created_at,
      _eventType: 'system',
      _sortTime: new Date(vc.created_at),
    });
  }

  // Sort by time
  allEvents.sort((a, b) => a._sortTime.getTime() - b._sortTime.getTime());

  // Clean up internal fields
  return allEvents.map(({ _eventType, _sortTime, ...rest }) => rest);
}

// ============ Actor Wake / Sleep ============

export async function wakeActor(groupId: string, actorId: string): Promise<void> {
  // Find the actor's session in this group
  const memberResult = await query(
    `SELECT gm.session_id, s.status, s.workspace_id, s.actor_id
     FROM group_members gm
     JOIN sessions s ON s.id = gm.session_id
     WHERE gm.group_id = $1 AND gm.actor_id = $2`,
    [groupId, actorId]
  );

  if (memberResult.rows.length === 0) return;

  const { session_id, status, workspace_id } = memberResult.rows[0];

  if (status === 'sleeping') {
    // Wake: sleeping → active
    await query(
      `UPDATE sessions SET status = 'active', updated_at = NOW() WHERE id = $1`,
      [session_id]
    );

    // Enqueue thinking job
    await sessionThinkingQueue.add('think', {
      sessionId: session_id,
      actorId,
      workspaceId: workspace_id,
      trigger: 'group_message',
    });

    // Emit status change
    await emitEvent({
      type: 'session.status.changed',
      workspaceId: workspace_id,
      payload: { groupId, sessionId: session_id, actorId, status: 'active', previousStatus: 'sleeping' },
      timestamp: nowISO(),
    });
  }
  // If already active, the inter-round message check will pick up new messages
}

export async function sleepActor(sessionId: string): Promise<void> {
  const session = await query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
  if (session.rows.length === 0) return;

  const s = session.rows[0];
  if (s.status !== 'active') return;

  await query(
    `UPDATE sessions SET status = 'sleeping', updated_at = NOW() WHERE id = $1`,
    [sessionId]
  );

  await emitEvent({
    type: 'session.status.changed',
    workspaceId: s.workspace_id,
    payload: {
      groupId: s.group_id,
      sessionId,
      actorId: s.actor_id,
      status: 'sleeping',
      previousStatus: 'active',
    },
    timestamp: nowISO(),
  });
}

// ============ Mark Read ============

export async function markGroupRead(userId: string, groupId: string): Promise<void> {
  await query(
    `INSERT INTO user_group_reads (user_id, group_id, last_read_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, group_id) DO UPDATE SET last_read_at = NOW()`,
    [userId, groupId]
  );
}

// ============ Cancel Group ============

export async function cancelGroup(groupId: string): Promise<void> {
  // Cancel all active/sleeping sessions in this group
  const sessions = await query(
    `SELECT id FROM sessions WHERE group_id = $1 AND status IN ('active', 'sleeping')`,
    [groupId]
  );

  for (const s of sessions.rows) {
    await query(
      `UPDATE sessions SET status = 'cancelled', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [s.id]
    );
  }

  const group = await getGroup(groupId);
  if (group) {
    await emitEvent({
      type: 'group.updated',
      workspaceId: group.workspace_id,
      payload: { groupId, action: 'cancelled' },
      timestamp: nowISO(),
    });
  }
}
