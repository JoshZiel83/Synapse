import { query } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import type { ActorAction, ConversationFeedEventPayloadMap, UUID } from '@synapse/shared';
import { createMemory } from '../memory/service.js';
import { getActor, updateActor } from '../organization/service.js';
import { getSession } from '../session/service.js';
import { createConversationEvent, getConversationFeedItemById, listConversationMembers } from '../conversation/service.js';

const ACTOR_MEMORY_SCOPES = new Set(['actor_conversation', 'conversation', 'actor_global']);

async function emitChatFeedItem(workspaceId: UUID, itemId: UUID) {
  const item = await getConversationFeedItemById(itemId);
  if (!item || item.workspaceSequence === undefined) return;

  await emitEvent({
    type: 'chat.feed.item.created',
    workspaceId,
    payload: {
      workspaceSequence: item.workspaceSequence,
      item,
    },
    timestamp: new Date().toISOString(),
  });
}

async function emitUserVisibleSystemNotice<T extends 'memory_saved' | 'memory_updated' | 'actor_renamed' | 'actor_avatar_changed'>(params: {
  workspaceId: UUID;
  actorId: UUID;
  sessionId?: UUID;
  eventType: T;
  eventPayload: ConversationFeedEventPayloadMap[T];
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!params.sessionId) return;

  const session = await getSession(params.sessionId);
  if (!session) return;

  const members = await listConversationMembers(session.conversation_id);
  const targetUserMembers = members.filter((member: any) => member.state === 'active' && member.user_id);
  if (targetUserMembers.length === 0) return;

  const created = await createConversationEvent({
    workspaceId: params.workspaceId,
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
  await emitChatFeedItem(params.workspaceId, created.item.id);
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
  const requestedScope = typeof metadata.scope === 'string' ? metadata.scope : 'actor_conversation';
  const normalizedRequestedScope = ACTOR_MEMORY_SCOPES.has(requestedScope) ? requestedScope : 'actor_conversation';
  const effectiveScope =
    normalizedRequestedScope === 'conversation' && !session?.conversation_id
      ? 'actor_global'
      : normalizedRequestedScope === 'actor_conversation' && !session?.conversation_id
          ? 'actor_global'
          : normalizedRequestedScope;
  const conversationId = effectiveScope === 'actor_global'
    ? undefined
    : session?.conversation_id;

  const memory = await createMemory(workspaceId, {
    ownerScope: effectiveScope as any,
    ownerActorId: effectiveScope === 'conversation' ? undefined : actorId,
    ownerConversationId: conversationId,
    ownerUserId: undefined,
    category: ((metadata.category as string | undefined) ?? 'fact') as any,
    stability: ((metadata.stability as string | undefined) ?? 'durable') as any,
    importance: (metadata.importance as number | undefined) ?? 0.5,
    confidence: (metadata.confidence as number | undefined) ?? 0.8,
    tags: (metadata.tags as string[] | undefined) ?? [],
    content: action.content,
    contentBlocks: action.contentBlocks,
    textDigest: typeof metadata.textDigest === 'string' ? metadata.textDigest : undefined,
    sourceItemId: typeof metadata.sourceItemId === 'string' ? metadata.sourceItemId : undefined,
    sourceTurnId: typeof metadata.sourceTurnId === 'string' ? metadata.sourceTurnId : undefined,
    supersedesMemoryId: typeof metadata.supersedesMemoryId === 'string' ? metadata.supersedesMemoryId : undefined,
    metadata: typeof metadata === 'object' ? metadata : {},
  });

  await emitUserVisibleSystemNotice({
    workspaceId,
    actorId,
    sessionId,
    eventType: action.metadata?.supersedesMemoryId ? 'memory_updated' : 'memory_saved',
    eventPayload: {
      actor: {
        memberType: 'actor',
        actorId,
      },
      memoryId: memory.id,
      memoryScope: memory.ownerScope,
      memoryCategory: memory.category,
      textDigest: memory.textDigest,
      sourceItemId: memory.sourceItemId,
      sourceTurnId: memory.sourceTurnId,
      supersedesMemoryId: memory.supersedesMemoryId,
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
      actor: {
        memberType: 'actor',
        actorId,
        name: newName,
      },
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
      actor: {
        memberType: 'actor',
        actorId,
      },
      newAvatarEmoji: emoji,
    },
    metadata: {
      noticeType: 'actor_avatar_changed',
      actorId,
      avatarEmoji: emoji,
    },
  });
}
