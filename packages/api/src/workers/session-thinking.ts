import { Worker } from 'bullmq';
import { redis } from '../infrastructure/redis/index.js';
import { query } from '../infrastructure/database/index.js';
import { emitEvent } from '../infrastructure/events/index.js';
import { QUEUE_NAMES, SESSION_LOCK_TTL, REDIS_CHANNELS, DEFAULT_MAX_CONCURRENT_SESSIONS, nowISO } from '@synapse/shared';
import type { ActorAction } from '@synapse/shared';
import { actorThink } from '../modules/ai/index.js';
import { buildActorPrompt } from '../modules/ai/prompt-builder.js';
import { buildConversationMessages } from '../modules/ai/message-builder.js';
import { executeActorActions } from '../modules/orchestrator/service.js';
import { resolveModelConfig } from '../modules/model-groups/resolver.js';
import { resolveMcpToolsForActor } from '../modules/mcp-plugins/tool-resolver.js';
import { shutdownSessionInstances } from '../modules/mcp-plugins/instance-manager.js';
import type { ResolvedMcpTools } from '../modules/mcp-plugins/tool-resolver.js';
import {
  getSession,
  getSessionMessages,
  updateSessionStatus,
  addSessionMessage,
  consumeInterrupts,
} from '../modules/session/service.js';
import { onSessionCompleted } from '../modules/session/completion.js';
import { sessionThinkingQueue } from './queues.js';

