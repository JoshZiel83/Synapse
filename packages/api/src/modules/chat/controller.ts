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
  attachments: z.array(z.any()).optional(),
  targetActorIds: z.array(z.string().uuid()).optional(),
});

export async function chatController(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // GET /workspaces/:wsId/chat/groups — list groups
  app.get<{
    Params: { workspaceId: string };
  }>('/workspaces/:workspaceId/chat/groups', async (request, reply) => {
    const { workspaceId } = request.params;
    const userId = (request as any).user!.userId;

    const result = await listGroups(workspaceId, userId);
    return reply.send({ groups: result.groups, thinkingMap: result.thinkingMap });
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

  // GET /workspaces/:wsId/chat/groups/:groupId/messages — get group messages
  app.get<{
    Params: { workspaceId: string; groupId: string };
    Querystring: { limit?: string; before?: string };
  }>('/workspaces/:workspaceId/chat/groups/:groupId/messages', async (request, reply) => {
    const { groupId } = request.params;
    const qs = request.query as any;
    const limit = qs.limit ? parseInt(qs.limit, 10) : 50;
    const before = qs.before || undefined;

    const userId = (request as any).user!.userId;
    const messages = await getGroupMessages(groupId, userId, limit, before);
    return reply.send({ messages });
  });

  // POST /workspaces/:wsId/chat/groups/:groupId/messages — send message to group
  app.post<{
    Params: { workspaceId: string; groupId: string };
    Body: { content: string; attachments?: any[]; targetActorIds?: string[] };
  }>('/workspaces/:workspaceId/chat/groups/:groupId/messages', async (request, reply) => {
    const { workspaceId, groupId } = request.params;
    const { content, attachments, targetActorIds } = sendMessageSchema.parse(request.body);
    const userId = (request as any).user!.userId;

    const result = await sendMessageToGroup(workspaceId, groupId, userId, content, attachments, targetActorIds);
    return reply.status(201).send(result);
  });

  // POST /workspaces/:wsId/chat/groups/:groupId/read — mark group as read
  app.post<{
    Params: { workspaceId: string; groupId: string };
  }>('/workspaces/:workspaceId/chat/groups/:groupId/read', async (request, reply) => {
    const { groupId } = request.params;
    const userId = (request as any).user!.userId;

    await markGroupAsRead(userId, groupId);
    return reply.status(204).send();
  });

  // DELETE /workspaces/:wsId/chat/groups/:groupId — cancel group
  app.delete<{
    Params: { workspaceId: string; groupId: string };
  }>('/workspaces/:workspaceId/chat/groups/:groupId', async (request, reply) => {
    const { workspaceId, groupId } = request.params;

    await cancelGroup(groupId, workspaceId);
    return reply.status(204).send();
  });
}
