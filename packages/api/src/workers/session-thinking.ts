import { Worker } from 'bullmq';
import { redis } from '../infrastructure/redis/index.js';
import { query } from '../infrastructure/database/index.js';
import { emitEvent } from '../infrastructure/events/index.js';
import {
  QUEUE_NAMES,
  SESSION_LOCK_TTL,
  REDIS_CHANNELS,
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  nowISO,
  textBlocks,
} from '@synapse/shared';
import type { ActorAction, GroupMemberEntry, ProviderContextWindow } from '@synapse/shared';
import type { CanonicalContextItem } from '@synapse/shared/types';
import { actorThink } from '../modules/ai/index.js';
import { buildActorPrompt } from '../modules/ai/prompt-builder.js';
import {
  buildGroupContextItems,
  buildSessionContextItems,
  conversationItemToContextItem,
} from '../modules/ai/context-builder.js';
import { buildProviderContextWindow } from '../modules/context/service.js';
import { executeActorActions } from '../modules/orchestrator/service.js';
import { resolveModelPlan } from '../modules/model-groups/resolver.js';
import { resolveMcpToolsForActor } from '../modules/mcp-plugins/tool-resolver.js';
import { shutdownSessionInstances } from '../modules/mcp-plugins/instance-manager.js';
import type { ResolvedMcpTools } from '../modules/mcp-plugins/tool-resolver.js';
import { getActor } from '../modules/organization/service.js';
import {
  getSession,
  getSessionMessages,
  updateSessionStatus,
  addSessionMessage,
  consumeInterrupts,
} from '../modules/session/service.js';
import { getGroupMembers, sleepActor } from '../modules/group/service.js';
import {
  attachPendingWakeupsToTurn,
  getPendingWakeupCount,
  getPendingWakeups,
  markTurnWakeupsDropped,
  markTurnWakeupsProcessed,
  publishSessionRuntime,
} from '../modules/session/runtime.js';
import {
  getConversationMember,
  getLastVisibleConversationItem,
  getContextConversationItemsForMember,
} from '../modules/conversation/service.js';
import { createTurn, updateTurnStatus } from '../modules/execution/service.js';
import { buildMemoryRecallQuery, recallMemories } from '../modules/memory/service.js';
import { listVisibleSkills } from '../modules/skills/service.js';
import { sessionThinkingQueue } from './queues.js';
import { registerWorker } from './registry.js';

type ThinkingPhase = 'thinking' | 'tool';

function deriveThinkingPhase(status: string): ThinkingPhase {
  const normalized = status.trim().toLowerCase();

  if (normalized.startsWith('searching ') || normalized.startsWith('fetching ')) {
    return 'tool';
  }

  if (normalized.startsWith('calling ') && normalized !== 'calling ai model...') {
    return 'tool';
  }

  return 'thinking';
}

async function loadNewContextItems(params: {
  groupId: string;
  memberId: string;
  actorId: string;
  sinceSequence: number;
}) {
  const visibleItems = await getContextConversationItemsForMember({
    conversationId: params.groupId,
    memberId: params.memberId,
    limit: 200,
  });

  const newItems = visibleItems.filter((item: any) => item.sequence > params.sinceSequence);
  const items: CanonicalContextItem[] = [];
  let maxSequence = params.sinceSequence;

  for (const item of newItems) {
    maxSequence = Math.max(maxSequence, item.sequence);
    if (item.author_actor_id === params.actorId) continue;
    const contextItem = conversationItemToContextItem(item, params.actorId);
    if (contextItem) {
      items.push(contextItem);
    }
  }

  return { items, maxSequence };
}

