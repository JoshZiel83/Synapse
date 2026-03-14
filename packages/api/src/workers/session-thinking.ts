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
import {
  getSession,
  getSessionMessages,
  updateSessionStatus,
  addSessionMessage,
  consumeInterrupts,
} from '../modules/session/service.js';
import { getGroupMembers, sleepActor, wakeActor } from '../modules/group/service.js';
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

      try {
        const session = await getSession(sessionId);
        if (!session || session.status !== 'active') {
          console.log(`[session-thinking] Session ${sessionId} is ${session?.status ?? 'not found'}, skipping`);
          return { success: false, reason: 'session not active' };
        }

        const groupId = session.group_id;

        await emitEvent({
          type: 'actor.thinking',
          workspaceId,
          payload: { actorId, sessionId, groupId },
          timestamp: nowISO(),
        });

        const thinkingActorResult = await query('SELECT name FROM actors WHERE id = $1', [actorId]);
        thinkingActorName = thinkingActorResult.rows[0]?.name || 'Unknown';

        const thinkingRedisKey = `thinking:${groupId || sessionId}`;
        const emitThinkingStatus = async (status: string) => {
          const thinkingPayload = {
            groupId,
            sessionId,
            actorId,
            actorName: thinkingActorName,
            status,
            phase: deriveThinkingPhase(status),
          };
          await redis.set(thinkingRedisKey, JSON.stringify(thinkingPayload), 'EX', 300);
          await emitEvent({
            type: 'session.thinking',
            workspaceId,
            payload: thinkingPayload,
            timestamp: nowISO(),
          });
        };

        await emitThinkingStatus('Analyzing message...');

        const actorResult = await query('SELECT * FROM actors WHERE id = $1', [actorId]);
        if (actorResult.rows.length === 0) throw new Error(`Actor ${actorId} not found`);
        const actor = actorResult.rows[0];

        const sessionMessages = await getSessionMessages(sessionId);
        const interrupts = await consumeInterrupts(sessionId);

        let groupMembers: any[] | undefined;
        let memberEntries: GroupMemberEntry[] = [];
        let groupUserId: string | undefined;
        let actorMemberId: string | undefined;
        let lastKnownGroupSequence = 0;
        let contextItems: CanonicalContextItem[];
        let contextWindow: ProviderContextWindow;

        if (groupId) {
          groupMembers = await getGroupMembers(groupId);
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
                name: member.user_name || 'User',
              });
              if (!groupUserId) {
                groupUserId = member.user_id;
              }
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
          });
          contextItems = built.items;
          lastKnownGroupSequence = built.lastSequence;
        } else {
          contextItems = buildSessionContextItems(sessionMessages, {
            crossTurnToolHistory: false,
            interrupts: interrupts.length > 0 ? interrupts : undefined,
          });
        }

        const recallType = session.metadata?.memoryBootstrapCompleted ? 'turn_recall' : 'bootstrap';
        const recallQuery = buildMemoryRecallQuery({
          actorName: actor.name,
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

        let mcpTools: ResolvedMcpTools = {
          tools: [],
          executor: async () => ({ content: [] }),
          mcpVersion: 0,
          refresh: async () => ({ tools: [], mcpVersion: 0 }),
          setTurnId: () => {},
        };
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

        const { system } = buildActorPrompt(
          actor,
          undefined,
          undefined,
          mcpTools.tools.length > 0 ? mcpTools.tools : undefined,
          groupMembers,
          availableSkills,
        );

        const triggerItem = groupId
          ? await getLastVisibleConversationItem(groupId)
          : null;
        turn = await createTurn({
          sessionId,
          conversationId: session.conversation_id,
          actorId,
          triggerType: trigger,
          triggerItemId: triggerItem?.id,
          metadata: { triggerUserId: userId || groupUserId || null },
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
                return update.items.length > 0 ? update.items : null;
              } : undefined,
            },
          );
        } finally {
          clearInterval(lockRefreshInterval);
        }

        await executeActorActions(workspaceId, actorId, result.actions, sessionId);
        await redis.del(thinkingRedisKey);

        const respondActions = result.actions.filter((action: ActorAction) => action.type === 'respond');
        const msgMetadata: Record<string, unknown> = {};
        if (result.toolsUsed && result.toolsUsed.length > 0) msgMetadata.toolsUsed = result.toolsUsed;
        if (result.serverToolCalls && result.serverToolCalls.length > 0) msgMetadata.serverToolCalls = result.serverToolCalls;
        if (result.citationSources && Object.keys(result.citationSources).length > 0) msgMetadata.citationSources = result.citationSources;
        if (result.toolHistory) msgMetadata.toolHistory = result.toolHistory;
        const hasMeta = Object.keys(msgMetadata).length > 0 ? msgMetadata : undefined;

        if (respondActions.length > 0) {
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

        const postThinkSession = await getSession(sessionId);
        if (postThinkSession?.status === 'sleeping') {
          if (groupId && actorMemberId) {
            const update = await loadNewContextItems({
              groupId,
              memberId: actorMemberId,
              actorId,
              sinceSequence: thinkStartSequence,
            });
            if (update.items.length > 0) {
              console.log(`[session-thinking] Session ${sessionId} has unprocessed messages after sleep — re-waking`);
              await wakeActor(groupId, actorId);
            } else {
              console.log(`[session-thinking] Session ${sessionId} entered sleeping state`);
            }
          }
        } else if (postThinkSession?.status === 'active') {
          await sleepActor(sessionId);
          if (groupId && actorMemberId) {
            const update = await loadNewContextItems({
              groupId,
              memberId: actorMemberId,
              actorId,
              sinceSequence: thinkStartSequence,
            });
            if (update.items.length > 0) {
              console.log(`[session-thinking] Session ${sessionId} has unprocessed messages after auto-sleep — re-waking`);
              await wakeActor(groupId, actorId);
            } else {
              console.log(`[session-thinking] Session ${sessionId} auto-slept`);
            }
          } else {
            console.log(`[session-thinking] Session ${sessionId} auto-slept`);
          }
        }

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

        return { success: true, actions: result.actions.length };
      } catch (err: any) {
        console.error(`[session-thinking] Session ${sessionId} failed:`, err.message);
        const failedSession = await getSession(sessionId).catch(() => null);
        await redis.del(`thinking:${failedSession?.group_id || sessionId}`).catch(() => {});
        await updateSessionStatus(sessionId, 'failed', { errorMessage: err.message });
        if (turn?.id) {
          await updateTurnStatus(turn.id, 'failed', { metadata: { errorMessage: err.message } }).catch(() => {});
        }

        await shutdownSessionInstances(sessionId).catch(() => {});

        await emitEvent({
          type: 'session.status.changed',
          workspaceId,
          payload: {
            groupId: failedSession?.group_id,
            sessionId,
            actorId,
            actorName: thinkingActorName,
            status: 'failed',
            phase: 'error',
            errorMessage: err.message || 'Unknown error',
          },
          timestamp: nowISO(),
        });

        throw err;
      } finally {
        await redis.del(sessionLockKey);
        await redis.decr(actorSessionsKey);
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
    'SELECT max_concurrent_sessions FROM actors WHERE id = $1',
    [actorId],
  );
  return result.rows[0]?.max_concurrent_sessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
}
