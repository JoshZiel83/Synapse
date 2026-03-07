import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { workspaceMiddleware } from '../../infrastructure/middleware/workspace.js';
import {
  createMemory,
  getMemory,
  updateMemory,
  deleteMemory,
  listMemories,
  searchMemories,
  recallMemories,
  MemoryError,
} from './service.js';

const memoryCategoryEnum = z.enum(['working', 'experiential', 'knowledge', 'procedural', 'relational']);
const memoryScopeEnum = z.enum(['private', 'team', 'workspace']);

const createMemorySchema = z.object({
  actorId: z.string().uuid().optional(),
  category: memoryCategoryEnum,
  scope: memoryScopeEnum,
  content: z.string().min(1, 'Content is required'),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  importance: z.number().min(0).max(1).optional(),
  sourceWorkItemId: z.string().uuid().optional(),
});

const updateMemorySchema = z.object({
  category: memoryCategoryEnum.optional(),
  scope: memoryScopeEnum.optional(),
  content: z.string().min(1).optional(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  importance: z.number().min(0).max(1).optional(),
});

const listMemoriesSchema = z.object({
  actorId: z.string().uuid().optional(),
  category: memoryCategoryEnum.optional(),
  scope: memoryScopeEnum.optional(),
  tags: z
    .union([z.string().transform((s) => s.split(',')), z.array(z.string())])
    .optional(),
});

const searchMemoriesSchema = z.object({
  query: z.string().min(1, 'Search query is required'),
  actorId: z.string().uuid().optional(),
  category: memoryCategoryEnum.optional(),
  scope: memoryScopeEnum.optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const recallMemoriesSchema = z.object({
  actorId: z.string().uuid(),
  context: z.string().min(1, 'Context is required'),
  categories: z.array(memoryCategoryEnum).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

function handleError(error: unknown, reply: FastifyReply) {
  if (error instanceof MemoryError) {
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

export function registerMemoryRoutes(app: FastifyInstance) {
  const prefix = '/api/v1/workspaces/:workspaceId/memories';
  const preHandler = [authMiddleware, workspaceMiddleware];

  // POST / - create memory
  app.post(prefix, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const body = createMemorySchema.parse(request.body);
      const memory = await createMemory(workspaceId, body);
      return reply.status(201).send({ memory });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  // GET / - list memories
  app.get(prefix, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const filters = listMemoriesSchema.parse(request.query);
      const memories = await listMemories(workspaceId, filters);
      return reply.status(200).send({ memories });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  // GET /:memoryId - get memory
  app.get(
    `${prefix}/:memoryId`,
    { preHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { workspaceId, memoryId } = request.params as {
          workspaceId: string;
          memoryId: string;
        };
        const memory = await getMemory(workspaceId, memoryId);
        return reply.status(200).send({ memory });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  // PUT /:memoryId - update memory
  app.put(
    `${prefix}/:memoryId`,
    { preHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { workspaceId, memoryId } = request.params as {
          workspaceId: string;
          memoryId: string;
        };
        const body = updateMemorySchema.parse(request.body);
        const memory = await updateMemory(workspaceId, memoryId, body);
        return reply.status(200).send({ memory });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  // DELETE /:memoryId - delete memory
  app.delete(
    `${prefix}/:memoryId`,
    { preHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { workspaceId, memoryId } = request.params as {
          workspaceId: string;
          memoryId: string;
        };
        await deleteMemory(workspaceId, memoryId);
        return reply.status(204).send();
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  // POST /search - search memories
  app.post(
    `${prefix}/search`,
    { preHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { workspaceId } = request.params as { workspaceId: string };
        const body = searchMemoriesSchema.parse(request.body);
        const memories = await searchMemories(workspaceId, body);
        return reply.status(200).send({ memories });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  // POST /recall - recall relevant memories for an actor
  app.post(
    `${prefix}/recall`,
    { preHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { workspaceId } = request.params as { workspaceId: string };
        const body = recallMemoriesSchema.parse(request.body);
        const memories = await recallMemories(workspaceId, body);
        return reply.status(200).send({ memories });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );
}
