import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { AUTHZ_PLATFORM_ID, authzEnabled, checkPermission } from '../../infrastructure/authz/index.js';
import { workspaceMiddleware } from '../../infrastructure/middleware/workspace.js';
import { isPlatformAdmin } from '../platform/admin-service.js';
import {
  addModelItem,
  createModelGroup,
  deleteModelGroup,
  deleteModelItem,
  getActorModelGroups,
  getItemVersions,
  getModelGroup,
  isModelGroupAvailableInWorkspace,
  issueModelGroupGrant,
  listModelGroupGrants,
  listPlatformModelGroups,
  listUserOwnedModelGroups,
  listVisibleActorModelGroups,
  listWorkspaceModelGroups,
  ModelGroupError,
  revokeModelGroupGrant,
  setActorModelGroups,
  updateModelGroup,
  updateModelItem,
} from './service.js';

const routingStrategyEnum = z.enum(['weighted_random', 'round_robin', 'priority_failover']);
const providerTypeEnum = z.enum(['anthropic', 'openai']);
const grantScopeEnum = z.enum(['platform', 'workspace', 'user', 'workspace_user', 'actor']);

const attemptPolicySchema = z.object({
  maxAttemptsTotal: z.number().int().positive().optional(),
  maxAttemptsPerBinding: z.number().int().positive().optional(),
  timeoutMsPerAttempt: z.number().int().positive().optional(),
  continueOn: z.array(z.string()).optional(),
  stopOn: z.array(z.string()).optional(),
  retryBackoffMs: z.array(z.number().int().min(0)).optional(),
}).passthrough();

const createGroupSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  routingStrategy: routingStrategyEnum.optional(),
  attemptPolicy: attemptPolicySchema.optional(),
  isDefault: z.boolean().optional(),
});

const updateGroupSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  routingStrategy: routingStrategyEnum.optional(),
  attemptPolicy: attemptPolicySchema.optional(),
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
  capabilityTags: z.array(z.string()).optional(),
  extraConfig: z.record(z.unknown()).optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).optional(),
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
  capabilityTags: z.array(z.string()).optional(),
  extraConfig: z.record(z.unknown()).optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).optional(),
});

const setActorGroupsSchema = z.object({
  groups: z.array(z.object({
    groupId: z.string().uuid(),
    priority: z.number().int(),
  })),
});

