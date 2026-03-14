import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authzEnabled, buildActorConversationContextId, checkPermission, lookupResources } from '../../infrastructure/authz/index.js';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { workspaceMiddleware } from '../../infrastructure/middleware/workspace.js';
import { query } from '../../infrastructure/database/index.js';
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

const memoryOwnerScopeEnum = z.enum(['workspace', 'conversation', 'actor_global', 'actor_conversation', 'user']);
const memoryGrantScopeEnum = z.enum(['workspace', 'conversation', 'actor_global', 'actor_conversation', 'user', 'workspace_user']);
const memoryPermissionEnum = z.enum(['read', 'edit', 'grant', 'retarget', 'delete']);
const memoryCategoryEnum = z.enum(['fact', 'preference', 'decision', 'relationship', 'procedure', 'artifact', 'summary']);
const memoryStatusEnum = z.enum(['candidate', 'established', 'superseded', 'retracted']);
const memoryStabilityEnum = z.enum(['ephemeral', 'durable']);
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
    category: z.enum(['image', 'audio', 'video', 'document']),
  }),
]);

const memoryGrantSchema = z.object({
  permission: memoryPermissionEnum.optional(),
  grantScope: memoryGrantScopeEnum,
  actorId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  reason: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

const memoryPayloadSchema = z.object({
  ownerScope: memoryOwnerScopeEnum,
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

async function requireWorkspacePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  permission: string,
  errorMessage: string,
) {
  const { workspaceId } = request.params as { workspaceId: string };
  const userId = (request as any).user?.userId as string;

  if (!authzEnabled()) {
    const allowed = await hasWorkspaceMembership(workspaceId, userId);
    if (!allowed) {
      reply.status(403).send({ error: errorMessage });
      return false;
    }
    return true;
  }

  const allowed = await checkPermission({
    resourceType: 'workspace',
    resourceId: workspaceId,
    permission,
    subject: { type: 'user', id: userId },
  });

  if (!allowed) {
    reply.status(403).send({ error: errorMessage });
    return false;
  }

  return true;
}

async function requireMemoryPermission(
  request: FastifyRequest,
  reply: FastifyReply,
  memoryId: string,
  permission: 'read' | 'edit' | 'grant' | 'retarget' | 'delete',
  errorMessage: string,
) {
  if (!authzEnabled()) {
    return requireWorkspacePermission(
      request,
      reply,
      permission === 'read' ? 'view' : 'manage_memories',
      errorMessage,
    );
  }

  const allowed = await checkPermission({
    resourceType: 'memory',
    resourceId: memoryId,
    permission,
    subject: { type: 'user', id: (request as any).user.userId },
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
  body: z.infer<typeof memoryPayloadSchema>,
  permission: 'edit' | 'grant',
  errorMessage: string,
) {
  const userId = (request as any).user.userId as string;
  const { workspaceId } = request.params as { workspaceId: string };

  if (!authzEnabled()) {
    return requireWorkspacePermission(
      request,
      reply,
      'manage_memories',
      errorMessage,
    );
  }

  let allowed = false;
  switch (body.ownerScope) {
    case 'workspace':
      allowed = await checkPermission({
        resourceType: 'workspace',
        resourceId: workspaceId,
        permission: 'manage_memories',
        subject: { type: 'user', id: userId },
      });
      break;
    case 'conversation':
      if (body.ownerConversationId) {
        allowed = await checkPermission({
          resourceType: 'conversation',
          resourceId: body.ownerConversationId,
          permission: permission === 'grant' ? 'memory_grant' : 'memory_edit',
          subject: { type: 'user', id: userId },
        });
      }
      break;
    case 'actor_global':
      if (body.ownerActorId) {
        allowed = await checkPermission({
          resourceType: 'actor',
          resourceId: body.ownerActorId,
          permission: permission === 'grant' ? 'memory_grant' : 'memory_edit',
          subject: { type: 'user', id: userId },
        });
      }
      break;
    case 'actor_conversation':
      if (body.ownerActorId && body.ownerConversationId) {
        allowed = await checkPermission({
          resourceType: 'actor_conversation',
          resourceId: buildActorConversationContextId(body.ownerActorId, body.ownerConversationId),
          permission: permission === 'grant' ? 'memory_grant' : 'memory_edit',
          subject: { type: 'user', id: userId },
        });
      }
      break;
    case 'user':
      allowed = body.ownerUserId === userId;
      if (!allowed) {
        allowed = await checkPermission({
          resourceType: 'workspace',
          resourceId: workspaceId,
          permission: 'manage_memories',
          subject: { type: 'user', id: userId },
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

function updateTouchesMemoryGrant(body: z.infer<typeof updateMemorySchema>) {
  return body.grants !== undefined;
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
      const user = (request as any).user;
      const allowed = await requireMemoryAnchorPermission(
        request,
        reply,
        body,
        'edit',
        'Not allowed to create a memory in this scope',
      );
      if (!allowed) return;
      if ((body.grants?.length || 0) > 0) {
        const canGrant = await requireMemoryAnchorPermission(
          request,
          reply,
          body,
          'grant',
          'Not allowed to grant access while creating this memory',
        );
        if (!canGrant) return;
      }

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
      const allowed = await requireWorkspacePermission(
        request,
        reply,
        'view',
        'Not allowed to view this workspace',
      );
      if (!allowed) return;

      const { workspaceId } = request.params as { workspaceId: string };
      const filters = listMemoriesSchema.parse(request.query);
      let memories = await listMemories(workspaceId, filters);
      if (authzEnabled()) {
        const allowedIds = await lookupResources({
          resourceType: 'memory',
          permission: 'read',
          subject: { type: 'user', id: (request as any).user.userId },
        });
        const allowedIdSet = new Set(allowedIds);
        memories = memories.filter((memory) => allowedIdSet.has(memory.id));
      }
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
        'view',
        'Not allowed to view this workspace',
      );
      if (!allowed) return;

      const { workspaceId, memoryId } = request.params as { workspaceId: string; memoryId: string };
      const memory = await getMemory(workspaceId, memoryId);
      if (authzEnabled()) {
        const readable = await checkPermission({
          resourceType: 'memory',
          resourceId: memoryId,
          permission: 'read',
          subject: { type: 'user', id: (request as any).user.userId },
        });
        if (!readable) {
          return reply.status(403).send({ error: 'Not allowed to read this memory' });
        }
      }
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
      await getMemory(workspaceId, memoryId);

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

      if (updateTouchesMemoryGrant(body)) {
        const allowed = await requireMemoryPermission(
          request,
          reply,
          memoryId,
          'grant',
          'Not allowed to manage grants on this memory',
        );
        if (!allowed) return;
      }

      if (updateTouchesMemoryRetarget(body)) {
        const allowed = await requireMemoryPermission(
          request,
          reply,
          memoryId,
          'retarget',
          'Not allowed to change the owner scope of this memory',
        );
        if (!allowed) return;
      }

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
        'view',
        'Not allowed to view this workspace',
      );
      if (!allowed) return;

      const { workspaceId } = request.params as { workspaceId: string };
      const body = searchMemoriesSchema.parse(request.body);
      const result = await runMemorySearch(workspaceId, body);
      if (authzEnabled()) {
        const allowedIds = await lookupResources({
          resourceType: 'memory',
          permission: 'read',
          subject: { type: 'user', id: (request as any).user.userId },
        });
        const allowedIdSet = new Set(allowedIds);
        result.memories = result.memories.filter((memory) => allowedIdSet.has(memory.id));
      }
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
        'view',
        'Not allowed to view this workspace',
      );
      if (!allowed) return;

      const { workspaceId } = request.params as { workspaceId: string };
      const body = recallMemoriesSchema.parse(request.body);
      const result = await recallMemories(workspaceId, body);
      if (authzEnabled()) {
        const allowedIds = await lookupResources({
          resourceType: 'memory',
          permission: 'read',
          subject: { type: 'user', id: (request as any).user.userId },
        });
        const allowedIdSet = new Set(allowedIds);
        result.memories = result.memories.filter((memory) => allowedIdSet.has(memory.id));
      }
      return reply.status(200).send(result);
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
