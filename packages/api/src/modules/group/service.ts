import { query, transaction } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { sessionThinkingQueue } from '../../workers/queues.js';
import { nowISO } from '@synapse/shared';
import { v4 as uuidv4 } from 'uuid';
import {
  createConversationEvent,
  createConversationItem,
  ensureConversationMember,
  getConversation,
  getConversationMember,
  getLastVisibleConversationItem,
  getVisibleConversationItemsForMember,
  listConversationMembers,
  listUserGroupConversations,
  markConversationRead,
} from '../conversation/service.js';
import {
  buildNormalizedMessageContent,
  itemPartsToCanonicalContentBlocks,
} from '../conversation/message-content.js';
import { createSession, getSession, updateSessionStatus } from '../session/service.js';

function normalizeGroupRow(row: any) {
  if (!row) return null;
  return {
    ...row,
    group_id: row.id,
  };
}

function parseJson(value: unknown) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value || {};
}

function buildTextContentFromParts(parts: any[]) {
  const text = parts
    .filter((part) => part.part_type === 'text')
    .map((part) => part.text_value || '')
    .join('\n');

  if (text) return text;

  const jsonParts = parts
    .filter((part) => part.part_type === 'json')
    .map((part) => JSON.stringify(part.json_value));
  return jsonParts.join('\n');
}

async function getActorNames(actorIds: string[]) {
  if (actorIds.length === 0) return new Map<string, string>();
  const result = await query(
    `SELECT id, name FROM actors WHERE id = ANY($1)`,
    [actorIds],
  );
  return new Map<string, string>(result.rows.map((row: any) => [row.id, row.name]));
}

async function getUserNames(userIds: string[]) {
  if (userIds.length === 0) return new Map<string, string>();
  const result = await query(
    `SELECT id, name FROM users WHERE id = ANY($1)`,
    [userIds],
  );
  return new Map<string, string>(result.rows.map((row: any) => [row.id, row.name]));
}

