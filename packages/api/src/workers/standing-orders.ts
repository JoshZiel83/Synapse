import { Worker } from 'bullmq';
import { redis } from '../infrastructure/redis/index.js';
import { query } from '../infrastructure/database/index.js';
import { QUEUE_NAMES, nowISO } from '@synapse/shared';
import { actorThinkingQueue } from './queues.js';
import { registerWorker } from './registry.js';

export function startStandingOrdersWorker() {
  const worker = new Worker(
    QUEUE_NAMES.STANDING_ORDERS,
    async (job) => {
      const { standingOrderId } = job.data;

      const soResult = await query('SELECT * FROM standing_orders WHERE id = $1 AND is_active = true', [standingOrderId]);
      if (soResult.rows.length === 0) return;
      const so = soResult.rows[0];

      // Create a work item for this standing order execution
      const wiResult = await query(
        `INSERT INTO work_items (workspace_id, title, description, status, priority, created_by, assigned_to, source_type, source_id)
         VALUES ($1, $2, $3, 'assigned', 'medium', $4, $4, 'standing_order', $5)
         RETURNING id`,
        [so.workspace_id, `Standing Order: ${so.name}`, so.instruction, so.actor_id, so.id]
      );

      const workItemId = wiResult.rows[0].id;

      // Queue actor thinking
      await actorThinkingQueue.add('think', {
        actorId: so.actor_id,
        workItemId,
        workspaceId: so.workspace_id,
        trigger: 'standing_order',
      });

      // Update last triggered
      await query('UPDATE standing_orders SET last_triggered_at = NOW() WHERE id = $1', [standingOrderId]);
    },
    { connection: redis, concurrency: 3 }
  );

  worker.on('failed', (job, err) => {
    console.error(`Standing order job ${job?.id} failed:`, err.message);
  });

  registerWorker(worker);
  return worker;
}
