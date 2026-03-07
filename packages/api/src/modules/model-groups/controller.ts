import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { workspaceMiddleware } from '../../infrastructure/middleware/workspace.js';
import {
  listModelGroups,
  getModelGroup,
  createModelGroup,
  updateModelGroup,
  deleteModelGroup,
  addModelItem,
  updateModelItem,
  deleteModelItem,
  getItemVersions,
  getActorModelGroups,
  setActorModelGroups,
  ModelGroupError,
} from './service.js';

const routingStrategyEnum = z.enum(['weighted_random', 'round_robin', 'priority_failover']);
const providerTypeEnum = z.enum(['anthropic', 'openai']);

const createGroupSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  routingStrategy: routingStrategyEnum.optional(),
  isDefault: z.boolean().optional(),
});

const updateGroupSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  routingStrategy: routingStrategyEnum.optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const addItemSchema = z.object({
  displayName: z.string().min(1).max(255),
  priority: z.number().int().optional(),
  weight: z.number().int().min(0).max(1000).optional(),
  providerType: providerTypeEnum,
  apiKey: z.string().min(1),
  baseUrl: z.string().min(1),
  modelName: z.string().min(1),
  maxTokens: z.number().int().positive().optional(),
  inputTokenCostMicros: z.number().int().min(0).optional(),
  outputTokenCostMicros: z.number().int().min(0).optional(),
  capabilityTags: z.array(z.string()).optional(),
  extraConfig: z.record(z.unknown()).optional(),
});

