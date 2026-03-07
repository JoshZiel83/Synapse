import { Worker } from 'bullmq';
import { redis } from '../infrastructure/redis/index.js';
import { query } from '../infrastructure/database/index.js';
import { emitEvent } from '../infrastructure/events/index.js';
import { QUEUE_NAMES, SESSION_LOCK_TTL, REDIS_CHANNELS, DEFAULT_MAX_CONCURRENT_SESSIONS, nowISO } from '@synapse/shared';
import type { ActorAction } from '@synapse/shared';
import { actorThink } from '../modules/ai/index.js';
import { executeActorActions } from '../modules/orchestrator/service.js';
import { resolveModelConfig } from '../modules/model-groups/resolver.js';
import {
  getSession,
  getSessionMessages,
  updateSessionStatus,
  addSessionMessage,
  consumeInterrupts,
} from '../modules/session/service.js';
import { onSessionCompleted } from '../modules/session/completion.js';

export function startSessionThinkingWorker() {
  const worker = new Worker(
    QUEUE_NAMES.SESSION_THINKING,
    async (job) => {
      const { sessionId, actorId, workspaceId, workItemId, trigger } = job.data;
      const sessionLockKey = `${REDIS_CHANNELS.SESSION_LOCK_PREFIX}${sessionId}`;
      const actorSessionsKey = `${REDIS_CHANNELS.ACTOR_SESSIONS_PREFIX}${actorId}`;

      // 1. Acquire per-session lock
      const acquired = await redis.set(sessionLockKey, job.id!, 'PX', SESSION_LOCK_TTL, 'NX');
      if (!acquired) {
        throw new Error(`Session ${sessionId} is already being processed, will retry`);
      }

      // 2. Check actor concurrent session limit
      const currentCount = await redis.incr(actorSessionsKey);
      // Set TTL on the counter key (safety net in case of crashes)
      await redis.pexpire(actorSessionsKey, SESSION_LOCK_TTL * 2);

      const maxSessions = await getActorMaxSessions(actorId);
      if (currentCount > maxSessions) {
        await redis.decr(actorSessionsKey);
        await redis.del(sessionLockKey);
        throw new Error(`Actor ${actorId} concurrent limit (${maxSessions}) reached, will retry`);
      }

      try {
        // Verify session is still active
        const session = await getSession(sessionId);
        if (!session || (session.status !== 'active')) {
          console.log(`[session-thinking] Session ${sessionId} is ${session?.status ?? 'not found'}, skipping`);
          return { success: false, reason: 'session not active' };
        }

        // Emit thinking event
        await emitEvent({
          type: 'actor.thinking',
          workspaceId,
          payload: { actorId, sessionId, workItemId },
          timestamp: nowISO(),
        });

        // Emit session.thinking for chat UI
        const thinkingActorResult = await query('SELECT name FROM actors WHERE id = $1', [actorId]);
        const thinkingActorName = thinkingActorResult.rows[0]?.name || 'Unknown';
        const thinkingSession = await getSession(sessionId);
        const rootSessionIdForEvents = thinkingSession?.root_session_id || sessionId;

        const emitThinkingStatus = async (status: string) => {
          await emitEvent({
            type: 'session.thinking',
            workspaceId,
            payload: { rootSessionId: rootSessionIdForEvents, sessionId, actorId, actorName: thinkingActorName, status },
            timestamp: nowISO(),
          });
        };

        await emitThinkingStatus('Analyzing message...');

        // Load actor
        const actorResult = await query('SELECT * FROM actors WHERE id = $1', [actorId]);
        if (actorResult.rows.length === 0) throw new Error(`Actor ${actorId} not found`);
        const actor = actorResult.rows[0];

        // Load session messages (isolated context - only this session's messages)
        const sessionMessages = await getSessionMessages(sessionId);

        // Build work context from session messages
        let workContext = '';
        for (const msg of sessionMessages) {
          switch (msg.role) {
            case 'user':
              workContext += `[Boss]: ${msg.content}\n`;
              break;
            case 'system':
              workContext += `[任务指令]: ${msg.content}\n`;
              break;
            case 'assistant':
              workContext += `[你之前的回复]: ${msg.content}\n`;
              break;
            case 'child_result':
              workContext += `${msg.content}\n`;
              break;
            case 'tool_result':
              workContext += `[工具结果]: ${msg.content}\n`;
              break;
          }
        }

        // Check for interrupts and inject them
        const interrupts = await consumeInterrupts(sessionId);
        if (interrupts.length > 0) {
          workContext += '\n[系统通知] 以下中断需要你注意:\n';
          for (const interrupt of interrupts) {
            workContext += `- [${interrupt.type}]: ${interrupt.content}\n`;
          }
        }

        // Check memory version
        const lastSeenMemoryVersion = session.metadata?.lastSeenMemoryVersion ?? actor.memory_version;
        if (actor.memory_version > lastSeenMemoryVersion) {
          // Load new memories created since last seen version
          const newMemories = await query(
            `SELECT content, category FROM memories
             WHERE actor_id = $1 AND workspace_id = $2
             ORDER BY created_at DESC LIMIT 5`,
            [actorId, workspaceId]
          );
          if (newMemories.rows.length > 0) {
            workContext += '\n[系统通知] 你的记忆已被另一个并发任务更新:\n';
            for (const mem of newMemories.rows) {
              workContext += `- [${mem.category}]: ${mem.content}\n`;
            }
          }
          // Update lastSeenMemoryVersion in session metadata
          await query(
            `UPDATE sessions SET metadata = metadata || $1::jsonb WHERE id = $2`,
            [JSON.stringify({ lastSeenMemoryVersion: actor.memory_version }), sessionId]
          );
        }

        // If this is a resumed session, add context
        if (trigger === 'resume') {
          workContext += '\n[系统通知] 你之前委派的子任务已全部完成，请查看上方的子任务结果并继续处理。\n';
        }

        // Recall memories
        const memoriesResult = await query(
          `SELECT content, category, importance FROM memories
           WHERE (actor_id = $1 OR scope IN ('team', 'workspace'))
           AND workspace_id = $2
           ORDER BY importance DESC, created_at DESC LIMIT 10`,
          [actorId, workspaceId]
        );

        // Load subordinates
        const subordinatesResult = await query(
          'SELECT id, name, title, charter, capabilities FROM actors WHERE parent_id = $1 AND is_active = true',
          [actorId]
        );

        // Resolve model config
        const resolvedConfig = await resolveModelConfig(actorId, workspaceId);

        // Refresh session lock periodically
        const lockRefreshInterval = setInterval(async () => {
          try {
            await redis.pexpire(sessionLockKey, SESSION_LOCK_TTL);
          } catch { /* ignore */ }
        }, Math.floor(SESSION_LOCK_TTL / 2));

        let result;
        try {
          await emitThinkingStatus('Calling AI model...');
          result = await actorThink(
            actor,
            memoriesResult.rows,
            workContext,
            subordinatesResult.rows.length > 0 ? subordinatesResult.rows : undefined,
            resolvedConfig,
            workspaceId,
            { sessionId, onStatus: emitThinkingStatus },
          );
        } finally {
          clearInterval(lockRefreshInterval);
        }

        // Filter out empty complete actions
        result.actions = result.actions.filter((a: ActorAction) => {
          if (a.type === 'complete' && (!a.content || !a.content.trim())) return false;
          return true;
        });

        // Execute actions with session context
        const delegateActions = result.actions.filter((a: ActorAction) => a.type === 'delegate');
        if (delegateActions.length > 0) {
          const targetNames: string[] = [];
          for (const da of delegateActions) {
            if (da.targetActorId) {
              const targetResult = await query('SELECT name FROM actors WHERE id = $1', [da.targetActorId]);
              if (targetResult.rows[0]) targetNames.push(targetResult.rows[0].name);
            }
          }
          await emitThinkingStatus(targetNames.length > 0
            ? `Delegating to ${targetNames.join(', ')}...`
            : 'Delegating tasks...');
        } else if (result.actions.some((a: ActorAction) => a.type === 'respond')) {
          await emitThinkingStatus('Composing response...');
        }
        await executeActorActions(workspaceId, actorId, workItemId, result.actions, sessionId);

        // Save assistant response as session message (include tool call info in metadata)
        const respondActions = result.actions.filter((a: ActorAction) => a.type === 'respond');
        const msgMetadata: Record<string, unknown> = {};
        if (result.toolsUsed && result.toolsUsed.length > 0) {
          msgMetadata.toolsUsed = result.toolsUsed;
        }
        if (result.serverToolCalls && result.serverToolCalls.length > 0) {
          msgMetadata.serverToolCalls = result.serverToolCalls;
        }
        if (result.citationSources && Object.keys(result.citationSources).length > 0) {
          msgMetadata.citationSources = result.citationSources;
        }
        const hasMeta = Object.keys(msgMetadata).length > 0 ? msgMetadata : undefined;
        for (const action of respondActions) {
          await addSessionMessage({
            sessionId,
            workspaceId,
            role: 'assistant',
            content: action.content,
            fromActorId: actorId,
            metadata: hasMeta,
          });
          // Note: addSessionMessage already emits session.message.new
        }

        // Handle wait action
        const waitAction = result.actions.find((a: ActorAction) => a.type === 'wait');
        if (waitAction) {
          // Session enters waiting state — handled by orchestrator
          // No auto-complete
        } else {
          // Check for completion
          const pendingActionTypes = ['delegate', 'escalate', 'request_info', 'wait'];
          const hasPendingWork = result.actions.some((a: ActorAction) => pendingActionTypes.includes(a.type));
          const hasExplicitComplete = result.actions.some((a: ActorAction) => a.type === 'complete');

          if (!hasPendingWork && !hasExplicitComplete && workItemId) {
            // Auto-complete the work item
            await query(
              `UPDATE work_items SET status = 'completed', completed_at = NOW(), updated_at = NOW()
               WHERE id = $1 AND status IN ('created', 'assigned', 'accepted', 'in_progress')`,
              [workItemId]
            );
          }

          // If session has completed work (no pending), mark session as completed
          if (!hasPendingWork) {
            const resultContent = respondActions.map((a: ActorAction) => a.content).join('\n') ||
              result.actions.find((a: ActorAction) => a.type === 'complete')?.content || '';

            await updateSessionStatus(sessionId, 'completed');

            // Emit session.status.changed
            await emitEvent({
              type: 'session.status.changed',
              workspaceId,
              payload: { rootSessionId: rootSessionIdForEvents, sessionId, status: 'completed' },
              timestamp: nowISO(),
            });

            // Trigger cascade to parent session
            await onSessionCompleted(sessionId, resultContent, true);
          }
        }

        // Audit log
        await query(
          `INSERT INTO audit_logs (workspace_id, actor_id, action, resource_type, resource_id, details)
           VALUES ($1, $2, 'ai.think', 'session', $3, $4)`,
          [workspaceId, actorId, sessionId, JSON.stringify({
            trigger,
            tokensUsed: result.tokensUsed,
            actionsCount: result.actions.length,
            reasoning: result.reasoning,
          })]
        );

        // Emit action event
        await emitEvent({
          type: 'actor.action',
          workspaceId,
          payload: { actorId, sessionId, workItemId, actions: result.actions },
          timestamp: nowISO(),
        });

        return { success: true, actions: result.actions.length };

      } catch (err: any) {
        console.error(`[session-thinking] Session ${sessionId} failed:`, err.message);
        await updateSessionStatus(sessionId, 'failed', { errorMessage: err.message });

        // Emit session.status.changed for failure
        const failedSession = await getSession(sessionId);
        await emitEvent({
          type: 'session.status.changed',
          workspaceId,
          payload: { rootSessionId: failedSession?.root_session_id || sessionId, sessionId, status: 'failed' },
          timestamp: nowISO(),
        });

        await onSessionCompleted(sessionId, err.message, false);
        throw err;
      } finally {
        // Release session lock and decrement actor counter
        await redis.del(sessionLockKey);
        await redis.decr(actorSessionsKey);
      }
    },
    {
      connection: redis,
      concurrency: 10,
      limiter: { max: 20, duration: 60_000 },
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`Session thinking job ${job?.id} failed:`, err.message);
  });

  return worker;
}

async function getActorMaxSessions(actorId: string): Promise<number> {
  const result = await query(
    'SELECT max_concurrent_sessions FROM actors WHERE id = $1',
    [actorId]
  );
  return result.rows[0]?.max_concurrent_sessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
}
