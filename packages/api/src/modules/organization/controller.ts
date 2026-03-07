import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { workspaceMiddleware } from '../../infrastructure/middleware/workspace.js';
import * as service from './service.js';
import type { ActorRole } from '@synapse/shared';

const actorRoles = ['secretary', 'manager', 'specialist', 'reviewer', 'archivist', 'receptionist', 'assistant'] as const;

const createActorSchema = z.object({
  name: z.string().min(1).max(255),
  role: z.enum(actorRoles),
  title: z.string().max(255).default(''),
  charter: z.string().default(''),
  systemPrompt: z.string().default(''),
  parentId: z.string().uuid().optional(),
  capabilities: z.array(z.string()).optional(),
  config: z.record(z.unknown()).optional(),
});

const updateActorSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  role: z.enum(actorRoles).optional(),
  title: z.string().min(1).max(255).optional(),
  charter: z.string().min(1).optional(),
  systemPrompt: z.string().min(1).optional(),
  parentId: z.string().uuid().nullable().optional(),
  capabilities: z.array(z.string()).optional(),
  config: z.record(z.unknown()).optional(),
});

const addCollaborationSchema = z.object({
  collaboratorId: z.string().uuid(),
  relationship: z.string().min(1),
  description: z.string().optional(),
});

export async function organizationController(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);
  app.addHook('onRequest', workspaceMiddleware);

  // POST / - create actor
  app.post('/', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const body = createActorSchema.parse(request.body);

    const actor = await service.createActor({
      workspaceId,
      ...body,
    });

    return reply.status(201).send(actor);
  });

  // GET / - list actors
  app.get('/', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const actors = await service.listActors(workspaceId);
    return reply.send(actors);
  });

  // GET /tree - full org tree (must be before /:actorId)
  app.get('/tree', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const tree = await service.getFullOrgTree(workspaceId);
    return reply.send(tree);
  });

  // GET /:actorId - get actor details
  app.get('/:actorId', async (request, reply) => {
    const { workspaceId, actorId } = request.params as { workspaceId: string; actorId: string };
    const actor = await service.getActor(actorId, workspaceId);
    if (!actor) return reply.status(404).send({ error: 'Actor not found' });
    return reply.send(actor);
  });

  // PUT /:actorId - update actor
  app.put('/:actorId', async (request, reply) => {
    const { workspaceId, actorId } = request.params as { workspaceId: string; actorId: string };
    const body = updateActorSchema.parse(request.body);

    const actor = await service.updateActor(actorId, workspaceId, body);
    if (!actor) return reply.status(404).send({ error: 'Actor not found' });
    return reply.send(actor);
  });

  // DELETE /:actorId - soft delete
  app.delete('/:actorId', async (request, reply) => {
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
