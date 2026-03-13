import { query } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import type { ActorAction, UUID } from '@synapse/shared';
import { createMemory } from '../memory/service.js';
import { getActor, updateActor } from '../organization/service.js';
import { getSession } from '../session/service.js';
import { createConversationEvent, listConversationMembers } from '../conversation/service.js';
import { renderConversationEventTimelineBlocks } from '../conversation/event-registry.js';
import { extractText } from '@synapse/shared';

async function emitUserVisibleSystemNotice(params: {
  workspaceId: UUID;
  actorId: UUID;
  sessionId?: UUID;
  eventType: 'memory_saved' | 'memory_updated' | 'actor_renamed' | 'actor_avatar_changed';
  eventPayload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!params.sessionId) return;

  const session = await getSession(params.sessionId);
  if (!session) return;

  const members = await listConversationMembers(session.conversation_id);
  const targetUserMembers = members.filter((member: any) => member.state === 'active' && member.user_id);
  if (targetUserMembers.length === 0) return;

  const created = await createConversationEvent({
    conversationId: session.conversation_id,
    sessionId: params.sessionId,
    eventType: params.eventType,
    timelinePolicy: 'users_only',
    contextPolicy: 'none',
    metadata: {
      ...(params.metadata || {}),
    },
    eventPayload: params.eventPayload,
    targetMemberIds: targetUserMembers.map((member: any) => member.id),
  });

  const timelineBlocks = created.timelineContentBlocks.length > 0
    ? created.timelineContentBlocks
    : renderConversationEventTimelineBlocks(params.eventType, params.eventPayload);
  const content = extractText(timelineBlocks);

  await emitEvent({
    type: 'session.message.new',
    workspaceId: params.workspaceId,
    payload: {
      groupId: session.group_id || undefined,
      sessionId: params.sessionId,
      messageId: created.item.id,
      role: 'system',
      fromActorId: params.actorId,
      fromUserId: null,
      targetUserIds: targetUserMembers.map((member: any) => member.user_id),
      content,
      contentBlocks: timelineBlocks,
      metadata: created.metadata,
      eventType: params.eventType,
      eventPayload: params.eventPayload,
      createdAt: created.item.created_at,
    },
    timestamp: new Date().toISOString(),
  });
}

export async function executeActorActions(
  workspaceId: UUID,
  actorId: UUID,
  actions: ActorAction[],
  sessionId?: UUID,
): Promise<void> {
  for (const action of actions) {
    switch (action.type) {
      case 'respond':
        await handleRespond(workspaceId, actorId, action, sessionId);
        break;
      case 'create_memory':
        await handleCreateMemory(workspaceId, actorId, action, sessionId);
        break;
      case 'rename_self':
        await handleRenameSelf(workspaceId, actorId, action, sessionId);
        break;
      case 'change_avatar':
        await handleChangeAvatar(workspaceId, actorId, action, sessionId);
        break;
    }
  }
}

async function handleRespond(
  workspaceId: UUID,
  actorId: UUID,
  action: ActorAction,
  sessionId?: UUID,
): Promise<void> {
  await emitEvent({
    type: 'secretary.response',
    workspaceId,
    payload: { actorId, content: action.content },
    timestamp: new Date().toISOString(),
  });
}

async function handleCreateMemory(
  workspaceId: UUID,
  actorId: UUID,
  action: ActorAction,
  sessionId?: UUID,
): Promise<void> {
  const metadata = action.metadata ?? {};
  const session = sessionId ? await getSession(sessionId) : null;
  const requestedScope = (metadata.scope as string | undefined) ?? 'actor_conversation';
  const conversationId = (requestedScope === 'actor_global' || requestedScope === 'workspace' || requestedScope === 'user')
    ? undefined
    : session?.conversation_id;
  const ownerUserId = requestedScope === 'user' ? session?.user_id || undefined : undefined;

  const memory = await createMemory(workspaceId, {
    ownerScope: requestedScope as any,
    ownerActorId: requestedScope === 'conversation' || requestedScope === 'workspace' || requestedScope === 'user' ? undefined : actorId,
    ownerConversationId: conversationId,
    ownerUserId,
    category: ((metadata.category as string | undefined) ?? 'fact') as any,
    stability: ((metadata.stability as string | undefined) ?? 'durable') as any,
    importance: (metadata.importance as number | undefined) ?? 0.5,
    confidence: (metadata.confidence as number | undefined) ?? 0.8,
    tags: (metadata.tags as string[] | undefined) ?? [],
    content: action.content,
    contentBlocks: action.contentBlocks,
    textDigest: typeof metadata.textDigest === 'string' ? metadata.textDigest : undefined,
    metadata: typeof metadata === 'object' ? metadata : {},
  });

  const scopeLabel =
    memory.ownerScope === 'conversation'
      ? 'shared conversation memory'
      : memory.ownerScope === 'actor_global'
        ? 'global actor memory'
        : memory.ownerScope === 'user'
          ? 'single-user memory'
          : memory.ownerScope === 'workspace'
            ? 'workspace memory'
            : 'private actor-conversation memory';
  const summary = memory.textDigest?.trim() || 'durable memory saved';

  await emitUserVisibleSystemNotice({
    workspaceId,
    actorId,
    sessionId,
    eventType: action.metadata?.supersedesMemoryId ? 'memory_updated' : 'memory_saved',
    eventPayload: {
      actorId,
      memoryId: memory.id,
      memoryScope: memory.ownerScope,
      memoryCategory: memory.category,
      textDigest: memory.textDigest,
      summary,
      scopeLabel,
    },
    metadata: {
      noticeType: action.metadata?.supersedesMemoryId ? 'memory_updated' : 'memory_saved',
      actorId,
      memoryId: memory.id,
      memoryScope: memory.ownerScope,
      memoryCategory: memory.category,
      textDigest: memory.textDigest,
    },
  });
}

async function handleRenameSelf(
  workspaceId: UUID,
  actorId: UUID,
  action: ActorAction,
  sessionId?: UUID,
): Promise<void> {
  const newName = action.content?.trim();
  if (!newName) return;
  await updateActor(actorId, workspaceId, { name: newName });
  await emitUserVisibleSystemNotice({
    workspaceId,
    actorId,
    sessionId,
    eventType: 'actor_renamed',
    eventPayload: {
      actorId,
      newName,
    },
    metadata: {
      noticeType: 'actor_renamed',
      actorId,
      newName,
    },
  });
}

async function handleChangeAvatar(
  workspaceId: UUID,
  actorId: UUID,
  action: ActorAction,
  sessionId?: UUID,
): Promise<void> {
  const emoji = action.content?.trim();
  if (!emoji) return;
  const actor = await getActor(actorId, workspaceId);
  await updateActor(actorId, workspaceId, {
    config: {
      ...(actor?.definition.config || {}),
      avatar_emoji: emoji,
    },
  });
  await emitUserVisibleSystemNotice({
    workspaceId,
    actorId,
    sessionId,
    eventType: 'actor_avatar_changed',
    eventPayload: {
      actorId,
      avatarEmoji: emoji,
    },
    metadata: {
      noticeType: 'actor_avatar_changed',
      actorId,
      avatarEmoji: emoji,
    },
  });
}
