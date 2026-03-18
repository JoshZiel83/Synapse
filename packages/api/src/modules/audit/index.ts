import type { FastifyInstance } from 'fastify';
import { query } from '../../infrastructure/database/index.js';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { workspaceMiddleware } from '../../infrastructure/middleware/workspace.js';
import { requireRequestAction } from '../access/guards.js';
import { z } from 'zod';

const querySchema = z.object({
  workspaceId: z.string().uuid().optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().uuid().optional(),
  page: z.coerce.number().default(1),
  pageSize: z.coerce.number().default(50),
});

export default async function auditModule(app: FastifyInstance) {
  // List audit logs for a workspace
  app.get('/api/v1/workspaces/:workspaceId/audit-logs', {
    preHandler: [authMiddleware, workspaceMiddleware],
  }, async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const allowed = await requireRequestAction(
      request,
      reply,
      'workspace.view',
      workspaceId,
      'Not allowed to view audit logs in this workspace',
    );
    if (!allowed) return;

    const qs = querySchema.parse(request.query);

    const conditions = ['workspace_id = $1'];
    const params: any[] = [workspaceId];
    let paramIdx = 2;

    if (qs.action) {
      conditions.push(`action = $${paramIdx}`);
      params.push(qs.action);
      paramIdx++;
    }
    if (qs.resourceType) {
      conditions.push(`resource_type = $${paramIdx}`);
      params.push(qs.resourceType);
      paramIdx++;
    }
    if (qs.resourceId) {
      conditions.push(`resource_id = $${paramIdx}`);
      params.push(qs.resourceId);
      paramIdx++;
    }

    const where = conditions.join(' AND ');
    const offset = (qs.page - 1) * qs.pageSize;

    const [countResult, dataResult] = await Promise.all([
      query(`SELECT count(*) FROM audit_logs WHERE ${where}`, params),
      query(
        `SELECT al.id, al.action,
                al.resource_type AS "resourceType",
                al.resource_id AS "resourceId",
                al.user_id AS "userId",
                al.actor_id AS "actorId",
                al.details,
                al.ip_address AS "ipAddress",
                al.created_at AS "createdAt",
                u.email AS "userName",
                a.name AS "actorName"
         FROM audit_logs al
         LEFT JOIN users u ON u.id = al.user_id
         LEFT JOIN actors a ON a.id = al.actor_id
         WHERE ${where.replace(/\b(workspace_id|action|resource_type|resource_id)\b/g, 'al.$&')}
         ORDER BY al.created_at DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, qs.pageSize, offset]
      ),
    ]);

    return {
      items: dataResult.rows,
      total: parseInt(countResult.rows[0].count),
      page: qs.page,
      pageSize: qs.pageSize,
    };
  });
}
