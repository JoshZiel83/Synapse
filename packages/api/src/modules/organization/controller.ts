import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { authzEnabled, checkPermission } from '../../infrastructure/authz/index.js';
import { workspaceMiddleware } from '../../infrastructure/middleware/workspace.js';
import * as service from './service.js';
import { ACTOR_DOC_TEMPLATES } from '@synapse/shared';
import type { ActorDoc } from '@synapse/shared';

const actorRoles = ['secretary', 'manager', 'specialist', 'reviewer', 'archivist', 'receptionist', 'assistant'] as const;
const actorDocVisibility = ['always', 'solo_only', 'group_only', 'internal_only'] as const;
const actorDocKeys = new Set(ACTOR_DOC_TEMPLATES.map((template) => template.key));

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

const actorDocSchema = z.object({
  id: z.string().uuid().optional(),
  key: z.custom<ActorDoc['key']>((value) => typeof value === 'string' && (actorDocKeys.has(value as any) || value === 'custom'), {
    message: 'Invalid actor doc key',
  }),
  title: z.string().min(1).max(255),
  content: z.array(contentBlockSchema).default([]),
  visibility: z.enum(actorDocVisibility),
  priority: z.number().int().min(-1000).max(1000),
});

const createActorSchema = z.object({
  name: z.string().min(1).max(255),
  role: z.enum(actorRoles),
  title: z.string().max(255).default(''),
  avatarFileId: z.string().uuid().optional(),
  canRepresentUser: z.boolean().default(false),
  docs: z.array(actorDocSchema).optional(),
  parentId: z.string().uuid().optional(),
  capabilities: z.array(z.string()).optional(),
  config: z.record(z.unknown()).optional(),
});

const updateActorSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  role: z.enum(actorRoles).optional(),
  title: z.string().max(255).optional(),
  avatarFileId: z.string().uuid().nullable().optional(),
  canRepresentUser: z.boolean().optional(),
  docs: z.array(actorDocSchema).optional(),
  parentId: z.string().uuid().nullable().optional(),
  capabilities: z.array(z.string()).optional(),
  config: z.record(z.unknown()).optional(),
});

const addCollaborationSchema = z.object({
  collaboratorId: z.string().uuid(),
  relationship: z.string().min(1),
  description: z.string().optional(),
});

const cloneTemplateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  title: z.string().max(255).optional(),
  parentId: z.string().uuid().nullable().optional(),
  syncMode: z.enum(['notify', 'manual_merge']).default('notify'),
});

const actorGrantPermissionEnum = z.enum([
  'discover',
  'invoke',
  'receive_message',
  'memory_read',
  'memory_edit',
  'memory_grant',
  'memory_retarget',
  'memory_delete',
]);
const actorGrantScopeEnum = z.enum(['workspace', 'user', 'workspace_user', 'conversation', 'actor']);
const issueActorGrantSchema = z.object({
  permission: actorGrantPermissionEnum,
  grantScope: actorGrantScopeEnum,
  userId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  actorSubjectId: z.string().uuid().optional(),
  reason: z.string().max(1000).optional(),
  metadata: z.record(z.unknown()).optional(),
}).superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  switch (value.grantScope) {
    case 'workspace':
      if (value.userId || value.conversationId || value.actorSubjectId) invalid('workspace grant cannot target user, conversation, or actor');
      break;
    case 'user':
    case 'workspace_user':
      if (!value.userId || value.conversationId || value.actorSubjectId) invalid(`${value.grantScope} grant requires userId only`);
      break;
    case 'conversation':
      if (!value.conversationId || value.userId || value.actorSubjectId) invalid('conversation grant requires conversationId only');
      break;
    case 'actor':
      if (!value.actorSubjectId || value.userId || value.conversationId) invalid('actor grant requires actorSubjectId only');
      break;
  }
});

