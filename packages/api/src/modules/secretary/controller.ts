import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { processUserMessage, getConversation, clearConversation } from './service.js';

const sendMessageSchema = z.object({
  content: z.string().min(1).max(10000),
});

export async function secretaryController(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // POST /message - user sends message to secretary
  app.post<{
    Params: { workspaceId: string };
    Body: { content: string };
  }>('/message', async (request, reply) => {
    const { workspaceId } = request.params;
    const { content } = sendMessageSchema.parse(request.body);
    const userId = (request as any).user!.userId;

    const { sessionId } = await processUserMessage(
      workspaceId,
      userId,
      content
    );

    return reply.status(201).send({
      sessionId,
      status: 'processing',
    });
  });

  // GET /conversation - get conversation between user and secretary
  app.get<{
    Params: { workspaceId: string };
  }>('/conversation', async (request, reply) => {
    const { workspaceId } = request.params;
    const userId = (request as any).user!.userId;

    const messages = await getConversation(workspaceId, userId);

    return reply.send({ messages });
  });

  // DELETE /conversation - clear conversation history (memories are preserved)
  app.delete<{
    Params: { workspaceId: string };
  }>('/conversation', async (request, reply) => {
    const { workspaceId } = request.params;
    const userId = (request as any).user!.userId;

    await clearConversation(workspaceId, userId);

    return reply.status(204).send();
  });
}
