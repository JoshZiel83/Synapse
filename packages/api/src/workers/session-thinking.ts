import { Worker } from 'bullmq';
import { redis } from '../infrastructure/redis/index.js';
import { db, type TableInsert } from '../infrastructure/database/kysely.js';
import { emitEvent } from '../infrastructure/events/index.js';
import {
  QUEUE_NAMES,
  SESSION_LOCK_TTL,
  REDIS_CHANNELS,
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  isThreadConversationKind,
  nowISO,
  textBlocks,
} from '@synapse/shared';
import { isPlanCollaborationMode } from '@synapse/shared/utils';
import type {
  ConversationParticipantEntry,
  ProviderContextManifest,
  ProviderContextWindow,
} from '@synapse/shared';
import type { CanonicalContextItem } from '@synapse/shared/types';
import { actorThink } from '../modules/ai/index.js';
import { buildActorPrompt } from '../modules/ai/prompt-builder.js';
import {
  buildConversationContextItems,
  buildSessionContextItems,
  conversationItemToContextItem,
} from '../modules/ai/context-builder.js';
import { buildProviderContextWindow } from '../modules/context/service.js';
import { executeActorActions } from '../modules/orchestrator/service.js';
import { resolveModelPlan } from '../modules/model-groups/resolver.js';
import { shutdownSessionInstances } from '../modules/mcp-plugins/instance-manager.js';
import { getActor } from '../modules/organization/service.js';
import {
  getSession,
  getSessionMessages,
  updateSessionStatus,
  addSessionMessage,
  consumeInterrupts,
  hasPendingInterrupt,
} from '../modules/session/service.js';
import {
  getConversationParticipant,
  getContextConversationItemsForParticipant,
  listConversationParticipants,
} from '../modules/chat/service.js';
import {
  attachPendingWakeupsToTurn,
  getPendingWakeupCount,
  getPendingWakeups,
  markTurnWakeupsDropped,
  markTurnWakeupsProcessed,
  publishSessionRuntime,
} from '../modules/session/runtime.js';
import { createTurn, updateTurnStatus } from '../modules/execution/service.js';
import { buildMemoryRecallQuery, recallMemories } from '../modules/memory/service.js';
import { resolveActorCapabilitySurface } from '../modules/capabilities/surface.js';
import { sessionThinkingQueue } from './queues.js';
import { registerWorker } from './registry.js';
import { getAssistantSessionMessagePersistence } from './session-message-persistence.js';
import { sql } from 'kysely';

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

async function runCleanupStep(label: string, operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (err: any) {
    console.error(
      `[session-thinking] Cleanup step failed for ${label}:`,
      err?.message || String(err),
    );
  }
}

async function loadNewContextItems(params: {
  conversationId: string;
  participantId: string;
  actorId: string;
  sinceSequence: number;
}) {
  const visibleItems = await getContextConversationItemsForParticipant({
    conversationId: params.conversationId,
    participantId: params.participantId,
    limit: 200,
  });

  const newItems = visibleItems.filter((item: any) => item.sequence > params.sinceSequence);
  const items: CanonicalContextItem[] = [];
  let maxSequence = params.sinceSequence;

  for (const item of newItems) {
    maxSequence = Math.max(maxSequence, item.sequence);
    if (item.authorParticipant?.actor_id === params.actorId) continue;
    const contextItem = conversationItemToContextItem(item, params.actorId);
    if (contextItem) {
      items.push(contextItem);
    }
  }

  return { items, maxSequence };
}

async function putSessionToIdle(sessionId: string) {
  const session = await getSession(sessionId);
  if (!session || session.status !== 'running') {
    return;
  }

  await updateSessionStatus(sessionId, 'idle', { errorMessage: null });
  await publishSessionRuntime(session.workspace_id, sessionId, {
    laneState: 'idle',
    phase: 'idle',
  });

  await emitEvent({
    type: 'session.status.changed',
    workspaceId: session.workspace_id,
    payload: {
      conversationId: session.conversation_id,
      sessionId,
      actorId: session.actor_id,
      status: 'idle',
      previousStatus: 'running',
    },
    timestamp: nowISO(),
  });
}