async function getLatestActorSession(conversationId: string, actorId: string) {
  const result = await query(
    `SELECT *
     FROM sessions
     WHERE conversation_id = $1 AND actor_id = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [conversationId, actorId],
  );
  return result.rows[0] ?? null;
}

async function ensureActorSession(params: {
  conversationId: string;
  workspaceId: string;
  actorId: string;
  trigger: string;
}) {
  const existing = await getLatestActorSession(params.conversationId, params.actorId);
  if (existing) return existing;

  return createSession({
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    conversationId: params.conversationId,
    channelType: 'web',
    trigger: params.trigger,
    metadata: { lane: 'group' },
  });
}

async function recordMembershipEvent(params: {
  conversationId: string;
  subtype: 'member_joined' | 'member_kicked' | 'member_left';
  batchId: string;
  members: Array<{ memberId: string; memberType: 'actor' | 'user'; actorId?: string; userId?: string; name: string; title?: string }>;
}) {
  await createConversationEvent({
    conversationId: params.conversationId,
    eventType: params.subtype,
    timelinePolicy: 'all_members',
    contextPolicy: 'shared',
    metadata: {
      batchId: params.batchId,
    },
    eventPayload: {
      batchId: params.batchId,
      members: params.members.map((member) => ({
        memberId: member.memberId,
        memberType: member.memberType,
        actorId: member.actorId,
        userId: member.userId,
        name: member.name,
        title: member.title,
      })),
    },
  });
}

async function resolveMemberTargets(params: {
  groupId: string;
  targetActorIds?: string[];
  targetUserIds?: string[];
}) {
  const members = await listConversationMembers(params.groupId);
  const actorIds = new Set(params.targetActorIds || []);
  const userIds = new Set(params.targetUserIds || []);
  const targetMemberIds: string[] = [];

  for (const member of members) {
    if (member.state !== 'active') continue;
    if (member.actor_id && actorIds.has(member.actor_id)) {
      targetMemberIds.push(member.id);
    }
    if (member.user_id && userIds.has(member.user_id)) {
      targetMemberIds.push(member.id);
    }
  }

  return targetMemberIds;
}

async function getDefaultTargetActorIds(groupId: string, senderActorId?: string) {
  const members = await listConversationMembers(groupId);
  return members
    .filter((member) => member.state === 'active' && member.actor_id && member.actor_id !== senderActorId)
    .map((member) => member.actor_id);
}

function senderTypeFromItem(item: any): 'user' | 'actor' | 'system' {
  if (item.role === 'system' || item.author_member_type === 'system' || item.item_type === 'event') {
    return 'system';
  }
  if (item.author_member_type === 'actor' || item.role === 'assistant') {
    return 'actor';
  }
  return 'user';
}

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
  const batchId = uuidv4();

  const result = await transaction(async (client) => {
    const actorRows = actorIds.length > 0
      ? (await client.query(
          `SELECT id, name, title FROM actors WHERE id = ANY($1)`,
          [actorIds],
        )).rows
      : [];
    const actorMap = new Map<string, any>(actorRows.map((row: any) => [row.id, row]));
    const fallbackTitle = title?.trim()
      || actorRows.map((row: any) => row.name).filter(Boolean).join(', ')
      || 'Untitled conversation';

    const conversationResult = await client.query(
      `INSERT INTO conversations (id, workspace_id, kind, title, created_by, metadata, created_at, updated_at)
       VALUES ($1, $2, 'group', $3, $4, '{}'::jsonb, NOW(), NOW())
       RETURNING *`,
      [groupId, workspaceId, fallbackTitle, createdBy],
    );
    const group = normalizeGroupRow(conversationResult.rows[0]);

    const userMemberId = uuidv4();
    await client.query(
      `INSERT INTO conversation_members
         (id, conversation_id, member_type, user_id, state, metadata, joined_at)
       VALUES ($1, $2, 'user', $3, 'active', '{}'::jsonb, NOW())`,
      [userMemberId, groupId, createdBy],
    );

    const members: any[] = [];
    const joinedMembers: Array<{
      memberId: string;
      memberType: 'actor' | 'user';
      actorId?: string;
      userId?: string;
      name: string;
      title?: string;
    }> = [{
      memberId: userMemberId,
      memberType: 'user' as const,
      userId: createdBy,
      name: 'User',
    }];

    for (const actorId of actorIds) {
      const sessionId = uuidv4();
      await client.query(
        `INSERT INTO sessions
           (id, workspace_id, actor_id, conversation_id, channel_type, trigger, status, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'web', 'user_message', 'sleeping', '{}'::jsonb, NOW(), NOW())`,
        [sessionId, workspaceId, actorId, groupId],
      );

      const memberId = uuidv4();
      await client.query(
        `INSERT INTO conversation_members
           (id, conversation_id, member_type, actor_id, state, metadata, joined_at)
         VALUES ($1, $2, 'actor', $3, 'active', '{}'::jsonb, NOW())`,
        [memberId, groupId, actorId],
      );
      members.push({ id: memberId, actorId, sessionId });

      const actorInfo = actorMap.get(actorId);
      joinedMembers.push({
        memberId,
        memberType: 'actor',
        actorId,
        name: actorInfo?.name || 'Unknown',
        title: actorInfo?.title,
      });
    }

    let msgId: string | null = null;
    if (initialMessage && targetActorId) {
      const targetMember = members.find((member) => member.actorId === targetActorId);
      const itemId = uuidv4();
      const authorMemberId = userMemberId;

      await client.query(
        `INSERT INTO conversation_items
           (id, conversation_id, scope, surface, item_type, subtype, role, author_member_id, metadata, created_at)
         VALUES ($1, $2, 'shared', 'visible', 'message', 'chat', 'user', $3, '{}'::jsonb, NOW())`,
        [itemId, groupId, authorMemberId],
      );
      await client.query(
        `INSERT INTO conversation_item_parts
           (id, item_id, ordinal, part_type, text_value, metadata)
         VALUES ($1, $2, 0, 'text', $3, '{}'::jsonb)`,
        [uuidv4(), itemId, initialMessage],
      );
      if (targetMember) {
        await client.query(
          `INSERT INTO conversation_item_targets (item_id, target_member_id, target_kind)
           VALUES ($1, $2, 'to')`,
          [itemId, targetMember.id],
        );
      }
      await client.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [groupId]);
      msgId = itemId;
    }

    return { group, members, joinedMembers, message: msgId ? { id: msgId } : null };
  });

  await recordMembershipEvent({
    conversationId: groupId,
    subtype: 'member_joined',
    batchId,
    members: result.joinedMembers,
  });

  if (targetActorId && initialMessage) {
    await wakeActor(groupId, targetActorId);
  }

  await emitEvent({
    type: 'group.updated',
    workspaceId,
    payload: { groupId, action: 'created' },
    timestamp: nowISO(),
  });

  return {
    group: result.group,
    members: result.members,
    message: result.message,
  };
}

export async function getGroup(groupId: string): Promise<any | null> {
  const result = await query(
    `SELECT * FROM conversations WHERE id = $1 AND kind = 'group'`,
    [groupId],
  );
  return normalizeGroupRow(result.rows[0] ?? null);
}

export async function getGroupsByWorkspace(workspaceId: string, userId: string): Promise<any[]> {
  const groups = await listUserGroupConversations(workspaceId, userId);
  if (groups.length === 0) return [];

  const groupIds = groups.map((group: any) => group.id);
  const activeCountsResult = await query(
    `SELECT conversation_id, COUNT(*)::int AS active_count
     FROM sessions
     WHERE conversation_id = ANY($1)
       AND status = 'active'
     GROUP BY conversation_id`,
    [groupIds],
  );
  const activeCountMap = new Map<string, number>(
    activeCountsResult.rows.map((row: any) => [row.conversation_id, row.active_count]),
  );

  const lastItemsResult = await query(
    `SELECT DISTINCT ON (ci.conversation_id)
            ci.conversation_id,
            ci.id,
            ci.role,
            ci.item_type,
            ci.created_at,
            cm.member_type AS author_member_type,
            COALESCE(a.name, u.name, cm.display_name) AS author_name
     FROM conversation_items ci
     LEFT JOIN conversation_members cm ON cm.id = ci.author_member_id
     LEFT JOIN actors a ON a.id = cm.actor_id
     LEFT JOIN users u ON u.id = cm.user_id
     WHERE ci.conversation_id = ANY($1)
       AND ci.scope = 'shared'
       AND ci.surface = 'visible'
     ORDER BY ci.conversation_id, ci.sequence DESC`,
    [groupIds],
  );

  const lastItemMap = new Map<string, any>(lastItemsResult.rows.map((row: any) => [row.conversation_id, row]));
  const itemIds = lastItemsResult.rows.map((row: any) => row.id);
  const lastPartsResult = itemIds.length > 0
    ? await query(
        `SELECT cip.*
         FROM conversation_item_parts cip
         WHERE cip.item_id = ANY($1)
         ORDER BY cip.item_id, cip.ordinal ASC`,
        [itemIds],
      )
    : { rows: [] };
  const partsByItem = new Map<string, any[]>();
  for (const row of lastPartsResult.rows) {
    if (!partsByItem.has(row.item_id)) partsByItem.set(row.item_id, []);
    partsByItem.get(row.item_id)!.push(row);
  }

  return groups.map((group: any) => {
    const lastItem = lastItemMap.get(group.id);
    const lastParts = lastItem ? partsByItem.get(lastItem.id) || [] : [];
    const senderType = lastItem
      ? senderTypeFromItem({
          ...lastItem,
          author_member_type: lastItem.author_member_type,
        })
      : null;

    return {
      ...normalizeGroupRow(group),
      last_message: lastItem ? buildTextContentFromParts(lastParts) : null,
      last_message_sender_type: senderType,
      last_message_sender_name: lastItem?.author_name || 'System',
      last_message_at: lastItem?.created_at || null,
      unread_count: group.unread_count || 0,
      active_count: activeCountMap.get(group.id) || 0,
    };
  });
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

  const existing = await getConversationMember({ conversationId: groupId, actorId });
  if (existing?.state === 'active') {
    throw new Error('Actor already in group');
  }

  const actorResult = await query(
    `SELECT name, title FROM actors WHERE id = $1`,
    [actorId],
  );
  const actorInfo = actorResult.rows[0];
  const member = await ensureConversationMember({
    conversationId: groupId,
    memberType: 'actor',
    actorId,
  });
  const session = await createSession({
    workspaceId: group.workspace_id,
    actorId,
    conversationId: groupId,
    channelType: 'web',
    trigger: 'actor_invite',
    metadata: { lane: 'group' },
  });
  await updateSessionStatus(session.id, 'sleeping');

  const eventBatchId = batchId || uuidv4();
  await recordMembershipEvent({
    conversationId: groupId,
    subtype: 'member_joined',
    batchId: eventBatchId,
    members: [{
      memberId: member.id,
      memberType: 'actor',
      actorId,
      name: actorInfo?.name || 'Unknown',
      title: actorInfo?.title,
    }],
  });

  await emitEvent({
    type: 'group.member_joined',
    workspaceId: group.workspace_id,
    payload: { groupId, actorId, actorName: actorInfo?.name || 'Unknown', batchId: eventBatchId },
    timestamp: nowISO(),
  });

  return {
    member: { id: member.id, groupId, actorId, sessionId: session.id },
    session: { id: session.id },
  };
}

export async function removeActorFromGroup(groupId: string, actorId: string): Promise<void> {
  const group = await getGroup(groupId);
  if (!group) throw new Error('Group not found');

  const member = await getConversationMember({ conversationId: groupId, actorId });
  if (!member) return;

  await query(
    `UPDATE conversation_members
     SET state = 'kicked', left_at = NOW()
     WHERE id = $1`,
    [member.id],
  );
  await query(
    `UPDATE sessions
     SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
     WHERE conversation_id = $1 AND actor_id = $2 AND status IN ('active', 'sleeping')`,
    [groupId, actorId],
  );

  const actorResult = await query('SELECT name, title FROM actors WHERE id = $1', [actorId]);
  const actorInfo = actorResult.rows[0];
  const eventBatchId = uuidv4();
  await recordMembershipEvent({
    conversationId: groupId,
    subtype: 'member_kicked',
    batchId: eventBatchId,
    members: [{
      memberId: member.id,
      memberType: 'actor',
      actorId,
      name: actorInfo?.name || 'Unknown',
      title: actorInfo?.title,
    }],
  });

  await emitEvent({
    type: 'group.member_kicked',
    workspaceId: group.workspace_id,
    payload: { groupId, actorId, actorName: actorInfo?.name || 'Unknown', batchId: eventBatchId },
    timestamp: nowISO(),
  });
}

export async function getGroupMembers(groupId: string): Promise<any[]> {
  const result = await query(
    `SELECT cm.*,
            a.name AS actor_name,
            a.title AS actor_title,
            a.role AS actor_role,
            a.docs AS actor_docs,
            a.can_represent_user AS actor_can_represent_user,
            a.current_version AS actor_current_version,
            u.name AS user_name,
            ls.id AS session_id,
            ls.status AS session_status
     FROM conversation_members cm
     LEFT JOIN actors a ON a.id = cm.actor_id
     LEFT JOIN users u ON u.id = cm.user_id
     LEFT JOIN LATERAL (
       SELECT s.id, s.status
       FROM sessions s
       WHERE s.conversation_id = cm.conversation_id
         AND s.actor_id = cm.actor_id
       ORDER BY s.created_at DESC
       LIMIT 1
     ) ls ON TRUE
     WHERE cm.conversation_id = $1
     ORDER BY cm.joined_at ASC`,
    [groupId],
  );
  return result.rows.map((row: any) => ({
    ...row,
    group_id: groupId,
  }));
}

// ============ Group Messages ============

export async function sendGroupMessage(params: {
  groupId: string;
  senderType: 'user' | 'actor';
  senderUserId?: string;
  senderActorId?: string;
  senderSessionId?: string;
  targetActorIds?: string[];
  targetUserIds?: string[];
  content: string;
  contentBlocks?: import('@synapse/shared').CanonicalContentBlock[];
  metadata?: Record<string, unknown>;
}): Promise<any> {
  const {
    groupId,
    senderType,
    senderUserId,
    senderActorId,
    senderSessionId,
    content,
    contentBlocks,
    metadata = {},
  } = params;
  const group = await getGroup(groupId);
  if (!group) throw new Error('Group not found');

  let targetActorIds = params.targetActorIds || [];
  let targetUserIds = params.targetUserIds || [];
  if (targetActorIds.length === 0 && targetUserIds.length === 0) {
    targetActorIds = await getDefaultTargetActorIds(groupId, senderActorId);
  }

  const authorMember = senderType === 'actor'
    ? await ensureConversationMember({ conversationId: groupId, memberType: 'actor', actorId: senderActorId })
    : await ensureConversationMember({ conversationId: groupId, memberType: 'user', userId: senderUserId });

  const targetMemberIds = await resolveMemberTargets({ groupId, targetActorIds, targetUserIds });
  const normalizedMessage = await buildNormalizedMessageContent({ content, contentBlocks, metadata });

  const item = await createConversationItem({
    conversationId: groupId,
    sessionId: senderSessionId,
    scope: 'shared',
    surface: 'visible',
    itemType: 'message',
    subtype: 'chat',
    role: senderType === 'actor' ? 'assistant' : 'user',
    authorMemberId: authorMember?.id,
    metadata: normalizedMessage.normalizedMetadata,
    parts: normalizedMessage.parts,
    targetMemberIds,
  });

  let senderName: string | undefined;
  if (senderActorId) {
    const actorResult = await query('SELECT name FROM actors WHERE id = $1', [senderActorId]);
    senderName = actorResult.rows[0]?.name;
  } else if (senderUserId) {
    const userResult = await query('SELECT name FROM users WHERE id = $1', [senderUserId]);
    senderName = userResult.rows[0]?.name;
  }

  const actorNames = await getActorNames(targetActorIds);
  const userNames = await getUserNames(targetUserIds);
  const targetActorNames = targetActorIds.map((id) => actorNames.get(id) || 'Unknown');
  const targetUserNames = targetUserIds.map((id) => userNames.get(id) || 'Unknown');

  await emitEvent({
    type: 'session.message.new',
    workspaceId: group.workspace_id,
    payload: {
      groupId,
      messageId: item.id,
      sessionId: senderSessionId || '',
      role: senderType === 'actor' ? 'assistant' : 'user',
      fromActorId: senderActorId,
      fromUserId: senderUserId,
      actorName: senderType === 'actor' ? senderName : undefined,
      targetActorIds,
      targetUserIds,
      targetActorNames,
      targetUserNames,
      content: normalizedMessage.normalizedContent,
      contentBlocks: normalizedMessage.contentBlocks,
      metadata: normalizedMessage.normalizedMetadata,
      createdAt: item.created_at,
    },
    timestamp: nowISO(),
  });

  for (const targetActorId of targetActorIds) {
    await wakeActor(groupId, targetActorId).catch((err) => {
      console.error(`Failed to wake actor ${targetActorId}:`, err.message);
    });
  }

  return {
    id: item.id,
    groupId,
    sessionId: senderSessionId || '',
    role: senderType === 'actor' ? 'assistant' : 'user',
    fromUserId: senderUserId,
    fromActorId: senderActorId,
    actorName: senderType === 'actor' ? senderName : undefined,
    targetActorIds,
    targetUserIds,
    content: normalizedMessage.normalizedContent,
    contentBlocks: normalizedMessage.contentBlocks,
    metadata: normalizedMessage.normalizedMetadata,
    createdAt: item.created_at,
  };
}

export async function getGroupMessages(
  groupId: string,
  viewer: { userId?: string; actorId?: string },
  limit = 100,
  before?: string,
): Promise<any[]> {
  const group = await getGroup(groupId);
  if (!group) return [];

  const viewerMember = viewer.userId
    ? await getConversationMember({ conversationId: groupId, userId: viewer.userId })
    : viewer.actorId
      ? await getConversationMember({ conversationId: groupId, actorId: viewer.actorId })
      : null;
  if (!viewerMember) return [];

  let beforeSequence: number | undefined;
  if (before) {
    const itemResult = await query(
      `SELECT sequence FROM conversation_items WHERE id = $1 AND conversation_id = $2`,
      [before, groupId],
    );
    if (itemResult.rows[0]) {
      beforeSequence = itemResult.rows[0].sequence;
    } else if (!Number.isNaN(Number(before))) {
      beforeSequence = Number(before);
    }
  }

  const items = await getVisibleConversationItemsForMember({
    conversationId: groupId,
    memberId: viewerMember.id,
    beforeSequence,
    limit,
  });

  return items.map((item: any) => {
    const metadata = parseJson(item.metadata);
    const senderType = senderTypeFromItem(item);
    const role = senderType === 'user' ? 'user' : senderType === 'actor' ? 'assistant' : 'system';

    return {
      id: item.id,
      groupId,
      sessionId: item.session_id || '',
      role,
      eventType: item.item_type === 'event' ? item.subtype : undefined,
      eventPayload: item.item_type === 'event' ? parseJson(item.event_payload) : undefined,
      fromUserId: item.author_user_id || null,
      fromActorId: item.author_actor_id || null,
      actorName: role === 'assistant' ? item.author_name || 'System' : undefined,
      targetActorIds: (item.targets || [])
        .filter((target: any) => target.member_type === 'actor' && target.actor_id)
        .map((target: any) => target.actor_id),
      targetUserIds: (item.targets || [])
        .filter((target: any) => target.member_type === 'user' && target.user_id)
        .map((target: any) => target.user_id),
      content: buildTextContentFromParts(item.parts || []),
      contentBlocks: itemPartsToCanonicalContentBlocks(item.parts || []),
      metadata,
      createdAt: item.created_at,
      targetActorNames: (item.targets || [])
        .filter((target: any) => target.member_type === 'actor')
        .map((target: any) => target.member_name || 'Unknown'),
      targetUserNames: (item.targets || [])
        .filter((target: any) => target.member_type === 'user')
        .map((target: any) => target.member_name || 'Unknown'),
    };
  });
}

// ============ Actor Wake / Sleep ============

export async function wakeActor(groupId: string, actorId: string): Promise<void> {
  const group = await getGroup(groupId);
  if (!group) return;

  let session = await ensureActorSession({
    conversationId: groupId,
    workspaceId: group.workspace_id,
    actorId,
    trigger: 'group_message',
  });
  session = await getSession(session.id);
  if (!session) return;

  if (session.status === 'sleeping' || session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled' || session.status === 'timed_out') {
    await query(
      `UPDATE sessions SET status = 'active', error_message = NULL, completed_at = NULL, updated_at = NOW() WHERE id = $1`,
      [session.id],
    );

    await sessionThinkingQueue.add('think', {
      sessionId: session.id,
      actorId,
      workspaceId: group.workspace_id,
      trigger: 'group_message',
    });

    await emitEvent({
      type: 'session.status.changed',
      workspaceId: group.workspace_id,
      payload: { groupId, sessionId: session.id, actorId, status: 'active', previousStatus: session.status },
      timestamp: nowISO(),
    });
  }
}

export async function sleepActor(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session || session.status !== 'active') return;

  await query(
    `UPDATE sessions SET status = 'sleeping', updated_at = NOW() WHERE id = $1`,
    [sessionId],
  );

  await emitEvent({
    type: 'session.status.changed',
    workspaceId: session.workspace_id,
    payload: {
      groupId: session.group_id,
      sessionId,
      actorId: session.actor_id,
      status: 'sleeping',
      previousStatus: 'active',
    },
    timestamp: nowISO(),
  });
}

// ============ Mark Read ============

export async function markGroupRead(userId: string, groupId: string): Promise<void> {
  const lastItem = await getLastVisibleConversationItem(groupId);
  await markConversationRead(userId, groupId, lastItem?.id);
}

// ============ Cancel Group ============

export async function cancelGroup(groupId: string): Promise<void> {
  await query(
    `UPDATE sessions
     SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
     WHERE conversation_id = $1 AND status IN ('active', 'sleeping')`,
    [groupId],
  );

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
