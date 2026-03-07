import type { FastifyRequest, FastifyReply } from 'fastify';
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

  // Check membership
  const result = await query(
    'SELECT trust_level FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, user.userId]
  );

  if (result.rows.length === 0) {
    return reply.status(403).send({ error: 'Not a member of this workspace' });
  }

  (request as any).workspaceMember = result.rows[0];
}
