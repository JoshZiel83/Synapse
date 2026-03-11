import { Worker } from 'bullmq';
import { redis } from '../infrastructure/redis/index.js';
import { query } from '../infrastructure/database/index.js';
import { QUEUE_NAMES, nowISO } from '@synapse/shared';
import { aiComplete } from '../modules/ai/index.js';
import { resolveModelConfig } from '../modules/model-groups/resolver.js';
import { getSessionMessages } from '../modules/session/service.js';

export function startMemoryArchivalWorker() {
  const worker = new Worker(
    QUEUE_NAMES.MEMORY_ARCHIVAL,
    async (job) => {
      const { workspaceId, actorId, sessionId } = job.data;

      const messages = await getSessionMessages(sessionId);
      if (messages.length === 0) return;

      // Build context for memory extraction
      const context = `Session conversation for memory extraction:

Messages during this session:
${messages.map((m: any) => `[${m.role}] ${m.content}`).join('\n')}

Based on this completed session, extract key experiences and knowledge worth remembering long-term.
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
            `INSERT INTO memories (workspace_id, actor_id, category, scope, content, tags, importance)
             VALUES ($1, $2, $3, 'private', $4, $5, $6)`,
            [
              workspaceId,
              actorId,
              mem.category || 'experiential',
              mem.content,
              mem.tags || [],
              mem.importance || 0.5,
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
