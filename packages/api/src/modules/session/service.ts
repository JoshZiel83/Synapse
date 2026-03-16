import {
  authzEnabled,
  enqueueAuthzRelationships,
  flushAuthzOutboxEntries,
  touchActorConversationContext,
  touchRelation,
} from '../../infrastructure/authz/index.js';
import { query } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { shutdownSessionInstances } from '../mcp-plugins/instance-manager.js';
import {
  createConversation,
  createConversationItem,
  ensureConversationMember,
  getConversationFeedItemById,
  getConversation,
} from '../conversation/service.js';
import {
  buildNormalizedMessageContent,
  itemPartsToCanonicalContentBlocks,
} from '../conversation/message-content.js';
import type { UUID } from '@synapse/shared';
import { nowISO } from '@synapse/shared';
import { v4 as uuidv4 } from 'uuid';

function normalizeSessionRow(row: any) {
  if (!row) return null;
  return {
    ...row,
    group_id: row.conversation_kind === 'group' ? row.conversation_id : null,
  };
}

async function emitChatFeedItem(workspaceId: string, itemId: string) {
  const item = await getConversationFeedItemById(itemId);
  if (!item || item.workspaceSequence === undefined) return;

  await emitEvent({
    type: 'chat.feed.item.created',
    workspaceId,
    payload: {
      workspaceSequence: item.workspaceSequence,
      item,
    },
    timestamp: nowISO(),
  });
}

async function loadSession(sessionId: UUID): Promise<any | null> {
  const result = await query(
    `SELECT s.*,
            a.name AS actor_name,
            c.kind AS conversation_kind,
            c.title AS conversation_title
     FROM sessions s
     JOIN actors a ON a.id = s.actor_id
     JOIN conversations c ON c.id = s.conversation_id
     WHERE s.id = $1`,
    [sessionId],
  );
  return normalizeSessionRow(result.rows[0] ?? null);
}

async function resolveSessionMessageAuthor(params: {
  conversationId: string;
  fromActorId?: UUID;
  fromUserId?: UUID;
}) {
  if (params.fromActorId) {
    return ensureConversationMember({
      conversationId: params.conversationId,
      memberType: 'actor',
      actorId: params.fromActorId,
    });
  }

  if (params.fromUserId) {
    return ensureConversationMember({
      conversationId: params.conversationId,
      memberType: 'user',
      userId: params.fromUserId,
    });
  }

  return null;
}

function getSurfaceForSessionMessage(conversationKind: string, role: string) {
  if (conversationKind === 'group') {
    return { scope: 'private' as const, surface: 'internal' as const };
  }

  if (role === 'tool_result' || role === 'child_result') {
    return { scope: 'private' as const, surface: 'internal' as const };
  }

  return { scope: 'shared' as const, surface: 'visible' as const };
}

function buildContentFromItemParts(item: any) {
  return (item.parts || [])
    .filter((part: any) => part.part_type === 'text')
    .map((part: any) => part.text_value || '')
    .join('\n');
}

function buildMetadataFromItem(item: any) {
  return typeof item.metadata === 'string'
    ? JSON.parse(item.metadata)
    : { ...(item.metadata || {}) };
}

async function flushQueuedAuthzEntries(entryIds: string[], source: string) {
  if (entryIds.length === 0) return;

  try {
    await flushAuthzOutboxEntries(entryIds);
  } catch (error) {
    console.error(`[authz] Failed to flush ${source} relationship updates:`, error);
  }
}

// ============ Session CRUD ============

