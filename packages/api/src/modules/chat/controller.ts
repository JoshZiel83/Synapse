import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import {
  listGroups,
  getGroupMessages,
  sendMessageToGroup,
  markGroupAsRead,
  createGroup,
  cancelGroup,
} from './service.js';

const createGroupSchema = z.object({
  actorId: z.string().uuid(),
  content: z.string().min(1).max(10000),
});

const sendMessageSchema = z.object({
  content: z.string().min(1).max(10000),
});

export async function chatController(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // GET /workspaces/:wsId/chat/groups — list groups
  app.get<{
    Params: { workspaceId: string };
  }>('/workspaces/:workspaceId/chat/groups', async (request, reply) => {
    const { workspaceId } = request.params;
    const userId = (request as any).user!.userId;

    const groups = await listGroups(workspaceId, userId);
    return reply.send({ groups });
  });

  // POST /workspaces/:wsId/chat/groups — create a new group
  app.post<{
    Params: { workspaceId: string };
    Body: { actorId: string; content: string };
  }>('/workspaces/:workspaceId/chat/groups', async (request, reply) => {
    const { workspaceId } = request.params;
    const { actorId, content } = createGroupSchema.parse(request.body);
    const userId = (request as any).user!.userId;

    const group = await createGroup(workspaceId, actorId, userId, content);
    return reply.status(201).send(group);
  });

  // GET /workspaces/:wsId/chat/groups/:rootSessionId/messages — get group messages
  app.get<{
    Params: { workspaceId: string; rootSessionId: string };
    Querystring: { limit?: string; before?: string };
  }>('/workspaces/:workspaceId/chat/groups/:rootSessionId/messages', async (request, reply) => {
    const { rootSessionId } = request.params;
    const qs = request.query as any;
    const limit = qs.limit ? parseInt(qs.limit, 10) : 50;
    const before = qs.before || undefined;

    const messages = await getGroupMessages(rootSessionId, limit, before);
    return reply.send({ messages });
  });

  // POST /workspaces/:wsId/chat/groups/:rootSessionId/messages — send message to group
  app.post<{
    Params: { workspaceId: string; rootSessionId: string };
    Body: { content: string };
  }>('/workspaces/:workspaceId/chat/groups/:rootSessionId/messages', async (request, reply) => {
    const { workspaceId, rootSessionId } = request.params;
    const { content } = sendMessageSchema.parse(request.body);
    const userId = (request as any).user!.userId;

    const result = await sendMessageToGroup(workspaceId, rootSessionId, userId, content);
    return reply.status(201).send(result);
  });

  // POST /workspaces/:wsId/chat/groups/:rootSessionId/read — mark group as read
  app.post<{
    Params: { workspaceId: string; rootSessionId: string };
  }>('/workspaces/:workspaceId/chat/groups/:rootSessionId/read', async (request, reply) => {
    const { rootSessionId } = request.params;
    const userId = (request as any).user!.userId;

    await markGroupAsRead(userId, rootSessionId);
    return reply.status(204).send();
  });

  // DELETE /workspaces/:wsId/chat/groups/:rootSessionId — cancel group
  app.delete<{
    Params: { workspaceId: string; rootSessionId: string };
  }>('/workspaces/:workspaceId/chat/groups/:rootSessionId', async (request, reply) => {
    const { workspaceId, rootSessionId } = request.params;

    await cancelGroup(rootSessionId, workspaceId);
    return reply.status(204).send();
  });
}
