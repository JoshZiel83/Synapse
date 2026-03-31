import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CANONICAL_FILE_CATEGORIES,
  MEMORY_CATEGORIES,
  MEMORY_RECALL_TYPES,
  MEMORY_SCOPES,
  MEMORY_STABILITIES,
  MEMORY_STATUSES,
} from '@synapse/shared/constants';
import { buildActorConversationContextId } from '../../infrastructure/authz/index.js';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { workspaceMiddleware } from '../../infrastructure/middleware/workspace.js';
import { requireRequestAction } from '../access/guards.js';
import {
  authorizeAction,
  authorizePermission,
  getRequestAccessSubject,
  getRequestUserId,
  listAuthorizedResourceIds,
} from '../access/service.js';
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

const memoryOwnerScopeEnum = z.enum(MEMORY_SCOPES);
const memoryCategoryEnum = z.enum(MEMORY_CATEGORIES);
const memoryStatusEnum = z.enum(MEMORY_STATUSES);
const memoryStabilityEnum = z.enum(MEMORY_STABILITIES);
const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().uuid().optional(),
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    id: z.string().uuid().optional(),
    type: z.literal('file_ref'),
    fileId: z.string().uuid(),
    storedName: z.string(),
    url: z.string(),
    mimeType: z.string(),
    originalName: z.string(),
    sizeBytes: z.number(),
    category: z.enum(CANONICAL_FILE_CATEGORIES),
  }),
]);

const memoryPayloadSchema = z.object({
  ownerScope: memoryOwnerScopeEnum,
  ownerActorId: z.string().uuid().optional(),
  ownerConversationId: z.string().uuid().optional(),
  ownerUserId: z.string().uuid().optional(),
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
  ownerScope: memoryOwnerScopeEnum.optional(),
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
  scopes: z.array(memoryOwnerScopeEnum).optional(),
  categories: z.array(memoryCategoryEnum).optional(),
  statuses: z.array(memoryStatusEnum).optional(),
  stabilities: z.array(memoryStabilityEnum).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  metadata: z.record(z.any()).optional(),
});

