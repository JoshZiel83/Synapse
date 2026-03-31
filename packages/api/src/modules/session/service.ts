import {
  authzEnabled,
  buildWorkspaceUserContextId,
  enqueueAuthzRelationships,
  flushAuthzOutboxEntries,
  touchActorConversationContext,
  touchRelation,
} from '../../infrastructure/authz/index.js';
import { query } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import {
  db,
  type TableInsert,
} from '../../infrastructure/database/kysely.js';
import { shutdownSessionInstances } from '../mcp-plugins/instance-manager.js';
import { queueConversationTransportProjection } from '../im/service.js';
import {
  createConversation,
  createConversationItem,
  ensureConversationMember,
  getConversation,
} from '../conversation/service.js';
import { getWorkspaceMemberIdentity } from '../conversation/workspace-identity.js';
import {
  buildNormalizedMessageContent,
  itemPartsToCanonicalContentBlocks,
} from '../conversation/message-content.js';
import type { UUID } from '@synapse/shared';
import {
  type SessionInterruptType,
  type SessionStatus,
  type SessionTrigger,
  isGroupConversationKind,
  isThreadConversationKind,
  nowISO,
} from '@synapse/shared';
import { sql } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import type { SessionsChannelType } from '../../infrastructure/database/generated/db.js';

function normalizeSessionRow(row: any) {
  if (!row) return null;
  return {
    ...row,
    conversationId: row.conversation_id,
    conversationKind: row.conversation_kind,
    conversationTitle: row.conversation_title,
    isGroupConversation: isGroupConversationKind(row.conversation_kind),
    hasThreadContext: isThreadConversationKind(row.conversation_kind),
  };
}

async function getActorJoinVersionId(actorId: UUID) {
  const row = await db
    .selectFrom('actors as a')
    .innerJoin('actor_versions as current_version', (join) =>
      join
        .onRef('current_version.actor_id', '=', 'a.id')
        .onRef('current_version.version', '=', 'a.current_version'),
    )
    .select('current_version.id as actor_version_id')
    .where('a.id', '=', actorId)
    .limit(1)
    .executeTakeFirst();
  return row?.actor_version_id || undefined;
}

async function loadSession(sessionId: UUID): Promise<any | null> {
  const row = await db
    .selectFrom('sessions as s')
    .innerJoin('actors as a', 'a.id', 's.actor_id')
    .innerJoin('conversations as c', 'c.id', 's.conversation_id')
    .selectAll('s')
    .select([
      'a.name as actor_name',
      'c.kind as conversation_kind',
      'c.title as conversation_title',
    ])
    .where('s.id', '=', sessionId)
    .executeTakeFirst();
  return normalizeSessionRow(row ?? null);
}

async function resolveSessionMessageAuthor(params: {
  conversationId: string;
  workspaceId?: UUID;
  workspaceMemberId?: UUID;
  fromActorId?: UUID;
  fromUserId?: UUID;
}) {
  if (params.fromActorId) {
    const actorJoinVersionId = await getActorJoinVersionId(params.fromActorId);
    return ensureConversationMember({
      conversationId: params.conversationId,
      memberType: 'actor',
      actorId: params.fromActorId,
      actorJoinVersionId,
    });
  }

  if (params.fromUserId) {
    return ensureConversationMember({
      conversationId: params.conversationId,
      memberType: 'user',
      workspaceId: params.workspaceId,
      workspaceMemberId: params.workspaceMemberId,
      userId: params.fromUserId,
    });
  }

  return null;
}

