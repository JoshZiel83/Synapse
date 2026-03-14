import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CanonicalContentBlock } from '@synapse/shared';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { authzEnabled, checkPermission } from '../../infrastructure/authz/index.js';
import { query } from '../../infrastructure/database/index.js';
import {
  createSession,
  getSession,
  getSessionsByActor,
  getSessionMessages,
  cancelSession,
  addSessionMessage,
} from './service.js';
import { enqueueSessionWakeup } from './runtime.js';

const createSessionSchema = z.object({
  content: z.string().max(10000).optional().default(''),
  contentBlocks: z.array(z.any()).optional(),
  channelType: z.enum(['web', 'im', 'api']).optional().default('web'),
}).refine(
  (body) => body.content.trim().length > 0 || (Array.isArray(body.contentBlocks) && body.contentBlocks.length > 0),
  { message: 'content or contentBlocks is required' },
);

const sendMessageSchema = z.object({
  content: z.string().max(10000).optional().default(''),
  contentBlocks: z.array(z.any()).optional(),
}).refine(
  (body) => body.content.trim().length > 0 || (Array.isArray(body.contentBlocks) && body.contentBlocks.length > 0),
  { message: 'content or contentBlocks is required' },
);

async function hasWorkspaceMembership(workspaceId: string, userId: string) {
  const result = await query(
    `SELECT 1
     FROM workspace_members
     WHERE workspace_id = $1 AND user_id = $2
     LIMIT 1`,
    [workspaceId, userId],
  );
  return result.rows.length > 0;
}

async function requireActorPermission(
  request: any,
  reply: any,
  actorId: string,
  permission: string,
  errorMessage: string,
) {
  const { workspaceId } = request.params as { workspaceId: string };
  const userId = (request as any).user!.userId;

  if (!authzEnabled()) {
    const allowed = await hasWorkspaceMembership(workspaceId, userId);
    if (!allowed) {
      reply.status(403).send({ error: errorMessage });
      return false;
    }
    return true;
  }

  const allowed = await checkPermission({
    resourceType: 'actor',
    resourceId: actorId,
    permission,
    subject: { type: 'user', id: userId },
  });

  if (!allowed) {
    reply.status(403).send({ error: errorMessage });
    return false;
  }

  return true;
}

async function requireSessionConversationPermission(
  request: any,
  reply: any,
  permission: string,
  errorMessage: string,
) {
  const { workspaceId, sessionId } = request.params as { workspaceId: string; sessionId: string };
  const session = await getSession(sessionId);
  if (!session || session.workspace_id !== workspaceId) {
    reply.status(404).send({ error: 'Session not found' });
    return null;
  }

  const userId = (request as any).user!.userId;
  if (!authzEnabled()) {
    const allowed = await hasWorkspaceMembership(workspaceId, userId);
    if (!allowed) {
      reply.status(403).send({ error: errorMessage });
      return null;
    }
    return session;
  }

  const allowed = await checkPermission({
    resourceType: 'conversation',
    resourceId: session.conversation_id,
    permission,
    subject: { type: 'user', id: userId },
  });

  if (!allowed) {
    reply.status(403).send({ error: errorMessage });
    return null;
  }

  return session;
}

export async function sessionController(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // POST /workspaces/:wsId/actors/:actorId/sessions — create a new session with any actor
  app.post<{
    Params: { workspaceId: string; actorId: string };
    Body: { content: string; channelType?: string };
  }>('/workspaces/:workspaceId/actors/:actorId/sessions', async (request, reply) => {
    const { workspaceId, actorId } = request.params;
    const { content, contentBlocks, channelType } = createSessionSchema.parse(request.body) as {
      content: string;
      contentBlocks?: CanonicalContentBlock[];
      channelType?: string;
    };
    const userId = (request as any).user!.userId;

    const allowed = await requireActorPermission(
      request,
      reply,
      actorId,
      'invoke',
      'Not allowed to invoke this actor',
    );
    if (!allowed) return;

    const session = await createSession({
      workspaceId,
      actorId,
      userId,
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
      contentBlocks,
      fromUserId: userId,
    });

    // Enqueue thinking
    await enqueueSessionWakeup({
      sessionId: session.id,
      actorId,
      workspaceId,
      sourceType: 'user_message',
      sourceMemberType: 'user',
      sourceMemberId: userId,
      summary: content.trim().slice(0, 96) || 'New message',
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
    const { content, contentBlocks } = sendMessageSchema.parse(request.body) as {
      content: string;
      contentBlocks?: CanonicalContentBlock[];
    };
    const userId = (request as any).user!.userId;

    const session = await requireSessionConversationPermission(
      request,
      reply,
      'send',
      'Not allowed to send messages in this session',
    );
    if (!session) return;

    if (session.status === 'closed') {
      return reply.status(400).send({ error: `Cannot send message to ${session.status} session` });
    }

    // Add user message to the session
    const message = await addSessionMessage({
      sessionId,
      workspaceId,
      role: 'user',
      content,
      contentBlocks,
      fromUserId: userId,
    });

    await enqueueSessionWakeup({
      sessionId,
      actorId: session.actor_id,
      workspaceId,
      sourceType: 'user_message',
      sourceMemberType: 'user',
      sourceMemberId: userId,
      summary: content.trim().slice(0, 96) || 'New message',
      trigger: 'user_message',
    });

    return reply.status(201).send({ messageId: message.id, status: 'processing' });
  });

  // GET /workspaces/:wsId/sessions/:sessionId — session details
  app.get<{
    Params: { workspaceId: string; sessionId: string };
  }>('/workspaces/:workspaceId/sessions/:sessionId', async (request, reply) => {
    const session = await requireSessionConversationPermission(
      request,
      reply,
      'view',
      'Not allowed to view this session',
    );
    if (!session) return;

    return reply.send({ session });
  });

  // GET /workspaces/:wsId/sessions/:sessionId/messages — session messages
  app.get<{
    Params: { workspaceId: string; sessionId: string };
  }>('/workspaces/:workspaceId/sessions/:sessionId/messages', async (request, reply) => {
    const { sessionId } = request.params;
    const session = await requireSessionConversationPermission(
      request,
      reply,
      'view',
      'Not allowed to view this session',
    );
    if (!session) return;

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

    const allowed = await requireActorPermission(
      request,
      reply,
      actorId,
      'view',
      'Not allowed to view this actor',
    );
    if (!allowed) return;

    const sessions = await getSessionsByActor(workspaceId, actorId, status);
    return reply.send({ sessions });
  });

  // DELETE /workspaces/:wsId/sessions/:sessionId — cancel session
  app.delete<{
    Params: { workspaceId: string; sessionId: string };
  }>('/workspaces/:workspaceId/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params;
    const session = await requireSessionConversationPermission(
      request,
      reply,
      'manage',
      'Not allowed to manage this session',
    );
    if (!session) return;

    await cancelSession(sessionId);
    return reply.status(204).send();
  });
}