export async function createSession(params: {
  workspaceId: UUID;
  actorId: UUID;
  groupId?: UUID;
  conversationId?: UUID;
  userId?: UUID;
  channelType?: string;
  trigger?: string;
  metadata?: Record<string, unknown>;
}): Promise<any> {
  const {
    workspaceId,
    actorId,
    groupId,
    conversationId,
    userId,
    channelType = 'web',
    trigger = 'user_message',
    metadata = {},
  } = params;

  const resolvedUserId = userId || (typeof metadata.userId === 'string' ? metadata.userId as UUID : undefined);
  let resolvedConversationId = conversationId || groupId;
  let directConversationCreated = false;
  if (!resolvedConversationId) {
    const conversation = await createConversation({
      workspaceId,
      kind: 'direct',
      metadata: { channelType, trigger },
    });
    resolvedConversationId = conversation.id;
    directConversationCreated = true;
  } else {
    const conversation = await getConversation(resolvedConversationId);
    if (!conversation) {
      throw new Error(`Conversation ${resolvedConversationId} not found`);
    }
  }
  const finalConversationId = resolvedConversationId as string;

  await ensureConversationMember({
    conversationId: finalConversationId,
    memberType: 'actor',
    actorId,
  });

  if (directConversationCreated && resolvedUserId) {
    await ensureConversationMember({
      conversationId: finalConversationId,
      memberType: 'user',
      userId: resolvedUserId,
    });
  }

  const id = uuidv4();
  const result = await query(
    `INSERT INTO sessions (id, workspace_id, actor_id, conversation_id, channel_type, trigger, status, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'idle', $7, NOW(), NOW())
     RETURNING *`,
    [id, workspaceId, actorId, finalConversationId, channelType, trigger, JSON.stringify(metadata)],
  );

  if (directConversationCreated) {
    const authzEntryIds = await enqueueAuthzRelationships(
      [
        touchRelation('conversation', finalConversationId, 'workspace', 'workspace', workspaceId),
        touchRelation('conversation', finalConversationId, 'participant', 'actor', actorId),
        ...touchActorConversationContext(actorId, finalConversationId),
        ...(resolvedUserId
          ? [
              touchRelation('conversation', finalConversationId, 'participant', 'user', resolvedUserId),
              touchRelation('conversation', finalConversationId, 'admin', 'user', resolvedUserId),
            ]
          : []),
      ],
      {
        source: 'session.create_direct_conversation',
        workspaceId,
        conversationId: finalConversationId,
        actorId,
        userId: resolvedUserId,
      },
    );
    await flushQueuedAuthzEntries(authzEntryIds, 'session.create_direct_conversation');
  }

  return loadSession(result.rows[0].id);
}

export async function getSession(sessionId: UUID): Promise<any | null> {
  return loadSession(sessionId);
}

export async function getSessionsByActor(
  workspaceId: UUID,
  actorId: UUID,
  status?: string,
): Promise<any[]> {
  const params: any[] = [workspaceId, actorId];
  let where = 's.workspace_id = $1 AND s.actor_id = $2';
  if (status) {
    params.push(status);
    where += ` AND s.status = $${params.length}`;
  }

  const result = await query(
    `SELECT s.*,
            c.kind AS conversation_kind,
            c.title AS conversation_title
     FROM sessions s
     JOIN conversations c ON c.id = s.conversation_id
     WHERE ${where}
     ORDER BY s.created_at DESC`,
    params,
  );

  return result.rows.map(normalizeSessionRow);
}

export async function updateSessionStatus(
  sessionId: UUID,
  status: string,
  extra?: { errorMessage?: string | null },
): Promise<void> {
  const sets = ['status = $2', 'updated_at = NOW()'];
  const params: any[] = [sessionId, status];
  let idx = 3;

  if (status === 'closed') {
    sets.push('completed_at = NOW()');
  } else {
    sets.push('completed_at = NULL');
  }
  if (extra?.errorMessage !== undefined) {
    sets.push(`error_message = $${idx}`);
    params.push(extra.errorMessage);
    idx++;
  }

  await query(
    `UPDATE sessions SET ${sets.join(', ')} WHERE id = $1`,
    params,
  );
}

// ============ Session Messages ============

export async function addSessionMessage(params: {
  sessionId: UUID;
  workspaceId: UUID;
  role: string;
  content: string;
  contentBlocks?: import('@synapse/shared').CanonicalContentBlock[];
  fromActorId?: UUID;
  fromUserId?: UUID;
  metadata?: Record<string, unknown>;
}): Promise<any> {
  const { sessionId, workspaceId, role, content, contentBlocks, fromActorId, fromUserId, metadata = {} } = params;
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const normalizedMessage = await buildNormalizedMessageContent({ content, contentBlocks, metadata });

  const authorMember = await resolveSessionMessageAuthor({
    conversationId: session.conversation_id,
    fromActorId,
    fromUserId,
  });
  const { scope, surface } = getSurfaceForSessionMessage(session.conversation_kind, role);
  const itemType = role === 'tool_result' ? 'control' : 'message';
  const subtype = role;

  const item = await createConversationItem({
    workspaceId,
    conversationId: session.conversation_id,
    sessionId,
    scope,
    surface,
    itemType,
    subtype,
    role: role === 'tool_result' ? 'tool' : role === 'system' ? 'system' : role === 'assistant' ? 'assistant' : 'user',
    authorMemberId: authorMember?.id,
    metadata: normalizedMessage.normalizedMetadata,
    parts: normalizedMessage.parts,
  });

  if (scope === 'shared' && surface === 'visible' && (role === 'user' || role === 'assistant' || role === 'system')) {
    await emitChatFeedItem(workspaceId, item.id);
  }

  if (!session.group_id && (role === 'user' || role === 'assistant')) {
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
        messageId: item.id,
        role,
        content: normalizedMessage.normalizedContent,
        contentBlocks: normalizedMessage.contentBlocks,
        fromActorId,
        actorName,
        fromUserId,
        metadata: normalizedMessage.normalizedMetadata,
        createdAt: item.created_at,
      },
      timestamp: nowISO(),
    });
  }

  return {
    id: item.id,
    sessionId,
    workspaceId,
    role,
    content: normalizedMessage.normalizedContent,
    contentBlocks: normalizedMessage.contentBlocks,
    fromActorId: fromActorId || null,
    fromUserId: fromUserId || null,
    metadata: normalizedMessage.normalizedMetadata,
    createdAt: item.created_at,
  };
}

