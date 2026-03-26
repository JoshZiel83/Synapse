import { emitEvent } from '../../infrastructure/events/index.js';
import type { ActorAction, ConversationFeedEventPayloadMap, UUID } from '@synapse/shared';
import { query } from '../../infrastructure/database/index.js';
import { createMemory } from '../memory/service.js';
import { createGeneratedActorPixelArtAvatarFile, type PixelArtAvatarOptionsInput } from '../avatar/service.js';
import { getActor, updateActor, type ActorUpdateSourceInput } from '../organization/service.js';
import { getSession } from '../session/service.js';
import { createConversationEvent, getConversationFeedItemById, listConversationMembers } from '../conversation/service.js';

const ACTOR_MEMORY_SCOPES = new Set(['actor_conversation', 'conversation', 'actor_global']);
const PIXEL_ART_OPTION_KEYS = [
  'seed',
  'accessories',
  'accessoriesProbability',
  'clothing',
  'eyes',
  'glasses',
  'glassesProbability',
  'beard',
  'beardProbability',
  'mouth',
  'hair',
  'hat',
  'hatProbability',
  'accessoriesColor',
  'clothingColor',
  'eyesColor',
  'glassesColor',
  'hairColor',
  'hatColor',
  'mouthColor',
  'skinColor',
] as const;

type ActorActionExecutionContext = {
  sessionId?: UUID;
  turnId?: UUID;
  userId?: UUID;
  conversationId?: UUID;
};

function parsePixelArtAvatarOptions(value: unknown): PixelArtAvatarOptionsInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const source = value as Record<string, unknown>;
  const options: Record<string, unknown> = {};

  for (const key of PIXEL_ART_OPTION_KEYS) {
    const nextValue = source[key];
    if (typeof nextValue === 'string') {
      const trimmed = nextValue.trim();
      if (trimmed) {
        options[key] = trimmed;
      }
      continue;
    }

    if (typeof nextValue === 'number' && Number.isFinite(nextValue)) {
      options[key] = nextValue;
    }
  }

  return options as PixelArtAvatarOptionsInput;
}

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
  context?: UUID | ActorActionExecutionContext,
): Promise<void> {
  const executionContext =
    typeof context === 'string'
      ? { sessionId: context }
      : (context || {});

  for (const action of actions) {
    switch (action.type) {
      case 'respond':
        await handleRespond(workspaceId, actorId, action, executionContext.sessionId);
        break;
      case 'create_memory':
        await handleCreateMemory(workspaceId, actorId, action, executionContext);
        break;
      case 'rename_self':
        await handleRenameSelf(workspaceId, actorId, action, executionContext);
        break;
      case 'change_avatar':
        await handleChangeAvatar(workspaceId, actorId, action, executionContext);
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
    type: 'actor.action',
    workspaceId,
    payload: { actorId, sessionId, actions: [action] },
    timestamp: new Date().toISOString(),
  });
}

async function handleCreateMemory(
  workspaceId: UUID,
  actorId: UUID,
  action: ActorAction,
  context: ActorActionExecutionContext,
): Promise<void> {
  const metadata = action.metadata ?? {};
  const session = context.sessionId ? await getSession(context.sessionId) : null;
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
    sourceTurnId:
      typeof metadata.sourceTurnId === 'string'
        ? metadata.sourceTurnId
        : context.turnId,
    supersedesMemoryId: typeof metadata.supersedesMemoryId === 'string' ? metadata.supersedesMemoryId : undefined,
    metadata: typeof metadata === 'object' ? metadata : {},
  });

  await emitUserVisibleSystemNotice({
    workspaceId,
    actorId,
    sessionId: context.sessionId,
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
  context: ActorActionExecutionContext,
): Promise<void> {
  const newName = action.content?.trim();
  if (!newName) return;
  const source: ActorUpdateSourceInput = {
    type: 'actor',
    actorId,
    userId: context.userId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    conversationId: context.conversationId,
    reason: 'rename_self',
  };
  await updateActor(actorId, workspaceId, { name: newName }, source);
}

async function handleChangeAvatar(
  workspaceId: UUID,
  actorId: UUID,
  action: ActorAction,
  context: ActorActionExecutionContext,
): Promise<void> {
  const actor = await getActor(actorId, workspaceId);
  if (!actor) return;
  const source: ActorUpdateSourceInput = {
    type: 'actor',
    actorId,
    userId: context.userId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    conversationId: context.conversationId,
    reason: 'change_avatar',
  };

  const avatarMode =
    action.metadata?.avatarMode === 'pixel_art' ? 'pixel_art' : 'emoji';

  if (avatarMode === 'pixel_art') {
    const pixelArtOptions = parsePixelArtAvatarOptions(action.metadata?.pixelArt);
    const avatarFile = await createGeneratedActorPixelArtAvatarFile(
      { query },
      {
        workspaceId,
        actorId,
        actorName: actor.definition.name,
        actorTitle: actor.definition.title,
        uploaderUserId: context.userId || null,
        options: pixelArtOptions,
      },
    );

    const updatedActor = await updateActor(
      actorId,
      workspaceId,
      {
        avatarFileId: avatarFile.fileId,
        avatarEmoji: null,
      },
      source,
    );

    if (updatedActor) {
      await emitUserVisibleSystemNotice({
        workspaceId,
        actorId,
        sessionId: context.sessionId,
        eventType: 'actor_avatar_changed',
        eventPayload: {
          actor: {
            memberType: 'actor',
            actorId,
            name: updatedActor.definition.name,
            title: updatedActor.definition.title,
            role: updatedActor.definition.role,
            avatarUrl: updatedActor.avatarUrl,
            avatarEmoji: updatedActor.definition.avatarEmoji,
          },
          oldAvatarEmoji: actor.definition.avatarEmoji,
          newAvatarEmoji: updatedActor.definition.avatarEmoji,
          oldAvatarUrl: actor.avatarUrl,
          newAvatarUrl: updatedActor.avatarUrl,
          sourceTurnId: context.turnId,
        },
        metadata: {
          noticeType: 'actor_avatar_changed',
          actorId,
          avatarMode,
        },
      });
    }
    return;
  }

  const emoji =
    typeof action.metadata?.emoji === 'string'
      ? action.metadata.emoji.trim()
      : action.content?.trim();
  if (!emoji) return;

  const updatedActor = await updateActor(
    actorId,
    workspaceId,
    {
      avatarFileId: null,
      avatarEmoji: emoji,
    },
    source,
  );

  if (!updatedActor) return;

  await emitUserVisibleSystemNotice({
    workspaceId,
    actorId,
    sessionId: context.sessionId,
    eventType: 'actor_avatar_changed',
    eventPayload: {
      actor: {
        memberType: 'actor',
        actorId,
        name: updatedActor.definition.name,
        title: updatedActor.definition.title,
        role: updatedActor.definition.role,
        avatarUrl: updatedActor.avatarUrl,
        avatarEmoji: updatedActor.definition.avatarEmoji,
      },
      oldAvatarEmoji: actor.definition.avatarEmoji,
      newAvatarEmoji: updatedActor.definition.avatarEmoji,
      oldAvatarUrl: actor.avatarUrl,
      newAvatarUrl: updatedActor.avatarUrl,
      sourceTurnId: context.turnId,
    },
    metadata: {
      noticeType: 'actor_avatar_changed',
      actorId,
      avatarMode,
    },
  });
}
