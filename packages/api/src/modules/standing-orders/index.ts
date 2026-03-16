import type { FastifyInstance } from 'fastify';
import { query } from '../../infrastructure/database/index.js';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { workspaceMiddleware } from '../../infrastructure/middleware/workspace.js';
import { requireRequestAction } from '../access/guards.js';
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
  const preHandler = [authMiddleware, workspaceMiddleware];

  // Create standing order
  app.post(prefix, { preHandler }, async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const allowed = await requireRequestAction(request as any, reply as any, 'workspace.manage_actors', workspaceId, 'Not allowed to manage standing orders in this workspace');
    if (!allowed) return;

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
  app.get(prefix, { preHandler }, async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const allowed = await requireRequestAction(request as any, reply as any, 'workspace.view', workspaceId, 'Not allowed to view standing orders in this workspace');
    if (!allowed) return;

    const result = await query(
      'SELECT * FROM standing_orders WHERE workspace_id = $1 ORDER BY created_at DESC',
      [workspaceId]
    );
    return result.rows;
  });

  // Get standing order
  app.get(`${prefix}/:orderId`, { preHandler }, async (request, reply) => {
    const { workspaceId, orderId } = request.params as { workspaceId: string; orderId: string };
    const allowed = await requireRequestAction(request as any, reply as any, 'workspace.view', workspaceId, 'Not allowed to view standing orders in this workspace');
    if (!allowed) return;

    const result = await query('SELECT * FROM standing_orders WHERE id = $1 AND workspace_id = $2', [orderId, workspaceId]);
    if (result.rows.length === 0) return reply.status(404).send({ error: 'Not found' });
    return result.rows[0];
  });

  // Update standing order
  app.put(`${prefix}/:orderId`, { preHandler }, async (request, reply) => {
    const { workspaceId, orderId } = request.params as { workspaceId: string; orderId: string };
    const allowed = await requireRequestAction(request as any, reply as any, 'workspace.manage_actors', workspaceId, 'Not allowed to manage standing orders in this workspace');
    if (!allowed) return;

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
      `UPDATE standing_orders SET ${fields.join(', ')} WHERE id = $${idx} AND workspace_id = $${idx + 1} RETURNING *`,
      [...values, workspaceId]
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
  app.delete(`${prefix}/:orderId`, { preHandler }, async (request, reply) => {
    const { workspaceId, orderId } = request.params as { workspaceId: string; orderId: string };
    const allowed = await requireRequestAction(request as any, reply as any, 'workspace.manage_actors', workspaceId, 'Not allowed to manage standing orders in this workspace');
    if (!allowed) return;

    await standingOrdersQueue.removeRepeatableByKey(`so:${orderId}`).catch(() => {});
    await query('DELETE FROM standing_orders WHERE id = $1 AND workspace_id = $2', [orderId, workspaceId]);
    return { success: true };
  });
}
