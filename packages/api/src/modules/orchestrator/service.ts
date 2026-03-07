import { query, transaction } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { memoryArchivalQueue, sessionTimeoutQueue } from '../../workers/queues.js';
import type { ActorAction, UUID } from '@synapse/shared';
import { DEFAULT_WAIT_TIMEOUT } from '@synapse/shared';
import { v4 as uuidv4 } from 'uuid';

export async function executeActorActions(
  workspaceId: UUID,
  actorId: UUID,
  workItemId: UUID,
  actions: ActorAction[],
  sessionId?: UUID,
): Promise<void> {
  for (const action of actions) {
    switch (action.type) {
      case 'respond':
        await handleRespond(workspaceId, actorId, workItemId, action, sessionId);
        break;
      case 'delegate':
        await handleDelegate(workspaceId, actorId, workItemId, action);
        break;
      case 'complete':
        await handleComplete(workspaceId, actorId, workItemId, action, sessionId);
        break;
      case 'escalate':
        await handleEscalate(workspaceId, actorId, workItemId, action);
        break;
      case 'request_info':
        await handleRequestInfo(workspaceId, actorId, workItemId, action);
        break;
      case 'update_progress':
        await handleUpdateProgress(workspaceId, actorId, workItemId, action);
        break;
      case 'create_memory':
        await handleCreateMemory(workspaceId, actorId, workItemId, action);
        break;
      case 'rename_self':
        await handleRenameSelf(actorId, action);
        break;
      case 'change_avatar':
        await handleChangeAvatar(actorId, action);
        break;
      case 'wait':
        if (sessionId) {
          await handleWait(workspaceId, sessionId, action);
        }
        break;
    }
  }
}

async function handleRespond(
  workspaceId: UUID,
  actorId: UUID,
  workItemId: UUID,
  action: ActorAction,
  sessionId?: UUID,
): Promise<void> {
  const messageId = uuidv4();

  await query(
    `INSERT INTO messages (id, workspace_id, work_item_id, type, from_actor_id, content, metadata, created_at)
     VALUES ($1, $2, $3, 'secretary_response', $4, $5, $6, NOW())`,
    [messageId, workspaceId, workItemId, actorId, action.content, JSON.stringify(action.metadata ?? {})]
  );

  await emitEvent({
    type: 'secretary.response',
    workspaceId,
    payload: { messageId, actorId, workItemId, content: action.content },
    timestamp: new Date().toISOString(),
  });
}

async function handleDelegate(
  workspaceId: UUID,
  actorId: UUID,
  workItemId: UUID,
  action: ActorAction
): Promise<void> {
  if (!action.targetActorId) {
    throw new Error('Delegate action requires targetActorId');
  }

  await transaction(async (client) => {
    const childWorkItemId = uuidv4();
    const messageId = uuidv4();

    // Create child work item
    await client.query(
      `INSERT INTO work_items (id, workspace_id, title, description, status, priority, parent_id, source_type, created_by, assigned_to, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'assigned', 'medium', $5, 'delegation', $6, $7, $8, NOW(), NOW())`,
      [
        childWorkItemId,
        workspaceId,
        action.content.substring(0, 100),
        action.content,
        workItemId,
        actorId,
        action.targetActorId,
        JSON.stringify(action.metadata ?? {}),
      ]
    );

    // Create assign message
    await client.query(
      `INSERT INTO messages (id, workspace_id, work_item_id, type, from_actor_id, to_actor_id, content, metadata, created_at)
       VALUES ($1, $2, $3, 'assign', $4, $5, $6, $7, NOW())`,
      [
        messageId,
        workspaceId,
        childWorkItemId,
        actorId,
        action.targetActorId,
        action.content,
        JSON.stringify(action.metadata ?? {}),
      ]
    );

    // Transition parent work item to in_progress
    await client.query(
      `UPDATE work_items SET status = 'in_progress', updated_at = NOW() WHERE id = $1`,
      [workItemId]
    );
  });

  await emitEvent({
    type: 'work_item.created',
    workspaceId,
    payload: { actorId, workItemId, targetActorId: action.targetActorId, action: 'delegate' },
    timestamp: new Date().toISOString(),
  });
}

