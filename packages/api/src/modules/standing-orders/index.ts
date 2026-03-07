import type { FastifyInstance } from 'fastify';
import { query } from '../../infrastructure/database/index.js';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { standingOrdersQueue } from '../../workers/queues.js';
import { z } from 'zod';

const createSchema = z.object({
  actorId: z.string().uuid(),
  name: z.string().min(1).max(255),
  description: z.string().default(''),
  triggerType: z.enum(['cron', 'event', 'condition']).default('cron'),
  triggerConfig: z.record(z.unknown()),
  instruction: z.string().min(1),
  isActive: z.boolean().default(true),
});

const updateSchema = createSchema.partial();

export default async function standingOrdersModule(app: FastifyInstance) {
  const prefix = '/api/v1/workspaces/:workspaceId/standing-orders';

  // Create standing order
  app.post(prefix, { preHandler: [authMiddleware] }, async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const body = createSchema.parse(request.body);

    const result = await query(
      `INSERT INTO standing_orders (workspace_id, actor_id, name, description, trigger_type, trigger_config, instruction, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [workspaceId, body.actorId, body.name, body.description, body.triggerType, JSON.stringify(body.triggerConfig), body.instruction, body.isActive]
    );

    const so = result.rows[0];

    // Set up cron job if applicable
    if (body.triggerType === 'cron' && body.isActive && body.triggerConfig.cron) {
      await standingOrdersQueue.add(
        `so:${so.id}`,
        { standingOrderId: so.id },
        { repeat: { pattern: body.triggerConfig.cron as string }, jobId: `so:${so.id}` }
      );
    }

    return reply.status(201).send(so);
  });

  // List standing orders
  app.get(prefix, { preHandler: [authMiddleware] }, async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const result = await query(
      'SELECT * FROM standing_orders WHERE workspace_id = $1 ORDER BY created_at DESC',
      [workspaceId]
    );
    return result.rows;
  });

  // Get standing order
  app.get(`${prefix}/:orderId`, { preHandler: [authMiddleware] }, async (request, reply) => {
    const { orderId } = request.params as { orderId: string };
    const result = await query('SELECT * FROM standing_orders WHERE id = $1', [orderId]);
    if (result.rows.length === 0) return reply.status(404).send({ error: 'Not found' });
    return result.rows[0];
  });

  // Update standing order
  app.put(`${prefix}/:orderId`, { preHandler: [authMiddleware] }, async (request, reply) => {
    const { orderId } = request.params as { orderId: string };
    const body = updateSchema.parse(request.body);

    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(body)) {
      const dbKey = key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
      if (dbKey === 'trigger_config') {
        fields.push(`${dbKey} = $${idx}`);
        values.push(JSON.stringify(value));
      } else {
        fields.push(`${dbKey} = $${idx}`);
        values.push(value);
      }
      idx++;
    }

    if (fields.length === 0) return reply.status(400).send({ error: 'No fields to update' });

    values.push(orderId);
    const result = await query(
      `UPDATE standing_orders SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) return reply.status(404).send({ error: 'Not found' });

    // Update cron job
    const so = result.rows[0];
    await standingOrdersQueue.removeRepeatableByKey(`so:${so.id}`).catch(() => {});

    if (so.trigger_type === 'cron' && so.is_active && so.trigger_config?.cron) {
      await standingOrdersQueue.add(
        `so:${so.id}`,
        { standingOrderId: so.id },
        { repeat: { pattern: so.trigger_config.cron as string }, jobId: `so:${so.id}` }
      );
    }

    return so;
  });

  // Delete standing order
  app.delete(`${prefix}/:orderId`, { preHandler: [authMiddleware] }, async (request, reply) => {
    const { orderId } = request.params as { orderId: string };
    await standingOrdersQueue.removeRepeatableByKey(`so:${orderId}`).catch(() => {});
    await query('DELETE FROM standing_orders WHERE id = $1', [orderId]);
    return { success: true };
  });
}