function getSurfaceForSessionMessage(conversationKind: string, role: string) {
  if (isGroupConversationKind(conversationKind)) {
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
  conversationId?: UUID;
  userId?: UUID;
  channelType?: SessionsChannelType;
  trigger?: SessionTrigger;
  metadata?: Record<string, unknown>;
}): Promise<any> {
  const {
    workspaceId,
    actorId,
    conversationId,
    userId,
    channelType = 'web',
    trigger = 'user_message',
    metadata = {},
  } = params;

  const resolvedUserId = userId || (typeof metadata.userId === 'string' ? metadata.userId as UUID : undefined);
  let resolvedConversationId = conversationId;
  let privateConversationCreated = false;
  if (!resolvedConversationId) {
    const conversation = await createConversation({
      kind: 'private',
      metadata: { channelType, trigger },
    });
    resolvedConversationId = conversation.id;
    privateConversationCreated = true;
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
    actorJoinVersionId: await getActorJoinVersionId(actorId),
  });

  if (privateConversationCreated && resolvedUserId) {
    const workspaceMember = await getWorkspaceMemberIdentity(workspaceId, resolvedUserId);
    if (!workspaceMember) {
      throw new Error(`Workspace member not found for user ${resolvedUserId}`);
    }
    await ensureConversationMember({
      conversationId: finalConversationId,
      memberType: 'user',
      workspaceId,
      workspaceMemberId: workspaceMember.workspaceMemberId,
      userId: resolvedUserId,
    });
  }

  const id = uuidv4();
  const created = await db
    .insertInto('sessions')
    .values({
      id,
      workspace_id: workspaceId,
      actor_id: actorId,
      conversation_id: finalConversationId,
      channel_type: channelType,
      trigger,
      status: 'idle',
      metadata: metadata as TableInsert<'sessions'>['metadata'],
    })
    .returning('id')
    .executeTakeFirst();
  if (!created) {
    throw new Error('Failed to create session');
  }

  if (privateConversationCreated) {
    const authzEntryIds = await enqueueAuthzRelationships(
      [
        touchRelation('conversation', finalConversationId, 'participant', 'actor', actorId),
        ...touchActorConversationContext(actorId, finalConversationId),
        ...(resolvedUserId
          ? [
              touchRelation(
                'conversation',
                finalConversationId,
                'participant',
                'workspace_user',
                buildWorkspaceUserContextId(workspaceId, resolvedUserId),
              ),
              touchRelation(
                'conversation',
                finalConversationId,
                'admin',
                'workspace_user',
                buildWorkspaceUserContextId(workspaceId, resolvedUserId),
              ),
            ]
          : []),
      ],
      {
        source: 'session.create_private_conversation',
        workspaceId,
        conversationId: finalConversationId,
        actorId,
        userId: resolvedUserId,
      },
    );
    await flushQueuedAuthzEntries(authzEntryIds, 'session.create_private_conversation');
  }

  return loadSession(created.id);
}

export async function getSession(sessionId: UUID): Promise<any | null> {
  return loadSession(sessionId);
}

export async function getSessionsByActor(
  workspaceId: UUID,
  actorId: UUID,
  status?: SessionStatus,
): Promise<any[]> {
  let sessionsQuery = db
    .selectFrom('sessions as s')
    .innerJoin('conversations as c', 'c.id', 's.conversation_id')
    .selectAll('s')
    .select([
      'c.kind as conversation_kind',
      'c.title as conversation_title',
    ])
    .where('s.workspace_id', '=', workspaceId)
    .where('s.actor_id', '=', actorId);

  if (status) {
    sessionsQuery = sessionsQuery.where('s.status', '=', status);
  }

  const sessions = await sessionsQuery
    .orderBy('s.created_at', 'desc')
    .execute();

  return sessions.map(normalizeSessionRow);
}