async function handleComplete(
  workspaceId: UUID,
  actorId: UUID,
  workItemId: UUID,
  action: ActorAction,
  sessionId?: UUID,
): Promise<void> {
  await transaction(async (client) => {
    const messageId = uuidv4();

    // Transition work item to completed
    await client.query(
      `UPDATE work_items SET status = 'completed', result = $1, completed_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [action.content, workItemId]
    );

    // Create complete message
    await client.query(
      `INSERT INTO messages (id, workspace_id, work_item_id, type, from_actor_id, content, metadata, created_at)
       VALUES ($1, $2, $3, 'complete', $4, $5, $6, NOW())`,
      [messageId, workspaceId, workItemId, actorId, action.content, JSON.stringify(action.metadata ?? {})]
    );
  });

  await emitEvent({
    type: 'work_item.transitioned',
    workspaceId,
    payload: { workItemId, actorId, newStatus: 'completed' },
    timestamp: new Date().toISOString(),
  });

  // Enqueue memory archival job to extract learnings from completed work
  await memoryArchivalQueue.add('archive', {
    workItemId,
    actorId,
    workspaceId,
  });
}

async function handleEscalate(
  workspaceId: UUID,
  actorId: UUID,
  workItemId: UUID,
  action: ActorAction
): Promise<void> {
  await transaction(async (client) => {
    const messageId = uuidv4();

    // Get parent actor
    const actorResult = await client.query(
      `SELECT parent_id FROM actors WHERE id = $1`,
      [actorId]
    );
    const parentActorId = actorResult.rows[0]?.parent_id;

    // Transition work item to escalated
    await client.query(
      `UPDATE work_items SET status = 'escalated', updated_at = NOW() WHERE id = $1`,
      [workItemId]
    );

    // Create escalate message to parent actor
    await client.query(
      `INSERT INTO messages (id, workspace_id, work_item_id, type, from_actor_id, to_actor_id, content, metadata, created_at)
       VALUES ($1, $2, $3, 'escalate', $4, $5, $6, $7, NOW())`,
      [
        messageId,
        workspaceId,
        workItemId,
        actorId,
        parentActorId ?? null,
        action.content,
        JSON.stringify(action.metadata ?? {}),
      ]
    );
  });

  await emitEvent({
    type: 'work_item.transitioned',
    workspaceId,
    payload: { workItemId, actorId, newStatus: 'escalated' },
    timestamp: new Date().toISOString(),
  });
}

async function handleRequestInfo(
  workspaceId: UUID,
  actorId: UUID,
  workItemId: UUID,
  action: ActorAction
): Promise<void> {
  const messageId = uuidv4();

  await query(
    `INSERT INTO messages (id, workspace_id, work_item_id, type, from_actor_id, to_actor_id, content, metadata, created_at)
     VALUES ($1, $2, $3, 'info_request', $4, $5, $6, $7, NOW())`,
    [
      messageId,
      workspaceId,
      workItemId,
      actorId,
      action.targetActorId ?? null,
      action.content,
      JSON.stringify(action.metadata ?? {}),
    ]
  );

  await emitEvent({
    type: 'message.created',
    workspaceId,
    payload: { messageId, type: 'info_request', actorId, workItemId },
    timestamp: new Date().toISOString(),
  });
}

async function handleUpdateProgress(
  workspaceId: UUID,
  actorId: UUID,
  workItemId: UUID,
  action: ActorAction
): Promise<void> {
  const messageId = uuidv4();

  await query(
    `INSERT INTO messages (id, workspace_id, work_item_id, type, from_actor_id, content, metadata, created_at)
     VALUES ($1, $2, $3, 'progress', $4, $5, $6, NOW())`,
    [messageId, workspaceId, workItemId, actorId, action.content, JSON.stringify(action.metadata ?? {})]
  );

  await emitEvent({
    type: 'message.created',
    workspaceId,
    payload: { messageId, type: 'progress', actorId, workItemId },
    timestamp: new Date().toISOString(),
  });
}

async function handleCreateMemory(
  workspaceId: UUID,
  actorId: UUID,
  workItemId: UUID,
  action: ActorAction
): Promise<void> {
  const memoryId = uuidv4();
  const metadata = action.metadata ?? {};

  await query(
    `INSERT INTO memories (id, workspace_id, actor_id, category, scope, content, tags, source_work_item_id, importance, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
    [
      memoryId,
      workspaceId,
      actorId,
      (metadata.category as string) ?? 'experiential',
      (metadata.scope as string) ?? 'private',
      action.content,
      (metadata.tags as string[]) ?? [],
      workItemId,
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
    payload: { memoryId, actorId, workItemId, category: metadata.category ?? 'experiential' },
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
  // Store avatar emoji in actor config JSONB
  await query(
    `UPDATE actors SET config = config || $1::jsonb, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify({ avatar_emoji: emoji }), actorId]
  );
}

async function handleWait(
  workspaceId: UUID,
  sessionId: UUID,
  action: ActorAction
): Promise<void> {
  const waitingFor = action.waitingFor || [];
  if (waitingFor.length === 0) return;

  const timeoutMinutes = (action.metadata?.timeoutMinutes as number) || (DEFAULT_WAIT_TIMEOUT / 60_000);
  const waitTimeoutAt = new Date(Date.now() + timeoutMinutes * 60_000).toISOString();

  // Update session to waiting status
  await query(
    `UPDATE sessions SET status = 'waiting', waiting_for = $1, wait_timeout_at = $2, updated_at = NOW() WHERE id = $3`,
    [waitingFor, waitTimeoutAt, sessionId]
  );

  // Schedule a timeout job
  await sessionTimeoutQueue.add(
    'timeout',
    { sessionId, workspaceId },
    { delay: timeoutMinutes * 60_000 }
  );

  // Immediately check if any of the child sessions have already completed (race condition protection)
  const alreadyCompleted = await query(
    `SELECT id FROM sessions WHERE id = ANY($1) AND status IN ('completed', 'failed')`,
    [waitingFor]
  );

  if (alreadyCompleted.rows.length > 0) {
    // Some children already finished — trigger completion check for each
    for (const row of alreadyCompleted.rows) {
      const childResult = await query(
        `SELECT result FROM work_items WHERE id = (SELECT work_item_id FROM sessions WHERE id = $1)`,
        [row.id]
      );
      const { onSessionCompleted } = await import('../session/completion.js');
      const childSession = await query('SELECT status FROM sessions WHERE id = $1', [row.id]);
      await onSessionCompleted(
        row.id,
        childResult.rows[0]?.result || '',
        childSession.rows[0]?.status === 'completed'
      );
    }
  }
}
