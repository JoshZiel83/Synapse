import { Worker } from 'bullmq';
import { redis } from '../infrastructure/redis/index.js';
import { query } from '../infrastructure/database/index.js';
import { emitEvent } from '../infrastructure/events/index.js';
import { QUEUE_NAMES, ACTOR_LOCK_TTL, REDIS_CHANNELS, nowISO } from '@synapse/shared';
import type { ConversationMessage } from '@synapse/shared';
import { actorThink } from '../modules/ai/index.js';
import { buildActorPrompt } from '../modules/ai/prompt-builder.js';
import { executeActorActions } from '../modules/orchestrator/service.js';
import { resolveModelConfig } from '../modules/model-groups/resolver.js';

export function startActorThinkingWorker() {
  const worker = new Worker(
    QUEUE_NAMES.ACTOR_THINKING,
    async (job) => {
      const { actorId, workspaceId, trigger } = job.data;
      const lockKey = `${REDIS_CHANNELS.ACTOR_LOCK_PREFIX}${actorId}`;

      // Acquire actor lock
      const acquired = await redis.set(lockKey, job.id!, 'PX', ACTOR_LOCK_TTL, 'NX');
      if (!acquired) {
        throw new Error('Actor is busy, will retry');
      }

      try {
        // Emit thinking event
        await emitEvent({
          type: 'actor.thinking',
          workspaceId,
          payload: { actorId },
          timestamp: nowISO(),
        });

        // Load actor
        const actorResult = await query('SELECT * FROM actors WHERE id = $1', [actorId]);
        if (actorResult.rows.length === 0) throw new Error(`Actor ${actorId} not found`);
        const actor = actorResult.rows[0];

        // Recall memories
        const memoriesResult = await query(
          `SELECT content, category, importance FROM memories
           WHERE (actor_id = $1 OR scope IN ('team', 'workspace'))
           AND workspace_id = $2
           ORDER BY importance DESC, created_at DESC LIMIT 10`,
          [actorId, workspaceId]
        );

        // Resolve model config for this actor
        const resolvedConfig = await resolveModelConfig(actorId, workspaceId);

        // Build system prompt
        const { system } = buildActorPrompt(
          actor,
          memoriesResult.rows,
        );

        // Build conversation messages
        const conversationMessages: ConversationMessage[] = [
          { role: 'user', content: `[Trigger: ${trigger}] Process any pending work.` },
        ];

        // Refresh actor lock TTL periodically during multi-round thinking
        const lockRefreshInterval = setInterval(async () => {
          try {
            await redis.pexpire(lockKey, ACTOR_LOCK_TTL);
          } catch { /* ignore refresh errors */ }
        }, Math.floor(ACTOR_LOCK_TTL / 2));

        let result;
        try {
          result = await actorThink(
            actor,
            memoriesResult.rows,
            conversationMessages,
            undefined,
            resolvedConfig,
            workspaceId,
            { system },
          );
        } finally {
          clearInterval(lockRefreshInterval);
        }

        // Execute actions
        await executeActorActions(workspaceId, actorId, result.actions);

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
          payload: { actorId, actions: result.actions },
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