export function startSessionThinkingWorker() {
  const worker = new Worker(
    QUEUE_NAMES.SESSION_THINKING,
    async (job) => {
      const { sessionId, actorId, workspaceId, trigger, userId } = job.data;
      const sessionLockKey = `${REDIS_CHANNELS.SESSION_LOCK_PREFIX}${sessionId}`;
      const actorSessionsKey = `${REDIS_CHANNELS.ACTOR_SESSIONS_PREFIX}${actorId}`;

      const acquired = await redis.set(sessionLockKey, job.id!, 'PX', SESSION_LOCK_TTL, 'NX');
      if (!acquired) {
        console.log(`[session-thinking] Session ${sessionId} is already being processed, skipping`);
        return { success: false, reason: 'session locked' };
      }

      const currentCount = await redis.incr(actorSessionsKey);
      await redis.pexpire(actorSessionsKey, SESSION_LOCK_TTL * 2);

      const maxSessions = await getActorMaxSessions(actorId);
      if (currentCount > maxSessions) {
        await redis.decr(actorSessionsKey);
        await redis.del(sessionLockKey);
        throw new Error(`Actor ${actorId} concurrent limit (${maxSessions}) reached, will retry`);
      }

      let turn: any = null;
      let thinkingActorName = 'Unknown';
      let requeueAfterUnlock = false;
      let currentStatusText: string | undefined;
      let currentPhase: ThinkingPhase | 'error' = 'thinking';
      let mcpTools: ResolvedMcpTools = {
        tools: [],
        executor: async () => ({ content: [] }),
        mcpVersion: 0,
        refresh: async () => ({ tools: [], mcpVersion: 0 }),
        setTurnId: () => {},
        shutdown: async () => {},
      };

      try {
        let session = await getSession(sessionId);
        if (!session || session.status === 'closed') {
          console.log(`[session-thinking] Session ${sessionId} is ${session?.status ?? 'not found'}, skipping`);
          return { success: false, reason: 'session closed or missing' };
        }

        const pendingWakeupsAtStart = await getPendingWakeupCount(sessionId);
        if (pendingWakeupsAtStart === 0 && session.status !== 'running') {
          if (session.status !== 'idle') {
            await updateSessionStatus(sessionId, 'idle', { errorMessage: null });
          }
          await publishSessionRuntime(workspaceId, sessionId, {
            laneState: 'idle',
            health: 'ok',
            phase: 'idle',
          });
          return { success: true, reason: 'no pending wakeups' };
        }

        const previousStatus = session.status;
        if (session.status !== 'running') {
          await updateSessionStatus(sessionId, 'running', { errorMessage: null });
          await emitEvent({
            type: 'session.status.changed',
            workspaceId,
            payload: {
              groupId: session.group_id,
              sessionId,
              actorId,
              status: 'running',
              previousStatus,
            },
            timestamp: nowISO(),
          });
          session = await getSession(sessionId);
          if (!session) {
            return { success: false, reason: 'session disappeared after status update' };
          }
        }

        const groupId = session.group_id;

        await emitEvent({
          type: 'actor.thinking',
          workspaceId,
          payload: { actorId, sessionId, groupId },
          timestamp: nowISO(),
        });

        const emitThinkingStatus = async (status: string) => {
          currentStatusText = status;
          currentPhase = deriveThinkingPhase(status);
          const thinkingPayload = {
            groupId,
            sessionId,
            actorId,
            actorName: thinkingActorName || session.actor_name || 'Unknown',
            status,
            phase: currentPhase,
          };
          await publishSessionRuntime(workspaceId, sessionId, {
            laneState: 'running',
            health: 'ok',
            phase: currentPhase,
            statusText: status,
            currentTurnId: turn?.id,
          });
          await emitEvent({
            type: 'session.thinking',
            workspaceId,
            payload: thinkingPayload,
            timestamp: nowISO(),
          });
        };

        thinkingActorName = session.actor_name || 'Unknown';
        await emitThinkingStatus('Analyzing message...');

        const actor = await getActor(actorId, workspaceId);
        if (!actor) throw new Error(`Actor ${actorId} not found`);

        const sessionMessages = await getSessionMessages(sessionId);
        const interrupts = await consumeInterrupts(sessionId);
        const pendingWakeups = await getPendingWakeups(sessionId);
        if (pendingWakeups.length === 0) {
          await sleepActor(sessionId);
          return { success: true, reason: 'wakeup already handled' };
        }

        let groupMembers: any[] | undefined;
        let promptGroupMembers: any[] | undefined;
        let memberEntries: GroupMemberEntry[] = [];
        let groupUserId: string | undefined;
        let actorMemberId: string | undefined;
        let lastKnownGroupSequence = 0;
        let contextItems: CanonicalContextItem[];
        let contextWindow: ProviderContextWindow;
        if (groupId) {
          groupMembers = await getGroupMembers(groupId);
          promptGroupMembers = await getGroupMembers(groupId, { useProfileSnapshot: true });
          actorMemberId = groupMembers.find((member: any) => member.actor_id === actorId && member.state === 'active')?.id;
          if (!actorMemberId) {
            throw new Error(`Actor ${actorId} is not an active member of group ${groupId}`);
          }

          for (const member of groupMembers) {
            if (member.actor_id && member.actor_id !== actorId && member.state === 'active') {
              memberEntries.push({
                type: 'actor',
                id: member.actor_id,
                name: member.actor_name,
                title: member.actor_title,
              });
            } else if (member.user_id && member.state === 'active') {
              memberEntries.push({
                type: 'user',
                id: member.user_id,
                participantId: member.id,
                name: member.user_name || 'User',
              });
              if (!groupUserId) {
                groupUserId = member.user_id;
              }
            } else if (member.member_type === 'external' && member.state === 'active') {
              const linkedUserName =
                (member.linked_user_name as string | null) || undefined;
              memberEntries.push({
                type: 'external',
                id:
                  (member.linked_user_id as string | null) ||
                  (member.transport_external_id as string | null) ||
                  (member.id as string),
                participantId: member.id,
                name:
                  (member.transport_display_name as string | null) ||
                  (member.display_name as string | null) ||
                  linkedUserName ||
                  'External participant',
                title: linkedUserName
                  ? `Linked workspace user: ${linkedUserName}`
                  : 'External participant',
                linkedUserId:
                  (member.linked_user_id as string | null) || undefined,
                linkedUserName,
                externalUserKey:
                  (member.transport_external_id as string | null) || undefined,
              });
            }
          }

          const visibleItems = await getContextConversationItemsForMember({
            conversationId: groupId,
            memberId: actorMemberId,
            limit: 200,
          });
          const built = buildGroupContextItems({
            visibleItems,
            actorId,
            sessionMessages,
            interrupts: interrupts.length > 0 ? interrupts : undefined,
            wakeups: pendingWakeups,
          });
          contextItems = built.items;
          lastKnownGroupSequence = built.lastSequence;
        } else {
          contextItems = buildSessionContextItems(sessionMessages, {
            crossTurnToolHistory: false,
            interrupts: interrupts.length > 0 ? interrupts : undefined,
            wakeups: pendingWakeups,
          });
        }

        const recallType = session.metadata?.memoryBootstrapCompleted ? 'turn_recall' : 'bootstrap';
        const recallQuery = buildMemoryRecallQuery({
          actorName: actor.definition.name,
          conversationTitle: session.conversation_title,
          contextItems,
        });
        const recallResult = await recallMemories(workspaceId, {
          actorId,
          conversationId: session.conversation_id,
          recallType,
          queryText: recallQuery,
          queryBlocks: recallQuery ? textBlocks(recallQuery) : [],
          limit: 6,
          metadata: {
            sessionId,
            trigger,
          },
        });
        const recalledMemories = recallResult.memories;
        if (recalledMemories.length > 0) {
          contextItems = [
            {
              kind: 'memory_recall',
              scope: 'private',
              surface: 'internal',
              recallType,
              memories: recalledMemories,
              metadata: {
                recallRunId: recallResult.run.id,
              },
            },
            ...contextItems,
          ];
        }
        if (recallType === 'bootstrap' && !session.metadata?.memoryBootstrapCompleted) {
          await query(
            `UPDATE sessions
             SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
             WHERE id = $2`,
            [JSON.stringify({ memoryBootstrapCompleted: true }), sessionId],
          );
        }

        const resolvedModelPlan = await resolveModelPlan(actorId, workspaceId, {
          conversationId: session.conversation_id,
          userId: groupUserId || userId,
        });
        const primaryModel = resolvedModelPlan?.candidates[0] || null;
        let finalContextItems = contextItems;
        if (primaryModel?.crossTurnToolHistory && !groupId) {
          finalContextItems = buildSessionContextItems(sessionMessages, {
            crossTurnToolHistory: true,
            interrupts: interrupts.length > 0 ? interrupts : undefined,
            wakeups: pendingWakeups,
          });
          if (recalledMemories.length > 0) {
            finalContextItems = [
              {
                kind: 'memory_recall',
                scope: 'private',
                surface: 'internal',
                recallType,
                memories: recalledMemories,
                metadata: {
                  recallRunId: recallResult.run.id,
                },
              },
              ...finalContextItems,
            ];
          }
        }

        contextWindow = await buildProviderContextWindow({
          conversationId: session.conversation_id,
          sessionId,
          items: finalContextItems,
        });

        try {
          mcpTools = await resolveMcpToolsForActor({
            actorId,
            workspaceId,
            sessionId,
            conversationId: session.conversation_id,
            userId: groupUserId || userId,
          });
          if (mcpTools.tools.length > 0) {
            console.log(`[session-thinking] Resolved ${mcpTools.tools.length} MCP tools for actor ${actorId}`);
          }
        } catch (err: any) {
          console.error('[session-thinking] Failed to resolve MCP tools:', err.message);
        }

        const availableSkills = await listVisibleSkills({
          workspaceId,
          actorId,
          conversationId: session.conversation_id,
        });

        const actorPromptSource = (() => {
          if (!promptGroupMembers) return actor;
          const selfMember = promptGroupMembers.find(
            (member: any) => member.actor_id === actorId && member.state === 'active',
          );
          if (!selfMember) return actor;
          return {
            ...actor,
            currentVersion: selfMember.actor_current_version || actor.currentVersion,
            definition: {
              ...actor.definition,
              name: selfMember.actor_name || actor.definition.name,
              title: selfMember.actor_title || actor.definition.title,
              role: selfMember.actor_role || actor.definition.role,
              docs: selfMember.actor_docs || actor.definition.docs,
              canRepresentUser:
                typeof selfMember.actor_can_represent_user === 'boolean'
                  ? selfMember.actor_can_represent_user
                  : actor.definition.canRepresentUser,
              specialties: Array.isArray(selfMember.actor_specialties)
                ? selfMember.actor_specialties
                : actor.definition.specialties,
              config:
                selfMember.actor_config && typeof selfMember.actor_config === 'object'
                  ? selfMember.actor_config
                  : actor.definition.config,
            },
          };
        })();

        const { system } = buildActorPrompt(
          actorPromptSource,
          undefined,
          undefined,
          mcpTools.tools.length > 0 ? mcpTools.tools : undefined,
          promptGroupMembers || groupMembers,
          availableSkills,
        );

        turn = await createTurn({
          sessionId,
          conversationId: session.conversation_id,
          actorId,
          triggerType: pendingWakeups[0]!.sourceType,
          triggerItemId: pendingWakeups[0]!.sourceItemId,
          metadata: {
            triggerUserId: userId || groupUserId || null,
            wakeupIds: pendingWakeups.map((wakeup) => wakeup.wakeupId),
            wakeupCount: pendingWakeups.length,
          },
        });
        await attachPendingWakeupsToTurn(sessionId, turn.id);
        await publishSessionRuntime(workspaceId, sessionId, {
          laneState: 'running',
          health: 'ok',
          phase: currentPhase,
          statusText: currentStatusText,
          currentTurnId: turn.id,
        });

        const lockRefreshInterval = setInterval(async () => {
          try {
            await redis.pexpire(sessionLockKey, SESSION_LOCK_TTL);
          } catch {
            // ignore
          }
        }, Math.floor(SESSION_LOCK_TTL / 2));

        let result;
        const thinkStartSequence = lastKnownGroupSequence;

        try {
          await emitThinkingStatus('Calling AI model...');

          result = await actorThink(
            actor,
            contextWindow,
            undefined,
            resolvedModelPlan,
            workspaceId,
            {
              sessionId,
              turnId: turn.id,
              conversationId: session.conversation_id,
              groupId,
              groupMembers: memberEntries,
              userId: groupUserId || userId,
              availableSkills,
              onStatus: emitThinkingStatus,
              mcpTools: mcpTools.tools.length > 0 ? mcpTools.tools : undefined,
              mcpExecutor: mcpTools.executor,
              mcpVersion: mcpTools.mcpVersion,
              mcpRefresh: mcpTools.refresh,
              mcpSetTurnId: mcpTools.setTurnId,
              system,
              checkNewMessages: groupId && actorMemberId ? async () => {
                const update = await loadNewContextItems({
                  groupId,
                  memberId: actorMemberId!,
                  actorId,
                  sinceSequence: lastKnownGroupSequence,
                });
                lastKnownGroupSequence = update.maxSequence;
                if (update.items.length > 0) {
                  await attachPendingWakeupsToTurn(sessionId, turn.id);
                  await publishSessionRuntime(workspaceId, sessionId, {
                    laneState: 'running',
                    health: 'ok',
                    phase: currentPhase === 'error' ? 'thinking' : currentPhase,
                    statusText: currentStatusText,
                    currentTurnId: turn.id,
                  });
                }
                return update.items.length > 0 ? update.items : null;
              } : undefined,
            },
          );
        } finally {
          clearInterval(lockRefreshInterval);
        }

        await executeActorActions(workspaceId, actorId, result.actions, {
          sessionId,
          turnId: turn.id,
          userId: groupUserId || userId,
          conversationId: session.conversation_id,
        });

        const respondActions = result.actions.filter((action: ActorAction) => action.type === 'respond');
        const msgMetadata: Record<string, unknown> = {};
        if (result.toolsUsed && result.toolsUsed.length > 0) msgMetadata.toolsUsed = result.toolsUsed;
        if (result.serverToolCalls && result.serverToolCalls.length > 0) msgMetadata.serverToolCalls = result.serverToolCalls;
        if (result.citationSources && Object.keys(result.citationSources).length > 0) msgMetadata.citationSources = result.citationSources;
        if (result.toolHistory) msgMetadata.toolHistory = result.toolHistory;
        const hasMeta = Object.keys(msgMetadata).length > 0 ? msgMetadata : undefined;

        if (respondActions.length > 0) {
          await publishSessionRuntime(workspaceId, sessionId, {
            laneState: 'running',
            health: 'ok',
            phase: 'responding',
            statusText: 'Responding...',
            currentTurnId: turn.id,
          });
          for (const action of respondActions) {
            await addSessionMessage({
              sessionId,
              workspaceId,
              role: 'assistant',
              content: action.content,
              contentBlocks: action.contentBlocks ?? result.contentBlocks,
              fromActorId: actorId,
              metadata: hasMeta,
            });
          }
        } else if (result.reasoning) {
          await addSessionMessage({
            sessionId,
            workspaceId,
            role: 'assistant',
            content: result.reasoning,
            contentBlocks: result.contentBlocks,
            fromActorId: actorId,
            metadata: { ...hasMeta, reasoningOnly: true },
          });
        } else if (result.actions.length > 0) {
          const actionNames = result.actions.map((action: ActorAction) => action.type).join(', ');
          await addSessionMessage({
            sessionId,
            workspaceId,
            role: 'assistant',
            content: `[executed: ${actionNames}]`,
            fromActorId: actorId,
            metadata: { ...hasMeta, silentActions: true },
          });
        }
        await markTurnWakeupsProcessed(turn.id);
        await updateTurnStatus(turn.id, 'completed');

        await query(
          `INSERT INTO audit_logs (workspace_id, actor_id, action, resource_type, resource_id, details)
           VALUES ($1, $2, 'ai.think', 'session', $3, $4)`,
          [workspaceId, actorId, sessionId, JSON.stringify({
            trigger,
            tokensUsed: result.tokensUsed,
            actionsCount: result.actions.length,
            reasoning: result.reasoning,
            turnId: turn.id,
          })],
        );

        await emitEvent({
          type: 'actor.action',
          workspaceId,
          payload: { actorId, sessionId, groupId, actions: result.actions, turnId: turn.id },
          timestamp: nowISO(),
        });

        turn = null;
        const remainingPendingWakeups = await getPendingWakeupCount(sessionId);
        if (remainingPendingWakeups > 0) {
          requeueAfterUnlock = true;
          await updateSessionStatus(sessionId, 'queued', { errorMessage: null });
          await publishSessionRuntime(workspaceId, sessionId, {
            laneState: 'queued',
            health: 'ok',
            phase: 'idle',
            statusText: 'Queued follow-up messages',
          });
          await emitEvent({
            type: 'session.status.changed',
            workspaceId,
            payload: {
              groupId,
              sessionId,
              actorId,
              status: 'queued',
              previousStatus: 'running',
            },
            timestamp: nowISO(),
          });
        } else {
          await sleepActor(sessionId);
        }

        await mcpTools.shutdown().catch(() => {});
        return { success: true, actions: result.actions.length, requeued: requeueAfterUnlock };
      } catch (err: any) {
        console.error(`[session-thinking] Session ${sessionId} failed:`, err.message);
        const failedSession = await getSession(sessionId).catch(() => null);
        if (turn?.id) {
          await markTurnWakeupsDropped(turn.id).catch(() => {});
          await updateTurnStatus(turn.id, 'failed', { metadata: { errorMessage: err.message } }).catch(() => {});
        }

        await mcpTools.shutdown().catch(() => {});
        await shutdownSessionInstances(sessionId).catch(() => {});
        await updateSessionStatus(sessionId, 'blocked', { errorMessage: err.message });
        await publishSessionRuntime(workspaceId, sessionId, {
          laneState: 'blocked',
          health: 'error',
          phase: 'error',
          statusText: err.message || 'Unknown error',
          currentTurnId: turn?.id,
          lastError: {
            message: err.message || 'Unknown error',
            at: nowISO(),
          },
        }).catch(() => {});

        await emitEvent({
          type: 'session.status.changed',
          workspaceId,
          payload: {
            groupId: failedSession?.group_id,
            sessionId,
            actorId,
            actorName: thinkingActorName,
            status: 'blocked',
            phase: 'error',
            errorMessage: err.message || 'Unknown error',
          },
          timestamp: nowISO(),
        });

        throw err;
      } finally {
        await redis.del(sessionLockKey);
        await redis.decr(actorSessionsKey);
        if (requeueAfterUnlock) {
          await sessionThinkingQueue.add('think', {
            sessionId,
            actorId,
            workspaceId,
            trigger,
            userId,
          });
        }
      }
    },
    {
      connection: redis,
      concurrency: 10,
      limiter: { max: 20, duration: 60_000 },
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`Session thinking job ${job?.id} failed:`, err.message);
  });

  registerWorker(worker);
  return worker;
}

async function getActorMaxSessions(actorId: string): Promise<number> {
  const result = await query(
    `SELECT CASE
         WHEN COALESCE(config->>'maxConcurrentSessions', '') ~ '^[0-9]+$'
           THEN GREATEST((config->>'maxConcurrentSessions')::int, 1)
         ELSE $2
       END AS max_concurrent_sessions
     FROM actors
     WHERE id = $1`,
    [actorId, DEFAULT_MAX_CONCURRENT_SESSIONS],
  );
  return result.rows[0]?.max_concurrent_sessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
}
