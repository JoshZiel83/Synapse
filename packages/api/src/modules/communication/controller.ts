import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { workspaceMiddleware } from '../../infrastructure/middleware/workspace.js';
import {
  createMessage,
  listMessages,
  getConversation,
  getWorkItemMessages,
  MessageError,
} from './service.js';

const createMessageSchema = z.object({
  type: z.string().min(1, 'Message type is required'),
  content: z.string().min(1, 'Content is required'),
  fromActorId: z.string().uuid().optional(),
  toActorId: z.string().uuid().optional(),
  fromUserId: z.string().uuid().optional(),
  toUserId: z.string().uuid().optional(),
  workItemId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const listMessagesSchema = z.object({
  workItemId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  type: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

function handleError(error: unknown, reply: FastifyReply) {
  if (error instanceof MessageError) {
    return reply.status(error.statusCode).send({ error: error.message });
  }
  if (error instanceof z.ZodError) {
    return reply.status(400).send({
      error: 'Validation failed',
      details: error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    });
  }
  throw error;
}

export function registerCommunicationRoutes(app: FastifyInstance) {
  const prefix = '/api/v1/workspaces/:workspaceId/messages';
  const preHandler = [authMiddleware, workspaceMiddleware];

  // POST / - create message
  app.post(prefix, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const body = createMessageSchema.parse(request.body);
      const message = await createMessage(workspaceId, body as any);
      return reply.status(201).send({ message });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  // GET / - list messages
  app.get(prefix, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const filters = listMessagesSchema.parse(request.query);
      const result = await listMessages(workspaceId, filters as any);
      return reply.status(200).send(result);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  // GET /conversation/:actorId - get conversation thread for an actor
  app.get(
    `${prefix}/conversation/:actorId`,
    { preHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { workspaceId, actorId } = request.params as {
          workspaceId: string;
          actorId: string;
        };
        const messages = await getConversation(workspaceId, actorId);
        return reply.status(200).send({ messages });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  // GET /work-item/:workItemId - get all messages for a work item
  app.get(
    `${prefix}/work-item/:workItemId`,
    { preHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { workspaceId, workItemId } = request.params as {
          workspaceId: string;
          workItemId: string;
        };
        const messages = await getWorkItemMessages(workspaceId, workItemId);
        return reply.status(200).send({ messages });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );
}
