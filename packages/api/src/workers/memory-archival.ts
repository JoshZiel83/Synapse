import { Worker } from 'bullmq';
import { redis } from '../infrastructure/redis/index.js';
import { query } from '../infrastructure/database/index.js';
import { QUEUE_NAMES, nowISO } from '@synapse/shared';
import { aiComplete } from '../modules/ai/index.js';
import { resolveModelConfig } from '../modules/model-groups/resolver.js';

export function startMemoryArchivalWorker() {
  const worker = new Worker(
    QUEUE_NAMES.MEMORY_ARCHIVAL,
    async (job) => {
      const { workspaceId, actorId, workItemId } = job.data;

      // Load work item
      const wiResult = await query('SELECT * FROM work_items WHERE id = $1', [workItemId]);
      if (wiResult.rows.length === 0) return;
      const workItem = wiResult.rows[0];

      // Load messages for this work item
      const msgResult = await query(
        'SELECT type, content, from_actor_id, from_user_id FROM messages WHERE work_item_id = $1 ORDER BY created_at',
        [workItemId]
      );

      // Build context for memory extraction
      const context = `Work completed: "${workItem.title}"
Description: ${workItem.description}
Result: ${workItem.result || 'No result recorded'}
Status: ${workItem.status}

Messages during this work:
${msgResult.rows.map((m: any) => `[${m.type}] ${m.content}`).join('\n')}

Based on this completed work, extract key experiences and knowledge worth remembering long-term.
Return a JSON array of memories:
[{"category": "experiential|knowledge|procedural", "content": "...", "tags": ["..."], "importance": 0.0-1.0}]`;

      try {
        // Resolve model config for this actor
        const resolvedConfig = await resolveModelConfig(actorId, workspaceId);

        const result = await aiComplete(
          'You are a memory archivist. Extract valuable long-term memories from completed work. Return only valid JSON.',
          [{ role: 'user', content: context }],
          resolvedConfig,
          { workspaceId, actorId },
        );

        const memories = JSON.parse(result.content);
        if (!Array.isArray(memories)) return;

        for (const mem of memories.slice(0, 5)) {
          await query(
            `INSERT INTO memories (workspace_id, actor_id, category, scope, content, tags, importance, source_work_item_id)
             VALUES ($1, $2, $3, 'private', $4, $5, $6, $7)`,
            [
              workspaceId,
              actorId,
              mem.category || 'experiential',
              mem.content,
              mem.tags || [],
              mem.importance || 0.5,
              workItemId,
            ]
          );
        }
      } catch (err) {
        console.error('Memory archival failed:', err);
      }
    },
    { connection: redis, concurrency: 3 }
  );

  worker.on('failed', (job, err) => {
    console.error(`Memory archival job ${job?.id} failed:`, err.message);
  });

  return worker;
}
