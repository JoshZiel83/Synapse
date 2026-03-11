import { query } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import type { ActorAction, UUID } from '@synapse/shared';
import { v4 as uuidv4 } from 'uuid';

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
        await handleCreateMemory(workspaceId, actorId, action);
        break;
      case 'rename_self':
        await handleRenameSelf(actorId, action);
        break;
      case 'change_avatar':
        await handleChangeAvatar(actorId, action);
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
  action: ActorAction
): Promise<void> {
  const memoryId = uuidv4();
  const metadata = action.metadata ?? {};

  await query(
    `INSERT INTO memories (id, workspace_id, actor_id, category, scope, content, tags, importance, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
    [
      memoryId,
      workspaceId,
      actorId,
      (metadata.category as string) ?? 'experiential',
      (metadata.scope as string) ?? 'private',
      action.content,
      (metadata.tags as string[]) ?? [],
      (metadata.importance as number) ?? 0.5,
    ]
  );

  // Increment memory_version so concurrent sessions can detect the change
  await query(
    `UPDATE actors SET memory_version = memory_version + 1, updated_at = NOW() WHERE id = $1`,
    [actorId]
  );

  await emitEvent({
    type: 'memory.created',
    workspaceId,
    payload: { memoryId, actorId, category: metadata.category ?? 'experiential' },
    timestamp: new Date().toISOString(),
  });
}

async function handleRenameSelf(
  actorId: UUID,
  action: ActorAction
): Promise<void> {
  const newName = action.content?.trim();
  if (!newName) return;
  await query(
    `UPDATE actors SET name = $1, updated_at = NOW() WHERE id = $2`,
    [newName, actorId]
  );
}

async function handleChangeAvatar(
  actorId: UUID,
  action: ActorAction
): Promise<void> {
  const emoji = action.content?.trim();
  if (!emoji) return;
  await query(
    `UPDATE actors SET config = config || $1::jsonb, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify({ avatar_emoji: emoji }), actorId]
  );
}