export function startSessionThinkingWorker() {
  const worker = new Worker(
    QUEUE_NAMES.SESSION_THINKING,
    async (job) => {
      const { sessionId, actorId, workspaceId, workItemId, trigger, userId } = job.data;
      const sessionLockKey = `${REDIS_CHANNELS.SESSION_LOCK_PREFIX}${sessionId}`;
      const actorSessionsKey = `${REDIS_CHANNELS.ACTOR_SESSIONS_PREFIX}${actorId}`;

      // 1. Acquire per-session lock
      const acquired = await redis.set(sessionLockKey, job.id!, 'PX', SESSION_LOCK_TTL, 'NX');
      if (!acquired) {
        // Another worker is already processing this session.
        // It will detect any new messages after finishing — safe to skip.
        console.log(`[session-thinking] Session ${sessionId} is already being processed, skipping`);
        return { success: false, reason: 'session locked, current worker will handle new messages' };
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

        const thinkingRedisKey = `thinking:${rootSessionIdForEvents}`;
        const emitThinkingStatus = async (status: string) => {
          const thinkingPayload = { rootSessionId: rootSessionIdForEvents, sessionId, actorId, actorName: thinkingActorName, status };
          // Persist in Redis so page reloads can recover it (5 min TTL safety net)
          await redis.set(thinkingRedisKey, JSON.stringify(thinkingPayload), 'EX', 300);
          await emitEvent({
            type: 'session.thinking',
            workspaceId,
            payload: thinkingPayload,
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

        // Extract last user attachments for multimodal handling
        let lastUserAttachments: { id: string; url: string; fullUrl?: string; storedName?: string; originalName: string; mimeType: string; sizeBytes: number }[] | undefined;
        for (const msg of sessionMessages) {
          if (msg.role === 'user') {
            lastUserAttachments = undefined;
            const meta = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : (msg.metadata || {});
            if (Array.isArray(meta.attachments) && meta.attachments.length > 0) {
              lastUserAttachments = meta.attachments;
            }
          }
        }

        // Check for interrupts
        const interrupts = await consumeInterrupts(sessionId);

        // Check memory version
        let memoryNotice: string | undefined;
        const lastSeenMemoryVersion = session.metadata?.lastSeenMemoryVersion ?? actor.memory_version;
        if (actor.memory_version > lastSeenMemoryVersion) {
          const newMemories = await query(
            `SELECT content, category FROM memories
             WHERE actor_id = $1 AND workspace_id = $2
             ORDER BY created_at DESC LIMIT 5`,
            [actorId, workspaceId]
          );
          if (newMemories.rows.length > 0) {
            memoryNotice = '[System Notice] Your memories have been updated by another concurrent task:\n';
            for (const mem of newMemories.rows) {
              memoryNotice += `- [${mem.category}]: ${mem.content}\n`;
            }
          }
          await query(
            `UPDATE sessions SET metadata = metadata || $1::jsonb WHERE id = $2`,
            [JSON.stringify({ lastSeenMemoryVersion: actor.memory_version }), sessionId]
          );
        }

        // Build structured conversation messages
        const conversationMessages = buildConversationMessages(sessionMessages, {
          crossTurnToolHistory: false, // will be enabled per resolvedConfig
          interrupts: interrupts.length > 0 ? interrupts : undefined,
          resumeTrigger: trigger === 'resume',
          memoryNotice,
        });

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

        // If cross-turn tool history is enabled, rebuild conversation messages with it
        let finalConversationMessages = conversationMessages;
        if (resolvedConfig?.crossTurnToolHistory) {
          finalConversationMessages = buildConversationMessages(sessionMessages, {
            crossTurnToolHistory: true,
            interrupts: interrupts.length > 0 ? interrupts : undefined,
            resumeTrigger: trigger === 'resume',
            memoryNotice,
          });
        }

        // Resolve MCP plugin tools for this actor session
        let mcpTools: ResolvedMcpTools = { tools: [], executor: async () => '', mcpVersion: 0, refresh: async () => ({ tools: [], mcpVersion: 0 }), setTurnId: () => {} };
        try {
          mcpTools = await resolveMcpToolsForActor({ actorId, workspaceId, sessionId, userId });
          if (mcpTools.tools.length > 0) {
            console.log(`[session-thinking] Resolved ${mcpTools.tools.length} MCP tools for actor ${actorId}`);
          }
        } catch (err: any) {
          console.error(`[session-thinking] Failed to resolve MCP tools:`, err.message);
        }

        // Build system prompt (no longer includes messages)
        const { system } = buildActorPrompt(
          actor,
          memoriesResult.rows,
          subordinatesResult.rows.length > 0 ? subordinatesResult.rows : undefined,
          undefined,
          mcpTools.tools.length > 0 ? mcpTools.tools : undefined,
        );

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
            finalConversationMessages,
            subordinatesResult.rows.length > 0 ? subordinatesResult.rows : undefined,
            resolvedConfig,
            workspaceId,
            {
              sessionId,
              onStatus: emitThinkingStatus,
              extraTools: mcpTools.tools.length > 0 ? mcpTools.tools : undefined,
              extraToolExecutor: mcpTools.executor,
              mcpVersion: mcpTools.mcpVersion,
              mcpRefresh: mcpTools.refresh,
              mcpSetTurnId: mcpTools.setTurnId,
              attachments: lastUserAttachments,
              system,
            },
          );
        } finally {
          clearInterval(lockRefreshInterval);
          // Session-scoped MCP instances now use TTL-based cleanup (30 min)
          // instead of immediate shutdown, so they persist across conversation rounds.
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

        // Clear thinking state — this round is done
        await redis.del(thinkingRedisKey);

        // Save assistant response as session message (include tool call info + media in metadata)
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
        if (result.toolHistory) {
          msgMetadata.toolHistory = result.toolHistory;
        }
        if (result.mediaAttachments && result.mediaAttachments.length > 0) {
          msgMetadata.attachments = result.mediaAttachments;
        }
        const hasMeta = Object.keys(msgMetadata).length > 0 ? msgMetadata : undefined;
        if (respondActions.length > 0) {
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
        } else if (result.actions.length > 0) {
          // No respond actions but actions were executed (e.g. rename_self only).
          // Write a minimal assistant marker so the "new user messages" check works correctly.
          const actionNames = result.actions.map((a: ActorAction) => a.type).join(', ');
          await addSessionMessage({
            sessionId,
            workspaceId,
            role: 'assistant',
            content: `[executed: ${actionNames}]`,
            fromActorId: actorId,
            metadata: { ...hasMeta, silentActions: true },
          });
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
            // Check for new user messages that arrived while AI was processing
            const latestMessages = await getSessionMessages(sessionId);
            const lastAssistantMsg = [...latestMessages].reverse().find(m => m.role === 'assistant');
            const lastAssistantTime = lastAssistantMsg ? new Date(lastAssistantMsg.created_at) : new Date(0);
            const hasNewUserMsgs = latestMessages.some(
              m => m.role === 'user' && new Date(m.created_at) > lastAssistantTime
            );

            if (hasNewUserMsgs) {
              // New user messages arrived during processing — re-enqueue
              await sessionThinkingQueue.add('think', {
                sessionId, actorId, workspaceId, workItemId, trigger: 'user_message', userId,
              });

              // Audit log for the completed round
              await query(
                `INSERT INTO audit_logs (workspace_id, actor_id, action, resource_type, resource_id, details)
                 VALUES ($1, $2, 'ai.think', 'session', $3, $4)`,
                [workspaceId, actorId, sessionId, JSON.stringify({
                  trigger,
                  tokensUsed: result.tokensUsed,
                  actionsCount: result.actions.length,
                  reasoning: result.reasoning,
                  requeued: true,
                })]
              );

              await emitEvent({
                type: 'actor.action',
                workspaceId,
                payload: { actorId, sessionId, workItemId, actions: result.actions },
                timestamp: nowISO(),
              });

              return { success: true, actions: result.actions.length, requeued: true };
            }

            const resultContent = respondActions.map((a: ActorAction) => a.content).join('\n') ||
              result.actions.find((a: ActorAction) => a.type === 'complete')?.content || '';

            await updateSessionStatus(sessionId, 'completed');

            // Final safety check: a message could have arrived between our
            // first check and the status flip to 'completed'. At that moment
            // sendMessageToGroup would have seen status='active' and enqueued
            // a job, but that job will skip (lock still held by us). So we do
            // one last check while we still hold the lock.
            const finalMessages = await getSessionMessages(sessionId);
            const finalLastAssistant = [...finalMessages].reverse().find(m => m.role === 'assistant');
            const finalAssistantTime = finalLastAssistant ? new Date(finalLastAssistant.created_at) : new Date(0);
            const hasLateUserMsgs = finalMessages.some(
              m => m.role === 'user' && new Date(m.created_at) > finalAssistantTime
            );

            if (hasLateUserMsgs) {
              // Re-activate and enqueue — message arrived in the gap
              await updateSessionStatus(sessionId, 'active');
              await sessionThinkingQueue.add('think', {
                sessionId, actorId, workspaceId, workItemId, trigger: 'user_message', userId,
              });

              await query(
                `INSERT INTO audit_logs (workspace_id, actor_id, action, resource_type, resource_id, details)
                 VALUES ($1, $2, 'ai.think', 'session', $3, $4)`,
                [workspaceId, actorId, sessionId, JSON.stringify({
                  trigger,
                  tokensUsed: result.tokensUsed,
                  actionsCount: result.actions.length,
                  reasoning: result.reasoning,
                  requeued: true,
                  requeueReason: 'late_message_after_completion',
                })]
              );

              await emitEvent({
                type: 'actor.action',
                workspaceId,
                payload: { actorId, sessionId, workItemId, actions: result.actions },
                timestamp: nowISO(),
              });

              return { success: true, actions: result.actions.length, requeued: true };
            }

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
        // Clear thinking state from Redis on failure (best-effort: try both session and root keys)
        const failedSess = await getSession(sessionId).catch(() => null);
        const failRootId = failedSess?.root_session_id || sessionId;
        await redis.del(`thinking:${failRootId}`).catch(() => {});
        await updateSessionStatus(sessionId, 'failed', { errorMessage: err.message });

        // Cleanup session-scoped MCP instances on failure
        await shutdownSessionInstances(sessionId).catch(() => {});

        // Emit session.status.changed for failure
        const failedSession = await getSession(sessionId);
        await emitEvent({
          type: 'session.status.changed',
          workspaceId,
          payload: {
            rootSessionId: failedSession?.root_session_id || sessionId,
            sessionId,
            status: 'failed',
            errorMessage: err.message || 'Unknown error',
          },
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
