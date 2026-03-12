import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { workspaceMiddleware } from '../../infrastructure/middleware/workspace.js';
import {
  createMemory,
  deleteMemory,
  getMemory,
  listMemories,
  MemoryError,
  recallMemories,
  runMemorySearch,
  updateMemory,
} from './service.js';

const memoryScopeEnum = z.enum(['workspace', 'conversation', 'actor_global', 'actor_conversation', 'user']);
const memoryCategoryEnum = z.enum(['fact', 'preference', 'decision', 'relationship', 'procedure', 'artifact', 'summary']);
const memoryStatusEnum = z.enum(['candidate', 'established', 'superseded', 'retracted']);
const memoryStabilityEnum = z.enum(['ephemeral', 'durable']);
const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('file_ref'),
    fileId: z.string().uuid(),
    storedName: z.string(),
    url: z.string(),
    mimeType: z.string(),
    originalName: z.string(),
    sizeBytes: z.number(),
    category: z.enum(['image', 'audio', 'video', 'document']),
  }),
]);

const memoryGrantSchema = z.object({
  grantScope: memoryScopeEnum,
  actorId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  reason: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

const memoryPayloadSchema = z.object({
  ownerScope: memoryScopeEnum,
  ownerActorId: z.string().uuid().optional(),
  ownerConversationId: z.string().uuid().optional(),
  ownerUserId: z.string().uuid().optional(),
  grants: z.array(memoryGrantSchema).optional(),
  category: memoryCategoryEnum,
  status: memoryStatusEnum.optional(),
  stability: memoryStabilityEnum.optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  content: z.string().optional(),
  contentBlocks: z.array(contentBlockSchema).optional(),
  textDigest: z.string().optional(),
  searchText: z.string().optional(),
  sourceItemId: z.string().uuid().optional(),
  sourceToolCallId: z.string().uuid().optional(),
  sourceTurnId: z.string().uuid().optional(),
  supersedesMemoryId: z.string().uuid().optional(),
  metadata: z.record(z.any()).optional(),
});

const createMemorySchema = memoryPayloadSchema.refine((value) => !!value.content || !!value.contentBlocks || !!value.textDigest, {
  message: 'content, contentBlocks, or textDigest is required',
});

const updateMemorySchema = memoryPayloadSchema.partial();

const listMemoriesSchema = z.object({
  actorId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  userCount: z.coerce.number().int().min(0).optional(),
  ownerScope: memoryScopeEnum.optional(),
  category: memoryCategoryEnum.optional(),
  status: memoryStatusEnum.optional(),
  stability: memoryStabilityEnum.optional(),
  tags: z.union([z.string().transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean)), z.array(z.string())]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const searchMemoriesSchema = z.object({
  queryText: z.string().min(1),
  actorId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  userCount: z.coerce.number().int().min(0).optional(),
  scopes: z.array(memoryScopeEnum).optional(),
  categories: z.array(memoryCategoryEnum).optional(),
  statuses: z.array(memoryStatusEnum).optional(),
  stabilities: z.array(memoryStabilityEnum).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  metadata: z.record(z.any()).optional(),
});

const recallMemoriesSchema = searchMemoriesSchema.extend({
  recallType: z.enum(['bootstrap', 'turn_recall']),
  queryBlocks: z.array(contentBlockSchema).optional(),
});

function handleError(error: unknown, reply: FastifyReply) {
  if (error instanceof MemoryError) {
    return reply.status(error.statusCode).send({ error: error.message });
  }
  if (error instanceof z.ZodError) {
    return reply.status(400).send({
      error: 'Validation failed',
      details: error.errors.map((item) => ({
        field: item.path.join('.'),
        message: item.message,
      })),
    });
  }
  throw error;
}

export function registerMemoryRoutes(app: FastifyInstance) {
  const prefix = '/api/v1/workspaces/:workspaceId/memories';
  const preHandler = [authMiddleware, workspaceMiddleware];

  app.post(prefix, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const user = (request as any).user;
      const body = createMemorySchema.parse(request.body);
      const memory = await createMemory(workspaceId, {
        ...body,
        grantedBy: user?.id || user?.userId,
      });
      return reply.status(201).send({ memory });
    } catch (error) {
      return handleError(error, reply);
    }
  });

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

  app.get(`${prefix}/:memoryId`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId, memoryId } = request.params as { workspaceId: string; memoryId: string };
      const memory = await getMemory(workspaceId, memoryId);
      return reply.status(200).send({ memory });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.put(`${prefix}/:memoryId`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId, memoryId } = request.params as { workspaceId: string; memoryId: string };
      const user = (request as any).user;
      const body = updateMemorySchema.parse(request.body);
      const memory = await updateMemory(workspaceId, memoryId, {
        ...body,
        grantedBy: user?.id || user?.userId,
      });
      return reply.status(200).send({ memory });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.delete(`${prefix}/:memoryId`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId, memoryId } = request.params as { workspaceId: string; memoryId: string };
      await deleteMemory(workspaceId, memoryId);
      return reply.status(204).send();
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post(`${prefix}/search`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const body = searchMemoriesSchema.parse(request.body);
      const result = await runMemorySearch(workspaceId, body);
      return reply.status(200).send(result);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post(`${prefix}/recall`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const body = recallMemoriesSchema.parse(request.body);
      const result = await recallMemories(workspaceId, body);
      return reply.status(200).send(result);
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