const recallMemoriesSchema = searchMemoriesSchema.extend({
  recallType: z.enum(MEMORY_RECALL_TYPES.filter((value) => value !== 'manual_search') as ['bootstrap', 'turn_recall']),
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

async function requireWorkspacePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  action: 'workspace.view' | 'workspace.manage_memories',
  errorMessage: string,
) {
  const { workspaceId } = request.params as { workspaceId: string };
  return requireRequestAction(request, reply, action, workspaceId, errorMessage);
}

async function requireMemoryPermission(
  request: FastifyRequest,
  reply: FastifyReply,
  memoryId: string,
  permission: 'read' | 'edit' | 'retarget' | 'delete',
  errorMessage: string,
) {
  const allowed = await authorizePermission({
    subject: getRequestAccessSubject(request),
    resourceType: 'memory',
    resourceId: memoryId,
    permission,
  });

  if (!allowed) {
    reply.status(403).send({ error: errorMessage });
    return false;
  }

  return true;
}

async function requireMemoryAnchorPermission(
  request: FastifyRequest,
  reply: FastifyReply,
  body: Pick<z.infer<typeof memoryPayloadSchema>, 'ownerScope' | 'ownerActorId' | 'ownerConversationId' | 'ownerUserId'>,
  errorMessage: string,
) {
  const userId = getRequestUserId(request);
  const { workspaceId } = request.params as { workspaceId: string };

  let allowed = false;
  switch (body.ownerScope) {
    case 'workspace':
      allowed = await authorizeAction({
        subject: getRequestAccessSubject(request),
        action: 'workspace.manage_memories',
        resourceId: workspaceId,
      });
      break;
    case 'conversation':
      if (body.ownerConversationId) {
        allowed = await authorizePermission({
          subject: getRequestAccessSubject(request),
          resourceType: 'conversation',
          resourceId: body.ownerConversationId,
          permission: 'memory_edit',
        });
      }
      break;
    case 'actor_global':
      if (body.ownerActorId) {
        allowed = await authorizePermission({
          subject: getRequestAccessSubject(request),
          resourceType: 'actor',
          resourceId: body.ownerActorId,
          permission: 'memory_edit',
        });
      }
      break;
    case 'actor_conversation':
      if (body.ownerActorId && body.ownerConversationId) {
        allowed = await authorizePermission({
          subject: getRequestAccessSubject(request),
          resourceType: 'actor_conversation',
          resourceId: buildActorConversationContextId(body.ownerActorId, body.ownerConversationId),
          permission: 'memory_edit',
        });
      }
      break;
    case 'user':
      allowed = body.ownerUserId === userId;
      if (!allowed) {
        allowed = await authorizeAction({
          subject: getRequestAccessSubject(request),
          action: 'workspace.manage_memories',
          resourceId: workspaceId,
        });
      }
      break;
  }

  if (!allowed) {
    reply.status(403).send({ error: errorMessage });
    return false;
  }

  return true;
}

function resolveTargetScope(
  existing: Awaited<ReturnType<typeof getMemory>>,
  body: z.infer<typeof updateMemorySchema>,
) {
  return {
    ownerScope: body.ownerScope ?? existing.ownerScope,
    ownerActorId: body.ownerActorId !== undefined ? body.ownerActorId : existing.ownerActorId,
    ownerConversationId: body.ownerConversationId !== undefined ? body.ownerConversationId : existing.ownerConversationId,
    ownerUserId: body.ownerUserId !== undefined ? body.ownerUserId : existing.ownerUserId,
  };
}

function updateTouchesMemoryEdit(body: z.infer<typeof updateMemorySchema>) {
  return (
    body.category !== undefined ||
    body.status !== undefined ||
    body.stability !== undefined ||
    body.importance !== undefined ||
    body.confidence !== undefined ||
    body.tags !== undefined ||
    body.content !== undefined ||
    body.contentBlocks !== undefined ||
    body.textDigest !== undefined ||
    body.searchText !== undefined ||
    body.sourceItemId !== undefined ||
    body.sourceToolCallId !== undefined ||
    body.sourceTurnId !== undefined ||
    body.supersedesMemoryId !== undefined ||
    body.metadata !== undefined
  );
}

function updateTouchesMemoryRetarget(body: z.infer<typeof updateMemorySchema>) {
  return (
    body.ownerScope !== undefined ||
    body.ownerActorId !== undefined ||
    body.ownerConversationId !== undefined ||
    body.ownerUserId !== undefined
  );
}

export function registerMemoryRoutes(app: FastifyInstance) {
  const prefix = '/api/v1/workspaces/:workspaceId/memories';
  const preHandler = [authMiddleware, workspaceMiddleware];

  app.post(prefix, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = createMemorySchema.parse(request.body);
      const { workspaceId } = request.params as { workspaceId: string };
      const allowed = await requireMemoryAnchorPermission(
        request,
        reply,
        body,
        'Not allowed to create a memory in this folder',
      );
      if (!allowed) return;

      const memory = await createMemory(workspaceId, body);
      return reply.status(201).send({ memory });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get(prefix, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allowed = await requireWorkspacePermission(
        request,
        reply,
        'workspace.view',
        'Not allowed to view this workspace',
      );
      if (!allowed) return;

      const { workspaceId } = request.params as { workspaceId: string };
      const filters = listMemoriesSchema.parse(request.query);
      let memories = await listMemories(workspaceId, filters);
      const allowedIds = await listAuthorizedResourceIds({
        subject: getRequestAccessSubject(request),
        action: 'memory.read',
      });
      const allowedIdSet = new Set(allowedIds);
      memories = memories.filter((memory) => allowedIdSet.has(memory.id));
      return reply.status(200).send({ memories });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get(`${prefix}/:memoryId`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allowed = await requireWorkspacePermission(
        request,
        reply,
        'workspace.view',
        'Not allowed to view this workspace',
      );
      if (!allowed) return;

      const { workspaceId, memoryId } = request.params as { workspaceId: string; memoryId: string };
      const memory = await getMemory(workspaceId, memoryId);
      const readable = await authorizePermission({
        subject: getRequestAccessSubject(request),
        resourceType: 'memory',
        resourceId: memoryId,
        permission: 'read',
      });
      if (!readable) {
        return reply.status(403).send({ error: 'Not allowed to read this memory' });
      }
      return reply.status(200).send({ memory });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.put(`${prefix}/:memoryId`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId, memoryId } = request.params as { workspaceId: string; memoryId: string };
      const body = updateMemorySchema.parse(request.body);
      const existing = await getMemory(workspaceId, memoryId);

      if (updateTouchesMemoryEdit(body)) {
        const allowed = await requireMemoryPermission(
          request,
          reply,
          memoryId,
          'edit',
          'Not allowed to edit this memory',
        );
        if (!allowed) return;
      }

      if (updateTouchesMemoryRetarget(body)) {
        const allowed = await requireMemoryPermission(
          request,
          reply,
          memoryId,
          'retarget',
          'Not allowed to move this memory',
        );
        if (!allowed) return;

        const targetScope = resolveTargetScope(existing, body);
        const canMoveToTarget = await requireMemoryAnchorPermission(
          request,
          reply,
          targetScope,
          'Not allowed to move this memory into the selected folder',
        );
        if (!canMoveToTarget) return;
      }

      const memory = await updateMemory(workspaceId, memoryId, body);
      return reply.status(200).send({ memory });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.delete(`${prefix}/:memoryId`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId, memoryId } = request.params as { workspaceId: string; memoryId: string };
      const allowed = await requireMemoryPermission(
        request,
        reply,
        memoryId,
        'delete',
        'Not allowed to delete this memory',
      );
      if (!allowed) return;

      await deleteMemory(workspaceId, memoryId);
      return reply.status(204).send();
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post(`${prefix}/search`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allowed = await requireWorkspacePermission(
        request,
        reply,
        'workspace.view',
        'Not allowed to view this workspace',
      );
      if (!allowed) return;

      const { workspaceId } = request.params as { workspaceId: string };
      const body = searchMemoriesSchema.parse(request.body);
      const result = await runMemorySearch(workspaceId, body);
      const allowedIds = await listAuthorizedResourceIds({
        subject: getRequestAccessSubject(request),
        action: 'memory.read',
      });
      const allowedIdSet = new Set(allowedIds);
      result.memories = result.memories.filter((memory) => allowedIdSet.has(memory.id));
      return reply.status(200).send(result);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post(`${prefix}/recall`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allowed = await requireWorkspacePermission(
        request,
        reply,
        'workspace.view',
        'Not allowed to view this workspace',
      );
      if (!allowed) return;

      const { workspaceId } = request.params as { workspaceId: string };
      const body = recallMemoriesSchema.parse(request.body);
      const result = await recallMemories(workspaceId, body);
      const allowedIds = await listAuthorizedResourceIds({
        subject: getRequestAccessSubject(request),
        action: 'memory.read',
      });
      const allowedIdSet = new Set(allowedIds);
      result.memories = result.memories.filter((memory) => allowedIdSet.has(memory.id));
      return reply.status(200).send(result);
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
