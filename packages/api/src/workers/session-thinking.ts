import { Worker } from 'bullmq';
import { redis } from '../infrastructure/redis/index.js';
import { query } from '../infrastructure/database/index.js';
import { emitEvent } from '../infrastructure/events/index.js';
import { QUEUE_NAMES, SESSION_LOCK_TTL, REDIS_CHANNELS, DEFAULT_MAX_CONCURRENT_SESSIONS, nowISO } from '@synapse/shared';
import type { ActorAction, GroupMemberEntry } from '@synapse/shared';
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
import { sleepActor, sendGroupMessage, wakeActor } from '../modules/group/service.js';
import { sessionThinkingQueue } from './queues.js';

export function startSessionThinkingWorker() {
  const worker = new Worker(
    QUEUE_NAMES.SESSION_THINKING,
    async (job) => {
      const { sessionId, actorId, workspaceId, trigger, userId } = job.data;
      const sessionLockKey = `${REDIS_CHANNELS.SESSION_LOCK_PREFIX}${sessionId}`;
      const actorSessionsKey = `${REDIS_CHANNELS.ACTOR_SESSIONS_PREFIX}${actorId}`;

      // 1. Acquire per-session lock
      const acquired = await redis.set(sessionLockKey, job.id!, 'PX', SESSION_LOCK_TTL, 'NX');
      if (!acquired) {
        console.log(`[session-thinking] Session ${sessionId} is already being processed, skipping`);
        return { success: false, reason: 'session locked' };
      }

      // 2. Check actor concurrent session limit
      const currentCount = await redis.incr(actorSessionsKey);
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
        if (!session || session.status !== 'active') {
          console.log(`[session-thinking] Session ${sessionId} is ${session?.status ?? 'not found'}, skipping`);
          return { success: false, reason: 'session not active' };
        }

        const groupId = session.group_id;

        // Emit thinking event
        await emitEvent({
          type: 'actor.thinking',
          workspaceId,
          payload: { actorId, sessionId, groupId },
          timestamp: nowISO(),
        });

        // Emit session.thinking for chat UI
        const thinkingActorResult = await query('SELECT name FROM actors WHERE id = $1', [actorId]);
        const thinkingActorName = thinkingActorResult.rows[0]?.name || 'Unknown';

        const thinkingRedisKey = `thinking:${groupId || sessionId}`;
        const emitThinkingStatus = async (status: string) => {
          const thinkingPayload = { groupId, sessionId, actorId, actorName: thinkingActorName, status };
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

        // Load session messages (isolated AI context)
        const sessionMessages = await getSessionMessages(sessionId);

        // Extract last user attachments for multimodal handling
        let lastUserAttachments: any[] | undefined;
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

        // Load group members for prompt and context (if in group)
        // Use versioned data: actor info from actor_versions at session creation time
        let groupMembers: any[] | undefined;
        let totalActorCount = 0;
        let memberEntries: GroupMemberEntry[] = [];
        let groupUserId: string | undefined;
        if (groupId) {
          const membersResult = await query(
            `SELECT gm.*,
                    COALESCE(av.name, a.name) as actor_name,
                    COALESCE(av.title, a.title) as actor_title,
                    COALESCE(av.role, a.role) as actor_role,
                    COALESCE(av.charter, a.charter) as actor_charter,
                    COALESCE(av.skills, a.skills) as actor_skills,
                    u.name as user_name, u.id as user_id_ref,
                    s.status as session_status
             FROM group_members gm
             LEFT JOIN actors a ON a.id = gm.actor_id
             LEFT JOIN LATERAL (
               SELECT * FROM actor_versions av2
               WHERE av2.actor_id = gm.actor_id
                 AND av2.created_at <= (SELECT created_at FROM sessions WHERE id = $2)
               ORDER BY av2.version DESC LIMIT 1
             ) av ON true
             LEFT JOIN users u ON u.id = gm.user_id
             LEFT JOIN sessions s ON s.id = gm.session_id
             WHERE gm.group_id = $1
               AND gm.joined_at <= (SELECT created_at FROM sessions WHERE id = $2)
             ORDER BY gm.joined_at ASC`,
            [groupId, sessionId]
          );
          groupMembers = membersResult.rows;
          totalActorCount = groupMembers.filter((m: any) => m.actor_id).length;

          // Build GroupMemberEntry[] for ToolResolveContext
          for (const m of groupMembers) {
            if (m.actor_id && m.actor_id !== actorId) {
              memberEntries.push({ type: 'actor', id: m.actor_id, name: m.actor_name, title: m.actor_title });
            } else if (m.user_id) {
              memberEntries.push({ type: 'user', id: m.user_id, name: m.user_name || 'User' });
              groupUserId = m.user_id;
            }
          }
        }

        // Build system prompt using versioned actor data
        let actorForPrompt = actor;
        if (groupId) {
          const versionResult = await query(
            `SELECT * FROM actor_versions WHERE actor_id = $1
               AND created_at <= (SELECT created_at FROM sessions WHERE id = $2)
             ORDER BY version DESC LIMIT 1`,
            [actorId, sessionId]
          );
          if (versionResult.rows.length > 0) {
            const v = versionResult.rows[0];
            actorForPrompt = { ...actor, name: v.name, role: v.role, title: v.title, charter: v.charter, system_prompt: v.system_prompt, skills: v.skills, config: v.config, capabilities: v.capabilities };
          }
        }

        // Build conversation messages from group context + session tool history
        let conversationMessages;
        if (groupId) {
          conversationMessages = await buildGroupConversationMessages(sessionId, groupId, actorId, totalActorCount, sessionMessages, {
            interrupts: interrupts.length > 0 ? interrupts : undefined,
            memoryNotice,
          });
        } else {
          conversationMessages = buildConversationMessages(sessionMessages, {
            crossTurnToolHistory: false,
            interrupts: interrupts.length > 0 ? interrupts : undefined,
            memoryNotice,
          });
        }

        // Recall memories
        const memoriesResult = await query(
          `SELECT content, category, importance FROM memories
           WHERE (actor_id = $1 OR scope IN ('team', 'workspace'))
           AND workspace_id = $2
           ORDER BY importance DESC, created_at DESC LIMIT 10`,
          [actorId, workspaceId]
        );

        // Resolve model config
        const resolvedConfig = await resolveModelConfig(actorId, workspaceId);

        // If cross-turn tool history is enabled and non-group mode, rebuild
        let finalConversationMessages = conversationMessages;
        if (resolvedConfig?.crossTurnToolHistory && !groupId) {
          finalConversationMessages = buildConversationMessages(sessionMessages, {
            crossTurnToolHistory: true,
            interrupts: interrupts.length > 0 ? interrupts : undefined,
            memoryNotice,
          });
        }

        // Resolve MCP plugin tools — pass groupId and groupMembers for authorization
        let mcpTools: ResolvedMcpTools = { tools: [], executor: async () => '', mcpVersion: 0, refresh: async () => ({ tools: [], mcpVersion: 0 }), setTurnId: () => {} };
        try {
          mcpTools = await resolveMcpToolsForActor({
            actorId,
            workspaceId,
            sessionId,
            userId: groupUserId || userId,
            groupId,
            groupMembers: memberEntries,
          });
          if (mcpTools.tools.length > 0) {
            console.log(`[session-thinking] Resolved ${mcpTools.tools.length} MCP tools for actor ${actorId}`);
          }
        } catch (err: any) {
          console.error(`[session-thinking] Failed to resolve MCP tools:`, err.message);
        }

        // Build system prompt
        const { system } = buildActorPrompt(
          actorForPrompt,
          memoriesResult.rows,
          undefined, // no subordinates in group model
          undefined,
          mcpTools.tools.length > 0 ? mcpTools.tools : undefined,
          groupMembers,
        );

        // Refresh session lock periodically
        const lockRefreshInterval = setInterval(async () => {
          try {
            await redis.pexpire(sessionLockKey, SESSION_LOCK_TTL);
          } catch { /* ignore */ }
        }, Math.floor(SESSION_LOCK_TTL / 2));

        let result;
        // Track last known group message time for inter-round injection
        let lastKnownGroupMsgTime = new Date();
        if (groupId) {
          const lastMsg = await query(
            `SELECT created_at FROM group_messages WHERE group_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [groupId]
          );
          if (lastMsg.rows[0]) lastKnownGroupMsgTime = new Date(lastMsg.rows[0].created_at);
        }

        // Capture think start time — used for post-sleep re-wake check
        const thinkStartTime = new Date();

        try {
          await emitThinkingStatus('Calling AI model...');

          // actorThink handles builtin tool resolution internally via resolveBuiltinTools(ctx)
          // No need to manually build dynamic send_to tool — it's done in tool-plugins.ts
          result = await actorThink(
            actor,
            memoriesResult.rows,
            finalConversationMessages,
            undefined, // no subordinates
            resolvedConfig,
            workspaceId,
            {
              sessionId,
              groupId,
              groupMembers: memberEntries,
              userId: groupUserId || userId,
              onStatus: emitThinkingStatus,
              mcpTools: mcpTools.tools.length > 0 ? mcpTools.tools : undefined,
              mcpExecutor: mcpTools.executor,
              mcpVersion: mcpTools.mcpVersion,
              mcpRefresh: mcpTools.refresh,
              mcpSetTurnId: mcpTools.setTurnId,
              attachments: lastUserAttachments,
              system,
              checkNewMessages: groupId ? async () => {
                // Check for new group messages targeting this actor (visibility filtered)
                const newMsgs = await query(
                  `SELECT gm.*, COALESCE(a.name, u.name) as sender_name,
                     (SELECT ARRAY_AGG(ta.name) FROM unnest(gm.target_actor_ids) tid JOIN actors ta ON ta.id = tid) as target_actor_names
                   FROM group_messages gm
                   LEFT JOIN actors a ON a.id = gm.sender_actor_id
                   LEFT JOIN users u ON u.id = gm.sender_user_id
                   WHERE gm.group_id = $1
                   AND $2 = ANY(gm.target_actor_ids)
                   AND gm.sender_actor_id IS DISTINCT FROM $2
                   AND gm.created_at > $3
                   ORDER BY gm.created_at`,
                  [groupId, actorId, lastKnownGroupMsgTime.toISOString()]
                );

                const result: { role: string; content: string; metadata?: any }[] = [];

                if (newMsgs.rows.length > 0) {
                  lastKnownGroupMsgTime = new Date(newMsgs.rows[newMsgs.rows.length - 1].created_at);
                  for (const m of newMsgs.rows) {
                    const targetNames: string[] = m.target_actor_names || [];
                    let header = `[${m.sender_name}`;
                    if (targetNames.length > 0) {
                      header += ` → ${targetNames.join(', ')}`;
                    }
                    header += `]`;
                    result.push({
                      role: 'user',
                      content: `${header}: ${m.content}`,
                      metadata: m.metadata,
                    });
                  }
                }

                // Check for new member events
                const newMemberEvents = await query(
                  `SELECT gme.*, COALESCE(av.name, u.name) as member_name
                   FROM group_member_events gme
                   LEFT JOIN LATERAL (
                     SELECT name FROM actor_versions av2
                     WHERE av2.actor_id = gme.actor_id ORDER BY av2.version DESC LIMIT 1
                   ) av ON true
                   LEFT JOIN users u ON u.id = gme.user_id
                   WHERE gme.group_id = $1 AND gme.created_at > $2
                   ORDER BY gme.created_at`,
                  [groupId, lastKnownGroupMsgTime.toISOString()]
                );
                if (newMemberEvents.rows.length > 0) {
                  // Group by batch_id
                  const batches = new Map<string, any[]>();
                  for (const evt of newMemberEvents.rows) {
                    const bid = evt.batch_id || evt.id;
                    if (!batches.has(bid)) batches.set(bid, []);
                    batches.get(bid)!.push(evt);
                  }
                  for (const [, events] of batches) {
                    const names = events.map((e: any) => e.member_name || 'Unknown').join(', ');
                    const evtType = events[0].event_type;
                    let content = evtType === 'joined' ? `${names} joined the group` : `${names} was removed from the group`;
                    result.push({ role: 'user', content: `[System]: ${content}` });
                  }
                }

                return result.length > 0 ? result : null;
              } : undefined,
            },
          );
        } finally {
          clearInterval(lockRefreshInterval);
        }

        // Execute non-group actions (create_memory, rename_self, change_avatar)
        await executeActorActions(workspaceId, actorId, result.actions, sessionId);

        // Clear thinking state
        await redis.del(thinkingRedisKey);

        // Save respond actions as session messages (for audit only — not visible in group)
        const respondActions = result.actions.filter((a: ActorAction) => a.type === 'respond');
        const msgMetadata: Record<string, unknown> = {};
        if (result.toolsUsed && result.toolsUsed.length > 0) msgMetadata.toolsUsed = result.toolsUsed;
        if (result.serverToolCalls && result.serverToolCalls.length > 0) msgMetadata.serverToolCalls = result.serverToolCalls;
        if (result.citationSources && Object.keys(result.citationSources).length > 0) msgMetadata.citationSources = result.citationSources;
        if (result.toolHistory) msgMetadata.toolHistory = result.toolHistory;
        if (result.mediaAttachments && result.mediaAttachments.length > 0) msgMetadata.attachments = result.mediaAttachments;
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
          }
        } else if (result.reasoning) {
          // Save reasoning as session message for audit trail
          await addSessionMessage({
            sessionId,
            workspaceId,
            role: 'assistant',
            content: result.reasoning,
            fromActorId: actorId,
            metadata: { ...hasMeta, reasoningOnly: true },
          });
        } else if (result.actions.length > 0) {
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

        // Check if session was set to sleeping by the sleep tool
        const postThinkSession = await getSession(sessionId);
        if (postThinkSession?.status === 'sleeping') {
          // Actor explicitly called sleep — check for messages that arrived DURING thinking
          const unprocessed = await query(
            `SELECT COUNT(*) as cnt FROM group_messages
             WHERE group_id = $1 AND $2 = ANY(target_actor_ids)
             AND sender_actor_id IS DISTINCT FROM $2
             AND created_at > $3`,
            [groupId || '', actorId, thinkStartTime.toISOString()]
          );
          if (groupId && parseInt(unprocessed.rows[0]?.cnt || '0') > 0) {
            console.log(`[session-thinking] Session ${sessionId} has unprocessed messages after sleep — re-waking`);
            await wakeActor(groupId, actorId);
          } else {
            console.log(`[session-thinking] Session ${sessionId} entered sleeping state`);
          }
        } else if (postThinkSession?.status === 'active') {
          // AI turn ended without calling sleep → auto-sleep
          await sleepActor(sessionId);
          // Post-sleep re-wake check — messages that arrived DURING thinking
          if (groupId) {
            const unprocessed = await query(
              `SELECT COUNT(*) as cnt FROM group_messages
               WHERE group_id = $1 AND $2 = ANY(target_actor_ids)
               AND sender_actor_id IS DISTINCT FROM $2
               AND created_at > $3`,
              [groupId, actorId, thinkStartTime.toISOString()]
            );
            if (parseInt(unprocessed.rows[0]?.cnt || '0') > 0) {
              console.log(`[session-thinking] Session ${sessionId} has unprocessed messages after auto-sleep — re-waking`);
              await wakeActor(groupId, actorId);
            } else {
              console.log(`[session-thinking] Session ${sessionId} auto-slept`);
            }
          } else {
            console.log(`[session-thinking] Session ${sessionId} auto-slept`);
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
          payload: { actorId, sessionId, groupId, actions: result.actions },
          timestamp: nowISO(),
        });

        return { success: true, actions: result.actions.length };

      } catch (err: any) {
        console.error(`[session-thinking] Session ${sessionId} failed:`, err.message);
        const failedSess = await getSession(sessionId).catch(() => null);
        await redis.del(`thinking:${failedSess?.group_id || sessionId}`).catch(() => {});
        await updateSessionStatus(sessionId, 'failed', { errorMessage: err.message });

        await shutdownSessionInstances(sessionId).catch(() => {});

        await emitEvent({
          type: 'session.status.changed',
          workspaceId,
          payload: {
            groupId: failedSess?.group_id,
            sessionId,
            status: 'failed',
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

// Build conversation messages from group context for a specific actor
// Uses visibility filtering (only messages sent to/from this actor) + derived system events
async function buildGroupConversationMessages(
  sessionId: string,
  groupId: string,
  actorId: string,
  _totalActorCount: number,
  sessionMessages: any[],
  options: { interrupts?: any[]; memoryNotice?: string },
): Promise<any[]> {
  // NOTE: Use SQL subquery `(SELECT created_at FROM sessions WHERE id = $3)` instead
  // of passing sessionCreatedAt through JavaScript. JavaScript Date loses microsecond
  // precision from PostgreSQL TIMESTAMPTZ, causing comparison failures when both timestamps
  // were set by NOW() in the same transaction.

  // 1. Get group messages (visibility filtered: only messages this actor sent or was targeted by)
  const groupMsgs = await query(
    `SELECT gm.*, COALESCE(a.name, u.name) as sender_name,
       (SELECT ARRAY_AGG(ta.name) FROM unnest(gm.target_actor_ids) tid JOIN actors ta ON ta.id = tid) as target_actor_names,
       (SELECT ARRAY_AGG(tu.name) FROM unnest(gm.target_user_ids) tuid JOIN users tu ON tu.id = tuid) as target_user_names
     FROM group_messages gm
     LEFT JOIN actors a ON a.id = gm.sender_actor_id
     LEFT JOIN users u ON u.id = gm.sender_user_id
     WHERE gm.group_id = $1
       AND (gm.sender_actor_id = $2 OR $2 = ANY(gm.target_actor_ids))
     ORDER BY gm.created_at ASC
     LIMIT 200`,
    [groupId, actorId]
  );

  // 2. Get member events (after session creation — using SQL subquery for precision)
  const memberEvents = await query(
    `SELECT gme.*,
       COALESCE(av.name, u.name) as member_name,
       av.title as member_title
     FROM group_member_events gme
     LEFT JOIN LATERAL (
       SELECT name, title FROM actor_versions av2
       WHERE av2.actor_id = gme.actor_id AND av2.created_at <= gme.created_at
       ORDER BY av2.version DESC LIMIT 1
     ) av ON true
     LEFT JOIN users u ON u.id = gme.user_id
     WHERE gme.group_id = $1
       AND gme.created_at > (SELECT created_at FROM sessions WHERE id = $2)
     ORDER BY gme.created_at`,
    [groupId, sessionId]
  );

  // 3. Get actor version changes (after session creation — using SQL subquery for precision)
  const versionChanges = await query(
    `SELECT av.*, a.name as current_name
     FROM actor_versions av
     JOIN actors a ON a.id = av.actor_id
     WHERE av.actor_id IN (
       SELECT DISTINCT actor_id FROM group_member_events WHERE group_id = $1 AND actor_id IS NOT NULL
     )
     AND av.created_at > (SELECT created_at FROM sessions WHERE id = $2)
     AND av.version > 1
     ORDER BY av.created_at`,
    [groupId, sessionId]
  );

  // 4. Build timeline events
  interface TimelineEvent { time: Date; role: string; content: string }
  const timeline: TimelineEvent[] = [];

  // Chat messages
  for (const gm of groupMsgs.rows) {
    const time = new Date(gm.created_at);
    if (gm.sender_actor_id === actorId) {
      // This actor's own messages appear as assistant
      const targetNames: string[] = [...(gm.target_actor_names || []), ...(gm.target_user_names || [])];
      let prefix = '';
      if (targetNames.length > 0) {
        prefix = `[→ ${targetNames.join(', ')}] `;
      }
      timeline.push({ time, role: 'assistant', content: prefix + gm.content });
    } else {
      // Other actors' or user's messages
      const targetNames: string[] = [...(gm.target_actor_names || []), ...(gm.target_user_names || [])];
      let header = `[${gm.sender_name}`;
      if (targetNames.length > 0) {
        header += ` → ${targetNames.join(', ')}`;
      }
      header += `]: `;
      timeline.push({ time, role: 'user', content: header + gm.content });
    }
  }

  // Member events — group by batch_id
  const batchGroups = new Map<string, any[]>();
  for (const evt of memberEvents.rows) {
    const bid = evt.batch_id || evt.id;
    if (!batchGroups.has(bid)) batchGroups.set(bid, []);
    batchGroups.get(bid)!.push(evt);
  }

  for (const [, events] of batchGroups) {
    const evtType = events[0].event_type;
    const names = events.map((e: any) => e.member_name || 'Unknown').join(', ');
    let content: string;
    if (evtType === 'joined') {
      content = `${names} joined the group`;
      if (events.length === 1 && events[0].member_title) {
        content += ` (${events[0].member_title})`;
      }
    } else if (evtType === 'kicked') {
      content = `${names} was removed from the group`;
    } else {
      content = `${names} left the group`;
    }
    timeline.push({ time: new Date(events[0].created_at), role: 'user', content: `[System]: ${content}` });
  }

  // Actor version changes
  for (const vc of versionChanges.rows) {
    const changes: string[] = [];
    if (vc.title) changes.push(`title: ${vc.title}`);
    if (vc.charter) {
      const brief = vc.charter.split('\n')[0].substring(0, 120);
      changes.push(`charter: ${brief}`);
    }
    const name = vc.current_name || vc.name;
    timeline.push({
      time: new Date(vc.created_at),
      role: 'user',
      content: `[System]: ${name}'s profile was updated${changes.length > 0 ? ': ' + changes.join(', ') : ''}`,
    });
  }

  // Sort by time
  timeline.sort((a, b) => a.time.getTime() - b.time.getTime());

  // 5. Build final messages array
  const messages: any[] = [];

  // Add memory notice if any
  if (options.memoryNotice) {
    messages.push({ role: 'user', content: options.memoryNotice });
  }

  // Add interrupt notices
  if (options.interrupts) {
    for (const interrupt of options.interrupts) {
      messages.push({ role: 'user', content: `[System Interrupt - ${interrupt.type}]: ${interrupt.content}` });
    }
  }

  // Add timeline events
  for (const event of timeline) {
    messages.push({ role: event.role, content: event.content });
  }

  // Append session-level tool call history
  for (const sm of sessionMessages) {
    if (sm.role === 'tool_result') {
      messages.push({ role: 'user', content: `[Tool Result]: ${sm.content}` });
    }
  }

  return messages;
}
