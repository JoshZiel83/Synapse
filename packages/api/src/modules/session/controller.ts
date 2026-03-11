import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import {
  createSession,
  getSession,
  getSessionsByActor,
  getSessionMessages,
  cancelSession,
  addSessionMessage,
  updateSessionStatus,
} from './service.js';
import { sessionThinkingQueue } from '../../workers/queues.js';

const createSessionSchema = z.object({
  content: z.string().min(1).max(10000),
  channelType: z.enum(['web', 'im', 'api']).optional().default('web'),
});

const sendMessageSchema = z.object({
  content: z.string().min(1).max(10000),
});

export async function sessionController(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // POST /workspaces/:wsId/actors/:actorId/sessions — create a new session with any actor
  app.post<{
    Params: { workspaceId: string; actorId: string };
    Body: { content: string; channelType?: string };
  }>('/workspaces/:workspaceId/actors/:actorId/sessions', async (request, reply) => {
    const { workspaceId, actorId } = request.params;
    const { content, channelType } = createSessionSchema.parse(request.body);
    const userId = (request as any).user!.userId;

    const session = await createSession({
      workspaceId,
      actorId,
      channelType,
      trigger: 'user_message',
      metadata: { userId },
    });

    // Add initial message
    await addSessionMessage({
      sessionId: session.id,
      workspaceId,
      role: 'user',
      content,
      fromUserId: userId,
    });

    // Enqueue thinking
    await sessionThinkingQueue.add('think', {
      sessionId: session.id,
      actorId,
      workspaceId,
      trigger: 'user_message',
    });

    return reply.status(201).send({
      sessionId: session.id,
      status: 'processing',
    });
  });

  // POST /workspaces/:wsId/sessions/:sessionId/messages — send a message in an existing session
  app.post<{
    Params: { workspaceId: string; sessionId: string };
    Body: { content: string };
  }>('/workspaces/:workspaceId/sessions/:sessionId/messages', async (request, reply) => {
    const { workspaceId, sessionId } = request.params;
    const { content } = sendMessageSchema.parse(request.body);
    const userId = (request as any).user!.userId;

    const session = await getSession(sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    if (session.workspace_id !== workspaceId) {
      return reply.status(404).send({ error: 'Session not found in this workspace' });
    }

    if (session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled') {
      return reply.status(400).send({ error: `Cannot send message to ${session.status} session` });
    }

    // Add user message to the session
    const message = await addSessionMessage({
      sessionId,
      workspaceId,
      role: 'user',
      content,
      fromUserId: userId,
    });

    // Re-enqueue thinking for this session if it's not already active
    if (session.status !== 'active') {
      await updateSessionStatus(sessionId, 'active');
      await sessionThinkingQueue.add('think', {
        sessionId,
        actorId: session.actor_id,
        workspaceId,
        trigger: 'user_message',
        userId,
      });
    }

    return reply.status(201).send({ messageId: message.id, status: 'processing' });
  });

  // GET /workspaces/:wsId/sessions/:sessionId — session details
  app.get<{
    Params: { workspaceId: string; sessionId: string };
  }>('/workspaces/:workspaceId/sessions/:sessionId', async (request, reply) => {
    const { workspaceId, sessionId } = request.params;

    const session = await getSession(sessionId);
    if (!session || session.workspace_id !== workspaceId) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    return reply.send({ session });
  });

  // GET /workspaces/:wsId/sessions/:sessionId/messages — session messages
  app.get<{
    Params: { workspaceId: string; sessionId: string };
  }>('/workspaces/:workspaceId/sessions/:sessionId/messages', async (request, reply) => {
    const { workspaceId, sessionId } = request.params;

    const session = await getSession(sessionId);
    if (!session || session.workspace_id !== workspaceId) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const messages = await getSessionMessages(sessionId);
    return reply.send({ messages });
  });

  // GET /workspaces/:wsId/actors/:actorId/sessions — list actor's sessions
  app.get<{
    Params: { workspaceId: string; actorId: string };
    Querystring: { status?: string };
  }>('/workspaces/:workspaceId/actors/:actorId/sessions', async (request, reply) => {
    const { workspaceId, actorId } = request.params;
    const { status } = request.query as any;

    const sessions = await getSessionsByActor(workspaceId, actorId, status);
    return reply.send({ sessions });
  });

  // DELETE /workspaces/:wsId/sessions/:sessionId — cancel session
  app.delete<{
    Params: { workspaceId: string; sessionId: string };
  }>('/workspaces/:workspaceId/sessions/:sessionId', async (request, reply) => {
    const { workspaceId, sessionId } = request.params;

    const session = await getSession(sessionId);
    if (!session || session.workspace_id !== workspaceId) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    await cancelSession(sessionId);
    return reply.status(204).send();
  });
}