function isTurnInterruptedError(error: unknown) {
  return error instanceof Error && error.name === 'TurnInterruptedError';
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
      let requeueTrigger = trigger;
      let currentStatusText: string | undefined;
      let currentPhase: ThinkingPhase | 'error' = 'thinking';
      let threadConversationId: string | undefined;
      let pendingWakeups: Awaited<ReturnType<typeof getPendingWakeups>> = [];
      let availableSkills: Awaited<ReturnType<typeof resolveActorCapabilitySurface>>["availableSkills"] = [];
      let mcpTools: Awaited<ReturnType<typeof resolveActorCapabilitySurface>>["mcpTools"] = {
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
          const conversationId =
            isThreadConversationKind(session.conversation_kind)
              ? session.conversation_id
              : undefined;
          await updateSessionStatus(sessionId, 'running', { errorMessage: null });
          await emitEvent({
            type: 'session.status.changed',
            workspaceId,
            payload: {
              conversationId,
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
        const conversationId =
          isThreadConversationKind(session.conversation_kind)
            ? session.conversation_id
            : undefined;
        threadConversationId = conversationId;

        await emitEvent({
          type: 'actor.thinking',
          workspaceId,
          payload: { actorId, sessionId, conversationId },
          timestamp: nowISO(),
        });

        const emitThinkingStatus = async (status: string) => {
          currentStatusText = status;
          currentPhase = deriveThinkingPhase(status);
          const thinkingPayload = {
            conversationId,
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
            activeTurnId: turn?.id,
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
        pendingWakeups = await getPendingWakeups(sessionId);
        if (pendingWakeups.length === 0) {
          await putSessionToIdle(sessionId);
          return { success: true, reason: 'wakeup already handled' };
        }

        let conversationParticipants: any[] | undefined;
        let promptConversationParticipants: any[] | undefined;
        let participantEntries: ConversationParticipantEntry[] = [];
        let contextManifest: ProviderContextManifest | undefined;
        let actorParticipantId: string | undefined;
        let lastKnownConversationSequence = 0;
        let contextItems: CanonicalContextItem[];
        let contextWindow: ProviderContextWindow;
        if (conversationId) {
          conversationParticipants = await listConversationParticipants(conversationId);
          promptConversationParticipants = await listConversationParticipants(
            conversationId,
            {
              useProfileSnapshot: true,
            },
          );
          actorParticipantId = conversationParticipants.find((member: any) => member.actor_id === actorId && member.state === 'active')?.id;
          if (!actorParticipantId) {
            throw new Error(
              `Actor ${actorId} is not an active participant of conversation ${conversationId}`,
            );
          }
          const selfParticipant = conversationParticipants.find(
            (member: any) =>
              member.actor_id === actorId && member.state === 'active',
          );
          if (selfParticipant) {
            participantEntries.push({
              type: 'actor',
              id: actorId,
              participantId: selfParticipant.id,
              name: selfParticipant.actor_name || session.actor_name || 'Unknown actor',
              title: selfParticipant.actor_title || selfParticipant.actor_role || 'Actor',
              role: selfParticipant.actor_role || undefined,
            });
          }

          for (const member of conversationParticipants) {
            if (member.actor_id && member.actor_id !== actorId && member.state === 'active') {
              participantEntries.push({
                type: 'actor',
                id: member.actor_id,
                participantId: member.id,
                name: member.actor_name,
                title: member.actor_title,
                role: member.actor_role || undefined,
              });
            } else if (member.user_id && member.state === 'active') {
              const workspaceMemberId =
                typeof member.workspace_member_id === 'string' &&
                member.workspace_member_id.trim().length > 0
                  ? member.workspace_member_id
                  : null;
              if (!workspaceMemberId) {
                throw new Error(
                  `Conversation ${conversationId} has workspace participant ${member.id} without workspace_member_id`,
                );
              }
              participantEntries.push({
                type: 'workspace_member',
                id: workspaceMemberId,
                participantId: member.id,
                name: member.user_name || 'User',
                role: 'Workspace member',
              });
            } else if (member.participant_kind === 'external' && member.state === 'active') {
              const linkedUserName =
                (member.linked_user_name as string | null) || undefined;
              participantEntries.push({
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
                role: 'External participant',
                linkedWorkspaceMemberId:
                  (member.linked_user_id as string | null) || undefined,
                linkedWorkspaceMemberName: linkedUserName,
                externalUserKey:
                  (member.transport_external_id as string | null) || undefined,
              });
            }
          }
          contextManifest = {
            conversationId,
            conversationKind: session.conversation_kind,
            conversationBoundary:
              session.conversationBoundary || session.conversation_boundary,
            selfParticipantId: actorParticipantId,
            selfActorId: actorId,
            participants: participantEntries,
          };

          const visibleItems = await getContextConversationItemsForParticipant({
            conversationId,
            participantId: actorParticipantId,
            limit: 200,
          });
          const built = buildConversationContextItems({
            visibleItems,
            actorId,
            sessionMessages,
            interrupts: interrupts.length > 0 ? interrupts : undefined,
            wakeups: pendingWakeups,
          });
          contextItems = built.items;
          lastKnownConversationSequence = built.lastSequence;
        } else {
          contextItems = buildSessionContextItems(sessionMessages, {
            crossTurnToolHistory: false,
            interrupts: interrupts.length > 0 ? interrupts : undefined,
            wakeups: pendingWakeups,
          });
        }

        const recallType = session.memory_bootstrap_completed ? 'turn_recall' : 'bootstrap';
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
        if (recallType === 'bootstrap' && !session.memory_bootstrap_completed) {
          await db
            .updateTable('sessions')
            .set({
              memory_bootstrap_completed: true,
            })
            .where('id', '=', sessionId)
            .execute();
        }

        const resolvedModelPlan = await resolveModelPlan(actorId, workspaceId, {
          conversationId: session.conversation_id,
        });
        const primaryModel = resolvedModelPlan?.candidates[0] || null;
        let finalContextItems = contextItems;
        if (primaryModel?.crossTurnToolHistory && !conversationId) {
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
          manifest: contextManifest,
        });

        const capabilitySurface = await resolveActorCapabilitySurface({
          workspaceId,
          actorId,
          sessionId,
          conversationId: session.conversation_id,
          conversationKind: session.conversation_kind,
          conversationBoundary:
            session.conversationBoundary || session.conversation_boundary,
          userId,
        });
        availableSkills = capabilitySurface.availableSkills;
        mcpTools = capabilitySurface.mcpTools;
        if (mcpTools.tools.length > 0) {
          console.log(`[session-thinking] Resolved ${mcpTools.tools.length} MCP tools for actor ${actorId}`);
        }

        const actorPromptSource = (() => {
          if (!promptConversationParticipants) return actor;
          const selfMember = promptConversationParticipants.find(
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

        const buildSystemPrompt = (currentSession: any) =>
          buildActorPrompt(
            actorPromptSource,
            undefined,
            undefined,
            isPlanCollaborationMode(
              currentSession.collaborationMode ||
                currentSession.collaboration_mode ||
                'default',
            )
              ? undefined
              : mcpTools.tools.length > 0
                ? mcpTools.tools
                : undefined,
            promptConversationParticipants || conversationParticipants,
            currentSession.conversation_kind,
            availableSkills,
            currentSession.collaborationMode ||
              currentSession.collaboration_mode ||
              'default',
          ).system;

        const system = buildSystemPrompt(session);

        turn = await createTurn({
          sessionId,
          conversationId: session.conversation_id,
          actorId,
          triggerType: pendingWakeups[0]!.sourceType,
          triggerItemId: pendingWakeups[0]!.sourceItemId,
          metadata: {
            triggerUserId: userId || null,
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
          activeTurnId: turn.id,
        });

        const lockRefreshInterval = setInterval(async () => {
          try {
            await redis.pexpire(sessionLockKey, SESSION_LOCK_TTL);
          } catch {
            // ignore
          }
        }, Math.floor(SESSION_LOCK_TTL / 2));

        let result;

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
              collaborationMode:
                session.collaborationMode ||
                session.collaboration_mode ||
                'default',
              conversationId: session.conversation_id,
              conversationKind: session.conversation_kind,
              conversationBoundary:
                session.conversationBoundary || session.conversation_boundary,
              conversationParticipants: participantEntries,
              userId,
              availableSkills,
              onStatus: emitThinkingStatus,
              mcpTools: mcpTools.tools.length > 0 ? mcpTools.tools : undefined,
              mcpExecutor: mcpTools.executor,
              mcpVersion: mcpTools.mcpVersion,
              mcpRefresh: mcpTools.refresh,
              mcpSetTurnId: mcpTools.setTurnId,
              shouldAbortTurn: () =>
                hasPendingInterrupt(sessionId, 'remote_control_terminated'),
              system,
              refreshCollaborationContext: async () => {
                const refreshedSession = await getSession(sessionId);
                if (refreshedSession) {
                  session = refreshedSession;
                }
                return {
                  collaborationMode:
                    session?.collaborationMode ||
                    session?.collaboration_mode ||
                    'default',
                  system: session ? buildSystemPrompt(session) : system,
                };
              },
              checkNewMessages: conversationId && actorParticipantId ? async () => {
                const update = await loadNewContextItems({
                  conversationId,
                  participantId: actorParticipantId!,
                  actorId,
                  sinceSequence: lastKnownConversationSequence,
                });
                lastKnownConversationSequence = update.maxSequence;
                if (update.items.length > 0) {
                  await attachPendingWakeupsToTurn(sessionId, turn.id);
                  await publishSessionRuntime(workspaceId, sessionId, {
                    laneState: 'running',
                    health: 'ok',
                    phase: currentPhase === 'error' ? 'thinking' : currentPhase,
                    statusText: currentStatusText,
                    activeTurnId: turn.id,
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
          userId,
          conversationId: session.conversation_id,
        });

        const msgMetadata: Record<string, unknown> = {};
        if (result.toolsUsed && result.toolsUsed.length > 0) msgMetadata.toolsUsed = result.toolsUsed;
        if (result.serverToolCalls && result.serverToolCalls.length > 0) msgMetadata.serverToolCalls = result.serverToolCalls;
        if (result.citationSources && Object.keys(result.citationSources).length > 0) msgMetadata.citationSources = result.citationSources;
        if (result.toolHistory) msgMetadata.toolHistory = result.toolHistory;
        const hasMeta = Object.keys(msgMetadata).length > 0 ? msgMetadata : undefined;
        const messagePersistence = getAssistantSessionMessagePersistence(result);

        if (messagePersistence.kind === 'respond') {
          await publishSessionRuntime(workspaceId, sessionId, {
            laneState: 'running',
            health: 'ok',
            phase: 'responding',
            statusText: 'Responding...',
            activeTurnId: turn.id,
          });
          for (const action of messagePersistence.actions) {
            await addSessionMessage({
              sessionId,
              workspaceId,
              role: 'assistant',
              contentBlocks:
                action.contentBlocks && action.contentBlocks.length > 0
                  ? action.contentBlocks
                  : textBlocks(action.content),
              fromActorId: actorId,
              metadata: hasMeta,
            });
          }
        } else if (messagePersistence.kind === 'silent_actions') {
          const actionNames = messagePersistence.actionNames.join(', ');
          await addSessionMessage({
            sessionId,
            workspaceId,
            role: 'assistant',
            contentBlocks: textBlocks(`[executed: ${actionNames}]`),
            fromActorId: actorId,
            metadata: { ...hasMeta, silentActions: true },
          });
        }
        await markTurnWakeupsProcessed(turn.id);
        await updateTurnStatus(turn.id, 'completed');

        await db
          .insertInto('audit_logs')
          .values({
            workspace_id: workspaceId,
            actor_id: actorId,
            action: 'ai.think',
            resource_type: 'session',
            resource_id: sessionId,
            details: {
              trigger,
              tokensUsed: result.tokensUsed,
              actionsCount: result.actions.length,
              reasoning: result.reasoning,
              turnId: turn.id,
            } as TableInsert<'audit_logs'>['details'],
          })
          .execute();

        await emitEvent({
          type: 'actor.action',
          workspaceId,
          payload: {
            actorId,
            sessionId,
            conversationId,
            actions: result.actions,
            turnId: turn.id,
          },
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
              conversationId,
              sessionId,
              actorId,
              status: 'queued',
              previousStatus: 'running',
            },
            timestamp: nowISO(),
          });
        } else {
          await putSessionToIdle(sessionId);
        }

        await mcpTools.shutdown().catch(() => {});
        return { success: true, actions: result.actions.length, requeued: requeueAfterUnlock };
      } catch (err: any) {
        const errorMessage = err?.message || 'Unknown error';
        const turnInterrupted = isTurnInterruptedError(err);
        if (!turnInterrupted) {
          console.error(`[session-thinking] Session ${sessionId} failed:`, errorMessage);
        }
        const failedSession = await getSession(sessionId).catch(() => null);

        if (turn?.id) {
          await runCleanupStep(`drop wakeups for turn ${turn.id}`, () => markTurnWakeupsDropped(turn.id));
          await runCleanupStep(
            `mark turn ${turn.id} ${turnInterrupted ? 'cancelled' : 'failed'}`,
            () => updateTurnStatus(
              turn.id,
              turnInterrupted ? 'cancelled' : 'failed',
              { metadata: { errorMessage } },
            ),
          );
        }

        if (turnInterrupted) {
          const remainingPendingWakeups = await getPendingWakeupCount(sessionId).catch(() => 0);
          if (remainingPendingWakeups > 0) {
            requeueAfterUnlock = true;
            requeueTrigger = 'system_interrupt';
            await runCleanupStep(`mark session ${sessionId} queued`, () => updateSessionStatus(
              sessionId,
              'queued',
              { errorMessage: null },
            ));
            await runCleanupStep(`publish queued runtime for session ${sessionId}`, () => publishSessionRuntime(
              workspaceId,
              sessionId,
              {
                laneState: 'queued',
                health: 'ok',
                phase: 'idle',
                statusText: 'Queued follow-up messages',
              },
            ));
            await runCleanupStep(`emit queued event for session ${sessionId}`, () => emitEvent({
              type: 'session.status.changed',
              workspaceId,
              payload: {
                conversationId:
                  threadConversationId
                  || (isThreadConversationKind(failedSession?.conversation_kind)
                    ? failedSession.conversation_id
                    : undefined),
                sessionId,
                actorId,
                actorName: thinkingActorName,
                status: 'queued',
                previousStatus: 'running',
              },
              timestamp: nowISO(),
            }));
          } else {
            await runCleanupStep(`put session ${sessionId} idle`, () => putSessionToIdle(sessionId));
          }

          await runCleanupStep(`shutdown MCP tools for session ${sessionId}`, () => mcpTools.shutdown());
          return { success: true, reason: 'turn interrupted', requeued: requeueAfterUnlock };
        }

        await runCleanupStep(`mark session ${sessionId} blocked`, () => updateSessionStatus(
          sessionId,
          'blocked',
          { errorMessage },
        ));
        await runCleanupStep(`publish blocked runtime for session ${sessionId}`, () => publishSessionRuntime(workspaceId, sessionId, {
          laneState: 'blocked',
          health: 'error',
          phase: 'error',
          statusText: errorMessage,
          activeTurnId: turn?.id,
          lastError: {
            message: errorMessage,
            at: nowISO(),
          },
        }));
        await runCleanupStep(`emit blocked event for session ${sessionId}`, () => emitEvent({
          type: 'session.status.changed',
          workspaceId,
          payload: {
            conversationId:
              threadConversationId
              || (isThreadConversationKind(failedSession?.conversation_kind)
                ? failedSession.conversation_id
                : undefined),
            sessionId,
            actorId,
            actorName: thinkingActorName,
            status: 'blocked',
            phase: 'error',
            errorMessage,
          },
          timestamp: nowISO(),
        }));
        await runCleanupStep(`shutdown MCP tools for session ${sessionId}`, () => mcpTools.shutdown());
        await runCleanupStep(`shutdown MCP instances for session ${sessionId}`, () => shutdownSessionInstances(sessionId));

        const wakeupTargets = pendingWakeups.filter(
          (wakeup) =>
            (wakeup.sourceParticipantType === 'workspace_member' ||
              wakeup.sourceParticipantType === 'external') &&
            wakeup.sourceParticipantId,
        );

        if (failedSession?.conversation_id && wakeupTargets.length > 0) {
          await runCleanupStep(`publish model error notice for session ${sessionId}`, async () => {
            const targetParticipants = await Promise.all(
              wakeupTargets.map(async (wakeup) => {
                if (wakeup.sourceParticipantType === 'workspace_member') {
                  return getConversationParticipant({
                    conversationId: failedSession.conversation_id,
                    workspaceMemberId: wakeup.sourceParticipantId as string,
                  });
                }

                return getConversationParticipant({
                  conversationId: failedSession.conversation_id,
                  participantId: wakeup.sourceParticipantId as string,
                });
              }),
            );
            const restrictedAudienceParticipantIds = [...new Set(
              targetParticipants
                .map((participant: any) => participant?.id as string | undefined)
                .filter((participantId): participantId is string => Boolean(participantId)),
            )];

            if (restrictedAudienceParticipantIds.length === 0) {
              return;
            }

            await addSessionMessage({
              sessionId,
              workspaceId,
              role: 'assistant',
              subtype: 'model_error_notice',
              visibility: 'shared_visible',
              contentBlocks: textBlocks('出错了'),
              fromActorId: actorId,
              restrictedAudienceParticipantIds,
              projectTransportOutbound: true,
              metadata: {
                excludeFromContext: true,
                retrySessionId: sessionId,
                retryTurnId: turn?.id,
                notificationType: 'model_error',
                errorMessage,
              },
            });
          });
        }

        throw err;
      } finally {
        await redis.del(sessionLockKey);
        await redis.decr(actorSessionsKey);
        if (requeueAfterUnlock) {
          await sessionThinkingQueue.add('think', {
            sessionId,
            actorId,
            workspaceId,
            trigger: requeueTrigger,
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
  const row = await db
    .selectFrom('actors')
    .select(
      sql<number>`CASE
        WHEN COALESCE(config->>'maxConcurrentSessions', '') ~ '^[0-9]+$'
          THEN GREATEST((config->>'maxConcurrentSessions')::int, 1)
        ELSE ${DEFAULT_MAX_CONCURRENT_SESSIONS}
      END`.as('max_concurrent_sessions'),
    )
    .where('id', '=', actorId)
    .executeTakeFirst();
  return row?.max_concurrent_sessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
}