const updateItemSchema = z.object({
  displayName: z.string().min(1).max(255).optional(),
  priority: z.number().int().optional(),
  weight: z.number().int().min(0).max(1000).optional(),
  isEnabled: z.boolean().optional(),
  providerType: providerTypeEnum.optional(),
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().min(1).optional(),
  modelName: z.string().min(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  inputTokenCostMicros: z.number().int().min(0).optional(),
  outputTokenCostMicros: z.number().int().min(0).optional(),
  capabilityTags: z.array(z.string()).optional(),
  extraConfig: z.record(z.unknown()).optional(),
});

const setActorGroupsSchema = z.object({
  groups: z.array(z.object({
    groupId: z.string().uuid(),
    priority: z.number().int(),
  })),
});

function handleError(error: unknown, reply: FastifyReply) {
  if (error instanceof ModelGroupError) {
    return reply.status(error.statusCode).send({ error: error.message });
  }
  if (error instanceof z.ZodError) {
    return reply.status(400).send({
      error: 'Validation failed',
      details: error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
    });
  }
  throw error;
}

export function registerModelGroupRoutes(app: FastifyInstance) {
  const wsPrefix = '/api/v1/workspaces/:workspaceId/model-groups';
  const platformPrefix = '/api/v1/platform/model-groups';
  const wsPreHandler = [authMiddleware, workspaceMiddleware];
  const authPreHandler = [authMiddleware];

  // ========== Workspace-scoped routes ==========

  // GET /workspaces/:wsId/model-groups
  app.get(wsPrefix, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const groups = await listModelGroups(workspaceId);
      return reply.send({ groups });
    } catch (error) { return handleError(error, reply); }
  });

  // POST /workspaces/:wsId/model-groups
  app.post(wsPrefix, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const body = createGroupSchema.parse(request.body);
      const userId = (request as any).user.userId;
      const group = await createModelGroup({ ...body, workspaceId, createdBy: userId });
      return reply.status(201).send({ group });
    } catch (error) { return handleError(error, reply); }
  });

  // GET /workspaces/:wsId/model-groups/:groupId
  app.get(`${wsPrefix}/:groupId`, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { groupId } = request.params as { groupId: string };
      const group = await getModelGroup(groupId);
      return reply.send({ group });
    } catch (error) { return handleError(error, reply); }
  });

  // PUT /workspaces/:wsId/model-groups/:groupId
  app.put(`${wsPrefix}/:groupId`, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { groupId } = request.params as { groupId: string };
      const body = updateGroupSchema.parse(request.body);
      const group = await updateModelGroup(groupId, body);
      return reply.send({ group });
    } catch (error) { return handleError(error, reply); }
  });

  // DELETE /workspaces/:wsId/model-groups/:groupId
  app.delete(`${wsPrefix}/:groupId`, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { groupId } = request.params as { groupId: string };
      await deleteModelGroup(groupId);
      return reply.status(204).send();
    } catch (error) { return handleError(error, reply); }
  });

  // POST /workspaces/:wsId/model-groups/:groupId/items
  app.post(`${wsPrefix}/:groupId/items`, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { groupId } = request.params as { groupId: string };
      const body = addItemSchema.parse(request.body);
      const item = await addModelItem(groupId, body);
      return reply.status(201).send({ item });
    } catch (error) { return handleError(error, reply); }
  });

  // PUT /workspaces/:wsId/model-groups/:groupId/items/:itemId
  app.put(`${wsPrefix}/:groupId/items/:itemId`, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { groupId, itemId } = request.params as { groupId: string; itemId: string };
      const body = updateItemSchema.parse(request.body);
      const item = await updateModelItem(groupId, itemId, body);
      return reply.send({ item });
    } catch (error) { return handleError(error, reply); }
  });

  // DELETE /workspaces/:wsId/model-groups/:groupId/items/:itemId
  app.delete(`${wsPrefix}/:groupId/items/:itemId`, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { groupId, itemId } = request.params as { groupId: string; itemId: string };
      await deleteModelItem(groupId, itemId);
      return reply.status(204).send();
    } catch (error) { return handleError(error, reply); }
  });

  // GET /workspaces/:wsId/model-groups/:groupId/items/:itemId/versions
  app.get(`${wsPrefix}/:groupId/items/:itemId/versions`, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { itemId } = request.params as { itemId: string };
      const versions = await getItemVersions(itemId);
      return reply.send({ versions });
    } catch (error) { return handleError(error, reply); }
  });

  // ========== Actor assignment routes ==========

  // GET /workspaces/:wsId/actors/:actorId/model-groups
  app.get('/api/v1/workspaces/:workspaceId/actors/:actorId/model-groups', { preHandler: wsPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { actorId } = request.params as { actorId: string };
        const groups = await getActorModelGroups(actorId);
        return reply.send({ groups });
      } catch (error) { return handleError(error, reply); }
    }
  );

  // PUT /workspaces/:wsId/actors/:actorId/model-groups
  app.put('/api/v1/workspaces/:workspaceId/actors/:actorId/model-groups', { preHandler: wsPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { actorId } = request.params as { actorId: string };
        const body = setActorGroupsSchema.parse(request.body);
        const groups = await setActorModelGroups(actorId, body.groups);
        return reply.send({ groups });
      } catch (error) { return handleError(error, reply); }
    }
  );

  // ========== Platform-scoped routes ==========

  // GET /platform/model-groups
  app.get(platformPrefix, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const groups = await listModelGroups(null);
      return reply.send({ groups });
    } catch (error) { return handleError(error, reply); }
  });

  // POST /platform/model-groups
  app.post(platformPrefix, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = createGroupSchema.parse(request.body);
      const userId = (request as any).user.userId;
      const group = await createModelGroup({ ...body, createdBy: userId });
      return reply.status(201).send({ group });
    } catch (error) { return handleError(error, reply); }
  });

  // GET /platform/model-groups/:groupId
  app.get(`${platformPrefix}/:groupId`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { groupId } = request.params as { groupId: string };
      const group = await getModelGroup(groupId);
      return reply.send({ group });
    } catch (error) { return handleError(error, reply); }
  });

  // PUT /platform/model-groups/:groupId
  app.put(`${platformPrefix}/:groupId`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { groupId } = request.params as { groupId: string };
      const body = updateGroupSchema.parse(request.body);
      const group = await updateModelGroup(groupId, body);
      return reply.send({ group });
    } catch (error) { return handleError(error, reply); }
  });

  // DELETE /platform/model-groups/:groupId
  app.delete(`${platformPrefix}/:groupId`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { groupId } = request.params as { groupId: string };
      await deleteModelGroup(groupId);
      return reply.status(204).send();
    } catch (error) { return handleError(error, reply); }
  });

  // POST /platform/model-groups/:groupId/items
  app.post(`${platformPrefix}/:groupId/items`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { groupId } = request.params as { groupId: string };
      const body = addItemSchema.parse(request.body);
      const item = await addModelItem(groupId, body);
      return reply.status(201).send({ item });
    } catch (error) { return handleError(error, reply); }
  });

  // PUT /platform/model-groups/:groupId/items/:itemId
  app.put(`${platformPrefix}/:groupId/items/:itemId`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { groupId, itemId } = request.params as { groupId: string; itemId: string };
      const body = updateItemSchema.parse(request.body);
      const item = await updateModelItem(groupId, itemId, body);
      return reply.send({ item });
    } catch (error) { return handleError(error, reply); }
  });

  // DELETE /platform/model-groups/:groupId/items/:itemId
  app.delete(`${platformPrefix}/:groupId/items/:itemId`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { groupId, itemId } = request.params as { groupId: string; itemId: string };
      await deleteModelItem(groupId, itemId);
      return reply.status(204).send();
    } catch (error) { return handleError(error, reply); }
  });

  // GET /platform/model-groups/:groupId/items/:itemId/versions
  app.get(`${platformPrefix}/:groupId/items/:itemId/versions`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { itemId } = request.params as { itemId: string };
      const versions = await getItemVersions(itemId);
      return reply.send({ versions });
    } catch (error) { return handleError(error, reply); }
  });
}
