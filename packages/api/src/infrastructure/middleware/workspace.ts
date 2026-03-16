import type { FastifyRequest, FastifyReply } from 'fastify';
import { requireRequestAction } from '../../modules/access/guards.js';
import { query } from '../database/index.js';

export async function workspaceMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const workspaceId = (request.params as any).workspaceId;
  if (!workspaceId) {
    return reply.status(400).send({ error: 'Workspace ID is required' });
  }

  const user = (request as any).user;
  if (!user) {
    return reply.status(401).send({ error: 'Authentication required' });
  }

  const result = await query(
    'SELECT trust_level FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, user.userId]
  );

  const allowed = await requireRequestAction(
    request,
    reply,
    'workspace.view',
    workspaceId,
    'Not allowed to access this workspace',
  );
  if (!allowed) {
    return;
  }

  (request as any).workspaceMember = result.rows[0] ?? null;
}