const issueGrantSchema = z.object({
  grantScope: grantScopeEnum,
  workspaceId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  reason: z.string().max(1000).optional(),
  metadata: z.record(z.unknown()).optional(),
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

function hasLegacyWorkspacePermission(trustLevel: string | null | undefined, permission: string) {
  switch (permission) {
    case 'view':
      return Boolean(trustLevel);
    case 'manage_models':
    case 'manage_actors':
      return trustLevel === 'owner' || trustLevel === 'admin';
    default:
      return false;
  }
}

async function requireWorkspacePermission(
  request: FastifyRequest<{ Params: { workspaceId: string } }>,
  reply: FastifyReply,
  permission: string,
  errorMessage: string,
) {
  const { workspaceId } = request.params;
  const userId = (request as any).user!.userId;

  if (!authzEnabled()) {
    const trustLevel = (request as any).workspaceMember?.trust_level as string | undefined;
    if (!hasLegacyWorkspacePermission(trustLevel, permission)) {
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

async function requireActorPermission(
  request: FastifyRequest<{ Params: { workspaceId: string; actorId: string } }>,
  reply: FastifyReply,
  permission: string,
  errorMessage: string,
) {
  const { actorId } = request.params;
  const userId = (request as any).user!.userId;

  if (!authzEnabled()) {
    const trustLevel = (request as any).workspaceMember?.trust_level as string | undefined;
    const allowed = permission === 'view'
      ? hasLegacyWorkspacePermission(trustLevel, 'view')
      : hasLegacyWorkspacePermission(trustLevel, 'manage_actors');
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

async function requirePlatformPermission(
  request: FastifyRequest,
  reply: FastifyReply,
  permission: string,
  errorMessage: string,
) {
  const userId = (request as any).user!.userId;

  if (!authzEnabled()) {
    const allowed = await isPlatformAdmin(userId);
    if (!allowed) {
      reply.status(403).send({ error: errorMessage });
      return false;
    }
    return true;
  }

  const allowed = await checkPermission({
    resourceType: 'platform',
    resourceId: AUTHZ_PLATFORM_ID,
    permission,
    subject: { type: 'user', id: userId },
  });

  if (!allowed) {
    reply.status(403).send({ error: errorMessage });
    return false;
  }

  return true;
}

async function requireModelGroupPermission(
  userId: string,
  groupId: string,
  permission: string,
  reply: FastifyReply,
  errorMessage: string,
) {
  if (!authzEnabled()) {
    const group = await getModelGroup(groupId);
    const fallbackAllowed =
      (group.owner_type === 'user' && group.owner_user_id === userId) ||
      (group.owner_type === 'platform' && await isPlatformAdmin(userId));
    if (!fallbackAllowed) {
      reply.status(403).send({ error: errorMessage });
      return false;
    }
    return true;
  }

  const allowed = await checkPermission({
    resourceType: 'model_group',
    resourceId: groupId,
    permission,
    subject: { type: 'user', id: userId },
  });

  if (!allowed) {
    reply.status(403).send({ error: errorMessage });
    return false;
  }

  return true;
}

async function requireWorkspaceVisibleGroup(
  request: FastifyRequest<{ Params: { workspaceId: string; groupId: string } }>,
  reply: FastifyReply,
) {
  const { workspaceId, groupId } = request.params;
  const visible = await isModelGroupAvailableInWorkspace(groupId, workspaceId);
  if (!visible) {
    reply.status(404).send({ error: 'Model group not found' });
    return null;
  }
  return getModelGroup(groupId);
}

async function requirePlatformGroup(
  request: FastifyRequest<{ Params: { groupId: string } }>,
  reply: FastifyReply,
) {
  const group = await getModelGroup(request.params.groupId);
  if (group.owner_type !== 'platform') {
    reply.status(404).send({ error: 'Model group not found' });
    return null;
  }
  return group;
}

async function requireUserGroup(
  request: FastifyRequest<{ Params: { groupId: string } }>,
  reply: FastifyReply,
) {
  const userId = (request as any).user!.userId;
  const group = await getModelGroup(request.params.groupId);
  if (group.owner_type !== 'user' || group.owner_user_id !== userId) {
    reply.status(404).send({ error: 'Model group not found' });
    return null;
  }
  return group;
}

export function registerModelGroupRoutes(app: FastifyInstance) {
  const wsPrefix = '/api/v1/workspaces/:workspaceId/model-groups';
  const platformPrefix = '/api/v1/platform/model-groups';
  const userPrefix = '/api/v1/me/model-groups';
  const wsPreHandler = [authMiddleware, workspaceMiddleware];
  const authPreHandler = [authMiddleware];

  app.get(wsPrefix, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allowed = await requireWorkspacePermission(
        request as FastifyRequest<{ Params: { workspaceId: string } }>,
        reply,
        'manage_models',
        'Not allowed to manage model groups in this workspace',
      );
      if (!allowed) return;

      const { workspaceId } = request.params as { workspaceId: string };
      const groups = await listWorkspaceModelGroups(workspaceId);
      return reply.send({ groups });
    } catch (error) { return handleError(error, reply); }
  });

  app.post(wsPrefix, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allowed = await requireWorkspacePermission(
        request as FastifyRequest<{ Params: { workspaceId: string } }>,
        reply,
        'manage_models',
        'Not allowed to manage model groups in this workspace',
      );
      if (!allowed) return;

      const { workspaceId } = request.params as { workspaceId: string };
      const body = createGroupSchema.parse(request.body);
      const userId = (request as any).user.userId;
      const group = await createModelGroup({
        ...body,
        ownerType: 'workspace',
        workspaceId,
        createdBy: userId,
      });
      return reply.status(201).send({ group });
    } catch (error) { return handleError(error, reply); }
  });

  app.get(`${wsPrefix}/:groupId`, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const workspaceAllowed = await requireWorkspacePermission(
        request as FastifyRequest<{ Params: { workspaceId: string } }>,
        reply,
        'manage_models',
        'Not allowed to manage model groups in this workspace',
      );
      if (!workspaceAllowed) return;

      const group = await requireWorkspaceVisibleGroup(
        request as FastifyRequest<{ Params: { workspaceId: string; groupId: string } }>,
        reply,
      );
      if (!group) return;

      const userId = (request as any).user.userId;
      const groupAllowed = await requireModelGroupPermission(
        userId,
        group.id,
        'view',
        reply,
        'Not allowed to view this model group',
      );
      if (!groupAllowed) return;

      return reply.send({ group });
    } catch (error) { return handleError(error, reply); }
  });

  app.put(`${wsPrefix}/:groupId`, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const workspaceAllowed = await requireWorkspacePermission(
        request as FastifyRequest<{ Params: { workspaceId: string } }>,
        reply,
        'manage_models',
        'Not allowed to manage model groups in this workspace',
      );
      if (!workspaceAllowed) return;

      const scopedGroup = await requireWorkspaceVisibleGroup(
        request as FastifyRequest<{ Params: { workspaceId: string; groupId: string } }>,
        reply,
      );
      if (!scopedGroup) return;

      const userId = (request as any).user.userId;
      const groupAllowed = await requireModelGroupPermission(
        userId,
        scopedGroup.id,
        'edit',
        reply,
        'Not allowed to edit this model group',
      );
      if (!groupAllowed) return;

      const body = updateGroupSchema.parse(request.body);
      const group = await updateModelGroup(scopedGroup.id, body);
      return reply.send({ group });
    } catch (error) { return handleError(error, reply); }
  });

  app.delete(`${wsPrefix}/:groupId`, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const workspaceAllowed = await requireWorkspacePermission(
        request as FastifyRequest<{ Params: { workspaceId: string } }>,
        reply,
        'manage_models',
        'Not allowed to manage model groups in this workspace',
      );
      if (!workspaceAllowed) return;

      const scopedGroup = await requireWorkspaceVisibleGroup(
        request as FastifyRequest<{ Params: { workspaceId: string; groupId: string } }>,
        reply,
      );
      if (!scopedGroup) return;

      const userId = (request as any).user.userId;
      const groupAllowed = await requireModelGroupPermission(
        userId,
        scopedGroup.id,
        'delete',
        reply,
        'Not allowed to delete this model group',
      );
      if (!groupAllowed) return;

      await deleteModelGroup(scopedGroup.id);
      return reply.status(204).send();
    } catch (error) { return handleError(error, reply); }
  });

  app.get(`${wsPrefix}/:groupId/grants`, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const workspaceAllowed = await requireWorkspacePermission(
        request as FastifyRequest<{ Params: { workspaceId: string } }>,
        reply,
        'manage_models',
        'Not allowed to manage model groups in this workspace',
      );
      if (!workspaceAllowed) return;

      const group = await requireWorkspaceVisibleGroup(
        request as FastifyRequest<{ Params: { workspaceId: string; groupId: string } }>,
        reply,
      );
      if (!group) return;

      const userId = (request as any).user.userId;
      const groupAllowed = await requireModelGroupPermission(
        userId,
        group.id,
        'grant',
        reply,
        'Not allowed to manage grants for this model group',
      );
      if (!groupAllowed) return;

      const grants = await listModelGroupGrants(group.id);
      return reply.send({ grants });
    } catch (error) { return handleError(error, reply); }
  });

  app.post(`${wsPrefix}/:groupId/grants`, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const workspaceAllowed = await requireWorkspacePermission(
        request as FastifyRequest<{ Params: { workspaceId: string } }>,
        reply,
        'manage_models',
        'Not allowed to manage model groups in this workspace',
      );
      if (!workspaceAllowed) return;

      const group = await requireWorkspaceVisibleGroup(
        request as FastifyRequest<{ Params: { workspaceId: string; groupId: string } }>,
        reply,
      );
      if (!group) return;

      const userId = (request as any).user.userId;
      const groupAllowed = await requireModelGroupPermission(
        userId,
        group.id,
        'grant',
        reply,
        'Not allowed to manage grants for this model group',
      );
      if (!groupAllowed) return;

      const body = issueGrantSchema.parse(request.body);
      const grant = await issueModelGroupGrant(group.id, {
        ...body,
        grantedBy: userId,
      });
      return reply.status(201).send({ grant });
    } catch (error) { return handleError(error, reply); }
  });

  app.post(`${wsPrefix}/:groupId/grants/:grantId/revoke`, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const workspaceAllowed = await requireWorkspacePermission(
        request as FastifyRequest<{ Params: { workspaceId: string } }>,
        reply,
        'manage_models',
        'Not allowed to manage model groups in this workspace',
      );
      if (!workspaceAllowed) return;

      const group = await requireWorkspaceVisibleGroup(
        request as FastifyRequest<{ Params: { workspaceId: string; groupId: string } }>,
        reply,
      );
      if (!group) return;

      const userId = (request as any).user.userId;
      const groupAllowed = await requireModelGroupPermission(
        userId,
        group.id,
        'grant',
        reply,
        'Not allowed to manage grants for this model group',
      );
      if (!groupAllowed) return;

      const { grantId } = request.params as { grantId: string };
      await revokeModelGroupGrant(group.id, grantId);
      return reply.status(204).send();
    } catch (error) { return handleError(error, reply); }
  });

  app.post(`${wsPrefix}/:groupId/items`, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const workspaceAllowed = await requireWorkspacePermission(
        request as FastifyRequest<{ Params: { workspaceId: string } }>,
        reply,
        'manage_models',
        'Not allowed to manage model groups in this workspace',
      );
      if (!workspaceAllowed) return;

      const group = await requireWorkspaceVisibleGroup(
        request as FastifyRequest<{ Params: { workspaceId: string; groupId: string } }>,
        reply,
      );
      if (!group) return;

      const userId = (request as any).user.userId;
      const groupAllowed = await requireModelGroupPermission(
        userId,
        group.id,
        'edit',
        reply,
        'Not allowed to edit this model group',
      );
      if (!groupAllowed) return;

      const body = addItemSchema.parse(request.body);
      const item = await addModelItem(group.id, {
        ...body,
        installedBy: userId,
      });
      return reply.status(201).send({ item });
    } catch (error) { return handleError(error, reply); }
  });

  app.put(`${wsPrefix}/:groupId/items/:itemId`, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const workspaceAllowed = await requireWorkspacePermission(
        request as FastifyRequest<{ Params: { workspaceId: string } }>,
        reply,
        'manage_models',
        'Not allowed to manage model groups in this workspace',
      );
      if (!workspaceAllowed) return;

      const group = await requireWorkspaceVisibleGroup(
        request as FastifyRequest<{ Params: { workspaceId: string; groupId: string } }>,
        reply,
      );
      if (!group) return;

      const userId = (request as any).user.userId;
      const groupAllowed = await requireModelGroupPermission(
        userId,
        group.id,
        'edit',
        reply,
        'Not allowed to edit this model group',
      );
      if (!groupAllowed) return;

      const { itemId } = request.params as { itemId: string };
      const body = updateItemSchema.parse(request.body);
      const item = await updateModelItem(group.id, itemId, body);
      return reply.send({ item });
    } catch (error) { return handleError(error, reply); }
  });

  app.delete(`${wsPrefix}/:groupId/items/:itemId`, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const workspaceAllowed = await requireWorkspacePermission(
        request as FastifyRequest<{ Params: { workspaceId: string } }>,
        reply,
        'manage_models',
        'Not allowed to manage model groups in this workspace',
      );
      if (!workspaceAllowed) return;

      const group = await requireWorkspaceVisibleGroup(
        request as FastifyRequest<{ Params: { workspaceId: string; groupId: string } }>,
        reply,
      );
      if (!group) return;

      const userId = (request as any).user.userId;
      const groupAllowed = await requireModelGroupPermission(
        userId,
        group.id,
        'edit',
        reply,
        'Not allowed to edit this model group',
      );
      if (!groupAllowed) return;

      const { itemId } = request.params as { itemId: string };
      await deleteModelItem(group.id, itemId);
      return reply.status(204).send();
    } catch (error) { return handleError(error, reply); }
  });

  app.get(`${wsPrefix}/:groupId/items/:itemId/versions`, { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const workspaceAllowed = await requireWorkspacePermission(
        request as FastifyRequest<{ Params: { workspaceId: string } }>,
        reply,
        'manage_models',
        'Not allowed to manage model groups in this workspace',
      );
      if (!workspaceAllowed) return;

      const group = await requireWorkspaceVisibleGroup(
        request as FastifyRequest<{ Params: { workspaceId: string; groupId: string } }>,
        reply,
      );
      if (!group) return;

      const userId = (request as any).user.userId;
      const groupAllowed = await requireModelGroupPermission(
        userId,
        group.id,
        'view',
        reply,
        'Not allowed to view this model group',
      );
      if (!groupAllowed) return;

      const { itemId } = request.params as { itemId: string };
      const versions = await getItemVersions(itemId, group.id);
      return reply.send({ versions });
    } catch (error) { return handleError(error, reply); }
  });

  app.get('/api/v1/workspaces/:workspaceId/actors/:actorId/model-groups', { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const workspaceAllowed = await requireWorkspacePermission(
        request as FastifyRequest<{ Params: { workspaceId: string } }>,
        reply,
        'manage_models',
        'Not allowed to manage model groups in this workspace',
      );
      if (!workspaceAllowed) return;

      const actorAllowed = await requireActorPermission(
        request as FastifyRequest<{ Params: { workspaceId: string; actorId: string } }>,
        reply,
        'view',
        'Not allowed to view this actor',
      );
      if (!actorAllowed) return;

      const { actorId, workspaceId } = request.params as { actorId: string; workspaceId: string };
      const groups = await getActorModelGroups(actorId, workspaceId);
      return reply.send({ groups });
    } catch (error) { return handleError(error, reply); }
  });

  app.get('/api/v1/workspaces/:workspaceId/actors/:actorId/model-groups/visible', { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const workspaceAllowed = await requireWorkspacePermission(
        request as FastifyRequest<{ Params: { workspaceId: string } }>,
        reply,
        'manage_models',
        'Not allowed to manage model groups in this workspace',
      );
      if (!workspaceAllowed) return;

      const actorAllowed = await requireActorPermission(
        request as FastifyRequest<{ Params: { workspaceId: string; actorId: string } }>,
        reply,
        'view',
        'Not allowed to view this actor',
      );
      if (!actorAllowed) return;

      const { actorId, workspaceId } = request.params as { actorId: string; workspaceId: string };
      const groups = await listVisibleActorModelGroups(actorId, workspaceId);
      return reply.send({ groups });
    } catch (error) { return handleError(error, reply); }
  });

  app.put('/api/v1/workspaces/:workspaceId/actors/:actorId/model-groups', { preHandler: wsPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const workspaceAllowed = await requireWorkspacePermission(
        request as FastifyRequest<{ Params: { workspaceId: string } }>,
        reply,
        'manage_models',
        'Not allowed to manage model groups in this workspace',
      );
      if (!workspaceAllowed) return;

      const actorAllowed = await requireActorPermission(
        request as FastifyRequest<{ Params: { workspaceId: string; actorId: string } }>,
        reply,
        'edit',
        'Not allowed to edit this actor',
      );
      if (!actorAllowed) return;

      const { actorId, workspaceId } = request.params as { actorId: string; workspaceId: string };
      const body = setActorGroupsSchema.parse(request.body);
      const groups = await setActorModelGroups(actorId, workspaceId, body.groups);
      return reply.send({ groups });
    } catch (error) { return handleError(error, reply); }
  });

  app.get(platformPrefix, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allowed = await requirePlatformPermission(
        request,
        reply,
        'manage_models',
        'Not allowed to manage platform model groups',
      );
      if (!allowed) return;

      const groups = await listPlatformModelGroups();
      return reply.send({ groups });
    } catch (error) { return handleError(error, reply); }
  });

  app.post(platformPrefix, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allowed = await requirePlatformPermission(
        request,
        reply,
        'manage_models',
        'Not allowed to manage platform model groups',
      );
      if (!allowed) return;

      const body = createGroupSchema.parse(request.body);
      const userId = (request as any).user.userId;
      const group = await createModelGroup({
        ...body,
        ownerType: 'platform',
        createdBy: userId,
      });
      return reply.status(201).send({ group });
    } catch (error) { return handleError(error, reply); }
  });

  app.get(`${platformPrefix}/:groupId`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allowed = await requirePlatformPermission(
        request,
        reply,
        'manage_models',
        'Not allowed to manage platform model groups',
      );
      if (!allowed) return;

      const group = await requirePlatformGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;

      return reply.send({ group });
    } catch (error) { return handleError(error, reply); }
  });

  app.put(`${platformPrefix}/:groupId`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allowed = await requirePlatformPermission(
        request,
        reply,
        'manage_models',
        'Not allowed to manage platform model groups',
      );
      if (!allowed) return;

      const group = await requirePlatformGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;

      const userId = (request as any).user.userId;
      const groupAllowed = await requireModelGroupPermission(
        userId,
        group.id,
        'edit',
        reply,
        'Not allowed to edit this model group',
      );
      if (!groupAllowed) return;

      const body = updateGroupSchema.parse(request.body);
      const updated = await updateModelGroup(group.id, body);
      return reply.send({ group: updated });
    } catch (error) { return handleError(error, reply); }
  });

  app.delete(`${platformPrefix}/:groupId`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allowed = await requirePlatformPermission(
        request,
        reply,
        'manage_models',
        'Not allowed to manage platform model groups',
      );
      if (!allowed) return;

      const group = await requirePlatformGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;

      const userId = (request as any).user.userId;
      const groupAllowed = await requireModelGroupPermission(
        userId,
        group.id,
        'delete',
        reply,
        'Not allowed to delete this model group',
      );
      if (!groupAllowed) return;

      await deleteModelGroup(group.id);
      return reply.status(204).send();
    } catch (error) { return handleError(error, reply); }
  });

  app.get(`${platformPrefix}/:groupId/grants`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allowed = await requirePlatformPermission(
        request,
        reply,
        'manage_models',
        'Not allowed to manage platform model groups',
      );
      if (!allowed) return;

      const group = await requirePlatformGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;

      const grants = await listModelGroupGrants(group.id);
      return reply.send({ grants });
    } catch (error) { return handleError(error, reply); }
  });

  app.post(`${platformPrefix}/:groupId/grants`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allowed = await requirePlatformPermission(
        request,
        reply,
        'manage_models',
        'Not allowed to manage platform model groups',
      );
      if (!allowed) return;

      const group = await requirePlatformGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;

      const body = issueGrantSchema.parse(request.body);
      const grant = await issueModelGroupGrant(group.id, {
        ...body,
        grantedBy: (request as any).user.userId,
      });
      return reply.status(201).send({ grant });
    } catch (error) { return handleError(error, reply); }
  });

  app.post(`${platformPrefix}/:groupId/grants/:grantId/revoke`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allowed = await requirePlatformPermission(
        request,
        reply,
        'manage_models',
        'Not allowed to manage platform model groups',
      );
      if (!allowed) return;

      const group = await requirePlatformGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;

      const { grantId } = request.params as { grantId: string };
      await revokeModelGroupGrant(group.id, grantId);
      return reply.status(204).send();
    } catch (error) { return handleError(error, reply); }
  });

  app.post(`${platformPrefix}/:groupId/items`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allowed = await requirePlatformPermission(
        request,
        reply,
        'manage_models',
        'Not allowed to manage platform model groups',
      );
      if (!allowed) return;

      const group = await requirePlatformGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;

      const userId = (request as any).user.userId;
      const groupAllowed = await requireModelGroupPermission(
        userId,
        group.id,
        'edit',
        reply,
        'Not allowed to edit this model group',
      );
      if (!groupAllowed) return;

      const body = addItemSchema.parse(request.body);
      const item = await addModelItem(group.id, {
        ...body,
        installedBy: userId,
      });
      return reply.status(201).send({ item });
    } catch (error) { return handleError(error, reply); }
  });

  app.put(`${platformPrefix}/:groupId/items/:itemId`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allowed = await requirePlatformPermission(
        request,
        reply,
        'manage_models',
        'Not allowed to manage platform model groups',
      );
      if (!allowed) return;

      const group = await requirePlatformGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;

      const userId = (request as any).user.userId;
      const groupAllowed = await requireModelGroupPermission(
        userId,
        group.id,
        'edit',
        reply,
        'Not allowed to edit this model group',
      );
      if (!groupAllowed) return;

      const { itemId } = request.params as { itemId: string };
      const body = updateItemSchema.parse(request.body);
      const item = await updateModelItem(group.id, itemId, body);
      return reply.send({ item });
    } catch (error) { return handleError(error, reply); }
  });

  app.delete(`${platformPrefix}/:groupId/items/:itemId`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allowed = await requirePlatformPermission(
        request,
        reply,
        'manage_models',
        'Not allowed to manage platform model groups',
      );
      if (!allowed) return;

      const group = await requirePlatformGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;

      const userId = (request as any).user.userId;
      const groupAllowed = await requireModelGroupPermission(
        userId,
        group.id,
        'edit',
        reply,
        'Not allowed to edit this model group',
      );
      if (!groupAllowed) return;

      const { itemId } = request.params as { itemId: string };
      await deleteModelItem(group.id, itemId);
      return reply.status(204).send();
    } catch (error) { return handleError(error, reply); }
  });

  app.get(`${platformPrefix}/:groupId/items/:itemId/versions`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const allowed = await requirePlatformPermission(
        request,
        reply,
        'manage_models',
        'Not allowed to manage platform model groups',
      );
      if (!allowed) return;

      const group = await requirePlatformGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;

      const { itemId } = request.params as { itemId: string };
      const versions = await getItemVersions(itemId, group.id);
      return reply.send({ versions });
    } catch (error) { return handleError(error, reply); }
  });

  app.get(userPrefix, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = (request as any).user.userId;
      const groups = await listUserOwnedModelGroups(userId);
      return reply.send({ groups });
    } catch (error) { return handleError(error, reply); }
  });

  app.post(userPrefix, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = createGroupSchema.parse(request.body);
      const userId = (request as any).user.userId;
      const group = await createModelGroup({
        ...body,
        ownerType: 'user',
        ownerUserId: userId,
        createdBy: userId,
      });
      return reply.status(201).send({ group });
    } catch (error) { return handleError(error, reply); }
  });

  app.get(`${userPrefix}/:groupId`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const group = await requireUserGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;
      return reply.send({ group });
    } catch (error) { return handleError(error, reply); }
  });

  app.put(`${userPrefix}/:groupId`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const group = await requireUserGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;

      const userId = (request as any).user.userId;
      const groupAllowed = await requireModelGroupPermission(
        userId,
        group.id,
        'edit',
        reply,
        'Not allowed to edit this model group',
      );
      if (!groupAllowed) return;

      const body = updateGroupSchema.parse(request.body);
      const updated = await updateModelGroup(group.id, body);
      return reply.send({ group: updated });
    } catch (error) { return handleError(error, reply); }
  });

  app.delete(`${userPrefix}/:groupId`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const group = await requireUserGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;

      const userId = (request as any).user.userId;
      const groupAllowed = await requireModelGroupPermission(
        userId,
        group.id,
        'delete',
        reply,
        'Not allowed to delete this model group',
      );
      if (!groupAllowed) return;

      await deleteModelGroup(group.id);
      return reply.status(204).send();
    } catch (error) { return handleError(error, reply); }
  });

  app.get(`${userPrefix}/:groupId/grants`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const group = await requireUserGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;

      const grants = await listModelGroupGrants(group.id);
      return reply.send({ grants });
    } catch (error) { return handleError(error, reply); }
  });

  app.post(`${userPrefix}/:groupId/grants`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const group = await requireUserGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;

      const body = issueGrantSchema.parse(request.body);
      const grant = await issueModelGroupGrant(group.id, {
        ...body,
        grantedBy: (request as any).user.userId,
      });
      return reply.status(201).send({ grant });
    } catch (error) { return handleError(error, reply); }
  });

  app.post(`${userPrefix}/:groupId/grants/:grantId/revoke`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const group = await requireUserGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;

      const { grantId } = request.params as { grantId: string };
      await revokeModelGroupGrant(group.id, grantId);
      return reply.status(204).send();
    } catch (error) { return handleError(error, reply); }
  });

  app.post(`${userPrefix}/:groupId/items`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const group = await requireUserGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;

      const userId = (request as any).user.userId;
      const body = addItemSchema.parse(request.body);
      const item = await addModelItem(group.id, {
        ...body,
        installedBy: userId,
      });
      return reply.status(201).send({ item });
    } catch (error) { return handleError(error, reply); }
  });

  app.put(`${userPrefix}/:groupId/items/:itemId`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const group = await requireUserGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;

      const { itemId } = request.params as { itemId: string };
      const body = updateItemSchema.parse(request.body);
      const item = await updateModelItem(group.id, itemId, body);
      return reply.send({ item });
    } catch (error) { return handleError(error, reply); }
  });

  app.delete(`${userPrefix}/:groupId/items/:itemId`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const group = await requireUserGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;

      const { itemId } = request.params as { itemId: string };
      await deleteModelItem(group.id, itemId);
      return reply.status(204).send();
    } catch (error) { return handleError(error, reply); }
  });

  app.get(`${userPrefix}/:groupId/items/:itemId/versions`, { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const group = await requireUserGroup(
        request as FastifyRequest<{ Params: { groupId: string } }>,
        reply,
      );
      if (!group) return;

      const { itemId } = request.params as { itemId: string };
      const versions = await getItemVersions(itemId, group.id);
      return reply.send({ versions });
    } catch (error) { return handleError(error, reply); }
  });
}