async function requireWorkspacePermission(
  request: any,
  reply: any,
  permission: string,
  errorMessage: string,
) {
  const { workspaceId } = request.params as { workspaceId: string };
  const userId = (request as any).user!.userId;

  if (!authzEnabled()) {
    const trustLevel = (request as any).workspaceMember?.trust_level as string | undefined;
    const allowed = trustLevel === 'owner' || trustLevel === 'admin';
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

async function requireActorPermission(
  request: any,
  reply: any,
  actorId: string,
  permission: string,
  errorMessage: string,
) {
  const userId = (request as any).user!.userId;

  if (!authzEnabled()) {
    const trustLevel = (request as any).workspaceMember?.trust_level as string | undefined;
    const allowed = permission === 'view'
      ? Boolean(trustLevel)
      : trustLevel === 'owner' || trustLevel === 'admin';
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

export async function organizationController(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);
  app.addHook('onRequest', workspaceMiddleware);

  // POST / - create actor
  app.post('/', async (request, reply) => {
    const allowed = await requireWorkspacePermission(
      request,
      reply,
      'manage_actors',
      'Not allowed to manage actors',
    );
    if (!allowed) return;

    const { workspaceId } = request.params as { workspaceId: string };
    const body = createActorSchema.parse(request.body);
    const userId = (request as any).user!.userId;

    const actor = await service.createActor({
      workspaceId,
      createdBy: userId,
      ...body,
    });

    return reply.status(201).send(actor);
  });

  // GET / - list actors
  app.get('/', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const userId = (request as any).user!.userId;
    const actors = await service.listActors(
      workspaceId,
      authzEnabled() ? { type: 'user', id: userId } : undefined,
    );
    return reply.send(actors);
  });

  // GET /tree - full org tree (must be before /:actorId)
  app.get('/tree', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const tree = await service.getFullOrgTree(workspaceId);
    return reply.send(tree);
  });

  app.get('/templates', async (request, reply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const { search } = request.query as { search?: string };
      const templates = await service.listActorTemplates({ workspaceId, search });
      return reply.send(templates);
    } catch (error) {
      console.error('[organization.templates.list]', error);
      return reply.status(500).send({ error: 'Failed to load actor templates' });
    }
  });

  app.get('/templates/:templateId', async (request, reply) => {
    try {
      const { workspaceId, templateId } = request.params as { workspaceId: string; templateId: string };
      const template = await service.getActorTemplate(templateId, workspaceId);
      return reply.send(template);
    } catch (error) {
      console.error('[organization.templates.get]', error);
      return reply.status(404).send({ error: 'Actor template not found' });
    }
  });

  app.post('/templates/:templateId/clone', async (request, reply) => {
    try {
      const allowed = await requireWorkspacePermission(
        request,
        reply,
        'manage_actors',
        'Not allowed to manage actors',
      );
      if (!allowed) return;

      const { workspaceId, templateId } = request.params as { workspaceId: string; templateId: string };
      const body = cloneTemplateSchema.parse(request.body);

      const result = await service.cloneActorTemplate({
        workspaceId,
        templateId,
        createdBy: (request as any).user!.userId,
        name: body.name,
        title: body.title,
        parentId: body.parentId,
        syncMode: body.syncMode,
      });

      return reply.status(201).send(result);
    } catch (error) {
      console.error('[organization.templates.clone]', error);
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Failed to clone actor template' });
    }
  });

  // GET /:actorId - get actor details
  app.get('/:actorId/versions', async (request, reply) => {
    const { workspaceId, actorId } = request.params as { workspaceId: string; actorId: string };
    const allowed = await requireActorPermission(
      request,
      reply,
      actorId,
      'view',
      'Not allowed to view this actor',
    );
    if (!allowed) return;

    const versions = await service.listActorVersions(actorId, workspaceId);
    return reply.send(versions);
  });

  // GET /:actorId - get actor details
  app.get('/:actorId', async (request, reply) => {
    const { workspaceId, actorId } = request.params as { workspaceId: string; actorId: string };
    const allowed = await requireActorPermission(
      request,
      reply,
      actorId,
      'view',
      'Not allowed to view this actor',
    );
    if (!allowed) return;

    const actor = await service.getActor(actorId, workspaceId);
    if (!actor) return reply.status(404).send({ error: 'Actor not found' });
    return reply.send(actor);
  });

  app.get('/:actorId/grants', async (request, reply) => {
    const { workspaceId, actorId } = request.params as { workspaceId: string; actorId: string };
    const allowed = await requireActorPermission(
      request,
      reply,
      actorId,
      'grant',
      'Not allowed to manage actor grants',
    );
    if (!allowed) return;

    const grants = await service.listActorGrants(actorId, workspaceId);
    return reply.send({ grants });
  });

  app.post('/:actorId/grants', async (request, reply) => {
    const { workspaceId, actorId } = request.params as { workspaceId: string; actorId: string };
    const allowed = await requireActorPermission(
      request,
      reply,
      actorId,
      'grant',
      'Not allowed to manage actor grants',
    );
    if (!allowed) return;

    try {
      const body = issueActorGrantSchema.parse(request.body);
      const grant = await service.issueActorGrant({
        actorId,
        workspaceId,
        permission: body.permission,
        grantScope: body.grantScope,
        userId: body.userId,
        conversationId: body.conversationId,
        actorSubjectId: body.actorSubjectId,
        grantedBy: (request as any).user!.userId,
        reason: body.reason,
        metadata: body.metadata,
      });
      return reply.status(201).send({ grant });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          error: 'Validation failed',
          details: error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
        });
      }
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Failed to issue actor grant' });
    }
  });

  app.post('/:actorId/grants/:grantId/revoke', async (request, reply) => {
    const { workspaceId, actorId, grantId } = request.params as { workspaceId: string; actorId: string; grantId: string };
    const allowed = await requireActorPermission(
      request,
      reply,
      actorId,
      'grant',
      'Not allowed to manage actor grants',
    );
    if (!allowed) return;

    const grant = await service.revokeActorGrant({ actorId, workspaceId, grantId });
    if (!grant) {
      return reply.status(404).send({ error: 'Actor grant not found' });
    }
    return reply.send({ grant });
  });

  // PUT /:actorId - update actor
  app.put('/:actorId', async (request, reply) => {
    const allowed = await requireWorkspacePermission(
      request,
      reply,
      'manage_actors',
      'Not allowed to manage actors',
    );
    if (!allowed) return;

    const { workspaceId, actorId } = request.params as { workspaceId: string; actorId: string };
    const body = updateActorSchema.parse(request.body);

    const actor = await service.updateActor(actorId, workspaceId, body);
    if (!actor) return reply.status(404).send({ error: 'Actor not found' });
    return reply.send(actor);
  });

  // DELETE /:actorId - soft delete
  app.delete('/:actorId', async (request, reply) => {
    const allowed = await requireWorkspacePermission(
      request,
      reply,
      'manage_actors',
      'Not allowed to manage actors',
    );
    if (!allowed) return;

    const { workspaceId, actorId } = request.params as { workspaceId: string; actorId: string };
    const deleted = await service.deleteActor(actorId, workspaceId);
    if (!deleted) return reply.status(404).send({ error: 'Actor not found' });
    return reply.status(204).send();
  });

  // GET /:actorId/children - direct reports
  app.get('/:actorId/children', async (request, reply) => {
    const { workspaceId, actorId } = request.params as { workspaceId: string; actorId: string };
    const children = await service.getChildren(actorId, workspaceId);
    return reply.send(children);
  });

  // GET /:actorId/tree - full subtree
  app.get('/:actorId/tree', async (request, reply) => {
    const { actorId } = request.params as { actorId: string };
    const tree = await service.getSubtree(actorId);
    return reply.send(tree);
  });

  // POST /:actorId/collaborations - add collaboration
  app.post('/:actorId/collaborations', async (request, reply) => {
    const allowed = await requireWorkspacePermission(
      request,
      reply,
      'manage_actors',
      'Not allowed to manage actors',
    );
    if (!allowed) return;

    const { actorId } = request.params as { actorId: string };
    const body = addCollaborationSchema.parse(request.body);

    const collab = await service.addCollaboration({
      actorId,
      ...body,
    });

    return reply.status(201).send(collab);
  });

  // GET /:actorId/collaborations - get collaborations
  app.get('/:actorId/collaborations', async (request, reply) => {
    const { actorId } = request.params as { actorId: string };
    const collabs = await service.getCollaborations(actorId);
    return reply.send(collabs);
  });
}