export async function updateSessionStatus(
  sessionId: UUID,
  status: SessionStatus,
  extra?: { errorMessage?: string | null },
): Promise<void> {
  await db
    .updateTable('sessions')
    .set({
      status,
      updated_at: sql`NOW()`,
      completed_at: status === 'closed' ? sql`NOW()` : null,
      ...(extra?.errorMessage !== undefined
        ? { error_message: extra.errorMessage }
        : {}),
    })
    .where('id', '=', sessionId)
    .execute();
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
  subtype?: string;
  visibility?: 'default' | 'shared_visible' | 'private_internal';
  metadata?: Record<string, unknown>;
  targetMemberIds?: UUID[];
  projectTransportOutbound?: boolean;
}): Promise<any> {
  const {
    sessionId,
    workspaceId,
    role,
    content,
    contentBlocks,
    fromActorId,
    fromUserId,
    subtype,
    visibility = 'default',
    metadata = {},
    targetMemberIds,
    projectTransportOutbound = false,
  } = params;
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const normalizedMessage = await buildNormalizedMessageContent({ content, contentBlocks, metadata });

  const authorMember = await resolveSessionMessageAuthor({
    conversationId: session.conversation_id,
    workspaceId,
    fromActorId,
    fromUserId,
  });
  const { scope, surface } =
    visibility === 'shared_visible'
      ? { scope: 'shared' as const, surface: 'visible' as const }
      : visibility === 'private_internal'
        ? { scope: 'private' as const, surface: 'internal' as const }
        : getSurfaceForSessionMessage(session.conversation_kind, role);
  const itemType = role === 'tool_result' ? 'control' : 'message';
  const resolvedSubtype = subtype || role;

  const item = await createConversationItem({
    workspaceId,
    conversationId: session.conversation_id,
    sessionId,
    scope,
    surface,
    itemType,
    subtype: resolvedSubtype,
    role: role === 'tool_result' ? 'tool' : role === 'system' ? 'system' : role === 'assistant' ? 'assistant' : 'user',
    authorMemberId: authorMember?.id,
    metadata: normalizedMessage.normalizedMetadata,
    parts: normalizedMessage.parts,
    targetMemberIds,
  });

  if (
    projectTransportOutbound &&
    scope === 'shared' &&
    surface === 'visible' &&
    Array.isArray(targetMemberIds) &&
    targetMemberIds.length > 0
  ) {
    await queueConversationTransportProjection({
      workspaceId,
      conversationId: session.conversation_id,
      itemId: item.id,
      direction: 'outbound',
      metadata: {
        senderType: fromActorId ? 'actor' : fromUserId ? 'user' : 'system',
        senderActorId: fromActorId || undefined,
        senderUserId: fromUserId || undefined,
        targetMemberIds,
      },
    }).catch((error) => {
      console.error(
        `Failed to queue transport projection for session item ${item.id}:`,
        error?.message || error,
      );
    });
  }

  if (
    scope === 'shared' &&
    surface === 'visible' &&
    !isGroupConversationKind(session.conversation_kind) &&
    (role === 'user' || role === 'assistant')
  ) {
    let actorName: string | undefined;
    if (fromActorId) {
      actorName = (
        await db
          .selectFrom('actors')
          .select('name')
          .where('id', '=', fromActorId)
          .executeTakeFirst()
      )?.name;
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
  const items = await db
    .selectFrom("conversation_items as ci")
    .innerJoin("sessions as s", "s.id", "ci.session_id")
    .leftJoin("conversation_members as cm", "cm.id", "ci.author_member_id")
    .leftJoin("actors as a", "a.id", "cm.actor_id")
    .leftJoin("users as u", "u.id", "cm.user_id")
    .select([
      "ci.id",
      "ci.session_id",
      "ci.conversation_id",
      "ci.sequence",
      "ci.role",
      "ci.subtype",
      "ci.metadata",
      "ci.event_payload",
      "ci.author_member_id",
      "ci.created_at",
      "s.workspace_id",
      "cm.actor_id as from_actor_id",
      "cm.user_id as from_user_id",
      sql<string | null>`COALESCE(a.name, u.name, cm.display_name)`.as(
        "author_name",
      ),
    ])
    .where("ci.session_id", "=", sessionId)
    .orderBy("ci.created_at", "asc")
    .orderBy("ci.sequence", "asc")
    .execute();

  if (items.length === 0) return [];

  const itemIds = items.map((row) => row.id);
  const partRows = await db
    .selectFrom("conversation_item_parts as cip")
    .leftJoin("files as f", "f.id", "cip.file_id")
    .select([
      "cip.id",
      "cip.item_id",
      "cip.ordinal",
      "cip.part_type",
      "cip.mime_type",
      "cip.text_value",
      "cip.json_value",
      "cip.file_id",
      "cip.name",
      "f.original_name",
      "f.stored_name",
      "f.mime_type as file_mime_type",
      "f.size_bytes",
    ])
    .where("cip.item_id", "in", itemIds)
    .orderBy("cip.item_id", "asc")
    .orderBy("cip.ordinal", "asc")
    .execute();

  const partsByItem = new Map<string, any[]>();
  for (const row of partRows) {
    if (!partsByItem.has(row.item_id)) partsByItem.set(row.item_id, []);
    partsByItem.get(row.item_id)!.push(row);
  }

  return items.map((row: any) => {
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
  return db
    .updateTable('session_interrupts')
    .set({
      is_consumed: true,
    })
    .where('target_session_id', '=', sessionId)
    .where('is_consumed', '=', false)
    .returningAll()
    .execute();
}

export async function createInterrupt(params: {
  targetSessionId: UUID;
  type: SessionInterruptType;
  content: string;
  fromSessionId?: UUID;
}): Promise<void> {
  await db
    .insertInto('session_interrupts')
    .values({
      id: uuidv4(),
      target_session_id: params.targetSessionId,
      type: params.type,
      content: params.content,
      from_session_id: params.fromSessionId || null,
    })
    .execute();
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
  const row = await db
    .selectFrom('sessions')
    .select(({ fn }) => fn.count<string>('id').as('count'))
    .where('actor_id', '=', actorId)
    .where('status', '=', 'running')
    .executeTakeFirst();
  return parseInt(row?.count || '0', 10);
}

export async function getMaxConcurrentSessions(actorId: UUID): Promise<number> {
  const row = await db
    .selectFrom("actors")
    .select(
      sql<number>`CASE
        WHEN COALESCE(config->>'maxConcurrentSessions', '') ~ '^[0-9]+$'
          THEN GREATEST((config->>'maxConcurrentSessions')::int, 1)
        ELSE 3
      END`.as("max_concurrent_sessions"),
    )
    .where("id", "=", actorId)
    .executeTakeFirst();
  return row?.max_concurrent_sessions ?? 3;
}