export async function getSessionMessages(sessionId: UUID): Promise<any[]> {
  const result = await query(
    `SELECT ci.*,
            s.workspace_id,
            cm.actor_id AS from_actor_id,
            cm.user_id AS from_user_id,
            COALESCE(a.name, u.name, cm.display_name) AS author_name
     FROM conversation_items ci
     JOIN sessions s ON s.id = ci.session_id
     LEFT JOIN conversation_members cm ON cm.id = ci.author_member_id
     LEFT JOIN actors a ON a.id = cm.actor_id
     LEFT JOIN users u ON u.id = cm.user_id
     WHERE ci.session_id = $1
     ORDER BY ci.created_at ASC, ci.sequence ASC`,
    [sessionId],
  );

  if (result.rows.length === 0) return [];

  const itemIds = result.rows.map((row: any) => row.id);
  const partsResult = await query(
    `SELECT cip.*,
            f.original_name,
            f.stored_name,
            f.mime_type AS file_mime_type,
            f.size_bytes
     FROM conversation_item_parts cip
     LEFT JOIN files f ON f.id = cip.file_id
     WHERE cip.item_id = ANY($1)
     ORDER BY cip.item_id, cip.ordinal ASC`,
    [itemIds],
  );

  const partsByItem = new Map<string, any[]>();
  for (const row of partsResult.rows) {
    if (!partsByItem.has(row.item_id)) partsByItem.set(row.item_id, []);
    partsByItem.get(row.item_id)!.push(row);
  }

  return result.rows.map((row: any) => {
    const item = { ...row, parts: partsByItem.get(row.id) || [] };
    return {
      id: row.id,
      sessionId: row.session_id,
      conversationId: row.conversation_id,
      sequence: row.sequence,
      workspaceId: row.workspace_id,
      role: row.subtype || row.role,
      content: buildContentFromItemParts(item),
      contentBlocks: itemPartsToCanonicalContentBlocks(item.parts || []),
      fromActorId: row.from_actor_id || null,
      fromUserId: row.from_user_id || null,
      metadata: buildMetadataFromItem(item),
      createdAt: row.created_at,
    };
  });
}

// ============ Session Interrupts ============

export async function consumeInterrupts(sessionId: UUID): Promise<any[]> {
  const result = await query(
    `UPDATE session_interrupts SET is_consumed = TRUE
     WHERE target_session_id = $1 AND is_consumed = FALSE
     RETURNING *`,
    [sessionId],
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
    [uuidv4(), params.targetSessionId, params.type, params.content, params.fromSessionId || null],
  );
}

// ============ Cancel Session ============

export async function cancelSession(sessionId: UUID): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) throw new Error('Session not found');
  if (session.status === 'closed') {
    throw new Error(`Session already ${session.status}`);
  }

  await updateSessionStatus(sessionId, 'closed');
  await shutdownSessionInstances(sessionId).catch(() => {});
}

// ============ Actor concurrent session count ============

export async function getActiveSessionCount(actorId: UUID): Promise<number> {
  const result = await query(
    `SELECT COUNT(*) as count FROM sessions WHERE actor_id = $1 AND status = 'running'`,
    [actorId],
  );
  return parseInt(result.rows[0].count, 10);
}

export async function getMaxConcurrentSessions(actorId: UUID): Promise<number> {
  const result = await query(
    'SELECT max_concurrent_sessions FROM actors WHERE id = $1',
    [actorId],
  );
  return result.rows[0]?.max_concurrent_sessions ?? 3;
}
