import { Worker } from 'bullmq';
import { redis } from '../infrastructure/redis/index.js';
import { query } from '../infrastructure/database/index.js';
import { emitEvent } from '../infrastructure/events/index.js';
import { QUEUE_NAMES, ACTOR_LOCK_TTL, REDIS_CHANNELS, nowISO } from '@synapse/shared';
import type { ActorAction } from '@synapse/shared';
import { actorThink } from '../modules/ai/index.js';
import { executeActorActions } from '../modules/orchestrator/service.js';
import { resolveModelConfig } from '../modules/model-groups/resolver.js';

export function startActorThinkingWorker() {
  const worker = new Worker(
    QUEUE_NAMES.ACTOR_THINKING,
    async (job) => {
      const { actorId, workItemId, workspaceId, trigger } = job.data;
      const lockKey = `${REDIS_CHANNELS.ACTOR_LOCK_PREFIX}${actorId}`;

      // Acquire actor lock
      const acquired = await redis.set(lockKey, job.id!, 'PX', ACTOR_LOCK_TTL, 'NX');
      if (!acquired) {
        // Re-queue with delay if actor is busy
        throw new Error('Actor is busy, will retry');
      }

      try {
        // Emit thinking event
        await emitEvent({
          type: 'actor.thinking',
          workspaceId,
          payload: { actorId, workItemId },
          timestamp: nowISO(),
        });

        // Load actor
        const actorResult = await query('SELECT * FROM actors WHERE id = $1', [actorId]);
        if (actorResult.rows.length === 0) throw new Error(`Actor ${actorId} not found`);
        const actor = actorResult.rows[0];

        // Load work item context
        let workContext = '';
        if (workItemId) {
          const wiResult = await query('SELECT * FROM work_items WHERE id = $1', [workItemId]);
          if (wiResult.rows.length > 0) {
            const wi = wiResult.rows[0];
            workContext = `Work Item: ${wi.title}\nDescription: ${wi.description}\nPriority: ${wi.priority}\nStatus: ${wi.status}`;
          }
        }

        // Load related messages
        const messagesResult = await query(
          `SELECT * FROM messages WHERE (to_actor_id = $1 OR from_actor_id = $1)
           AND workspace_id = $2
           ORDER BY created_at DESC LIMIT 10`,
          [actorId, workspaceId]
        );

        // Add recent messages to context
        if (messagesResult.rows.length > 0) {
          workContext += '\n\nRecent messages:\n';
          for (const msg of messagesResult.rows.reverse()) {
            const sender = msg.from_user_id ? 'Boss' : `Actor:${msg.from_actor_id}`;
            workContext += `[${msg.type}] ${sender}: ${msg.content}\n`;
          }
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

        // Resolve model config for this actor
        const resolvedConfig = await resolveModelConfig(actorId, workspaceId);

        // Refresh actor lock TTL periodically during multi-round thinking
        const lockRefreshInterval = setInterval(async () => {
          try {
            await redis.pexpire(lockKey, ACTOR_LOCK_TTL);
          } catch { /* ignore refresh errors */ }
        }, Math.floor(ACTOR_LOCK_TTL / 2));

        let result;
        try {
          // Think!
          result = await actorThink(
            actor,
            memoriesResult.rows,
            workContext,
            subordinatesResult.rows.length > 0 ? subordinatesResult.rows : undefined,
            resolvedConfig,
            workspaceId,
          );
        } finally {
          clearInterval(lockRefreshInterval);
        }

        // Filter out empty complete actions — the AI sometimes calls complete with no content
        result.actions = result.actions.filter((a: ActorAction) => {
          if (a.type === 'complete' && (!a.content || !a.content.trim())) {
            return false;
          }
          return true;
        });

        // Execute actions
        await executeActorActions(workspaceId, actorId, workItemId, result.actions);

        // Auto-complete work item if the actor only responded (no delegation/escalation/info request)
        const pendingActionTypes = ['delegate', 'escalate', 'request_info'];
        const hasPendingWork = result.actions.some((a: ActorAction) => pendingActionTypes.includes(a.type));
        const hasExplicitComplete = result.actions.some((a: ActorAction) => a.type === 'complete');
        if (!hasPendingWork && !hasExplicitComplete && workItemId) {
          await query(
            `UPDATE work_items SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1 AND status IN ('created', 'assigned', 'accepted', 'in_progress')`,
            [workItemId]
          );
        }

        // Log to audit
        await query(
          `INSERT INTO audit_logs (workspace_id, actor_id, action, resource_type, resource_id, details)
           VALUES ($1, $2, 'ai.think', 'actor', $3, $4)`,
          [workspaceId, actorId, actorId, JSON.stringify({
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
          payload: { actorId, workItemId, actions: result.actions },
          timestamp: nowISO(),
        });

        return { success: true, actions: result.actions.length };
      } finally {
        // Release lock
        await redis.del(lockKey);
      }
    },
    {
      connection: redis,
      concurrency: 5,
      limiter: { max: 10, duration: 60_000 },
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`Actor thinking job ${job?.id} failed:`, err.message);
  });

  return worker;
}
