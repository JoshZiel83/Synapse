import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { workspaceMiddleware } from '../../infrastructure/middleware/workspace.js';
import { requireRequestAction } from '../access/guards.js';
import * as service from './service.js';
import { getAvailableTransitions } from './state-machine.js';
import type { WorkItemStatus, WorkItemPriority, ParticipantRole } from '@synapse/shared';

const workItemStatuses = ['created', 'assigned', 'accepted', 'in_progress', 'review', 'completed', 'escalated', 'blocked', 'rework', 'cancelled', 'failed'] as const;
const workItemPriorities = ['low', 'medium', 'high', 'urgent'] as const;
const sourceTypes = ['user_message', 'delegation', 'automation', 'escalation', 'collaboration'] as const;
const participantRoles = ['owner', 'accountable', 'executor', 'reviewer', 'watcher'] as const;

const createWorkItemSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().default(''),
  priority: z.enum(workItemPriorities).default('medium'),
  assignedTo: z.string().uuid().optional(),
  accountableId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
  sourceType: z.enum(sourceTypes).default('user_message'),
  sourceId: z.string().uuid().optional(),
  dueAt: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateWorkItemSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().min(1).optional(),
  priority: z.enum(workItemPriorities).optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  accountableId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  result: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const transitionSchema = z.object({
  status: z.enum(workItemStatuses),
});

const addParticipantSchema = z.object({
  actorId: z.string().uuid(),
  role: z.enum(participantRoles),
});

export async function workEngineController(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);
  app.addHook('onRequest', workspaceMiddleware);

  // POST / - create work item
  app.post('/', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const allowed = await requireRequestAction(request as any, reply as any, 'workspace.manage', workspaceId, 'Not allowed to manage work items in this workspace');
    if (!allowed) return;

    const body = createWorkItemSchema.parse(request.body);
    const userId = (request as any).user?.userId;

    const workItem = await service.createWorkItem({
      workspaceId,
      createdBy: userId,
      ...body,
    });

    return reply.status(201).send(workItem);
  });

  // GET / - list work items with filters
  app.get('/', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const allowed = await requireRequestAction(request as any, reply as any, 'workspace.view', workspaceId, 'Not allowed to view work items in this workspace');
    if (!allowed) return;

    const queryParams = request.query as {
      status?: WorkItemStatus;
      assignedTo?: string;
      priority?: WorkItemPriority;
    };

    const workItems = await service.listWorkItems(workspaceId, {
      status: queryParams.status,
      assignedTo: queryParams.assignedTo,
      priority: queryParams.priority,
    });

    return reply.send(workItems);
  });

  // GET /:workItemId - get work item with participants
  app.get('/:workItemId', async (request, reply) => {
    const { workspaceId, workItemId } = request.params as { workspaceId: string; workItemId: string };
    const allowed = await requireRequestAction(request as any, reply as any, 'workspace.view', workspaceId, 'Not allowed to view work items in this workspace');
    if (!allowed) return;

    const details = await service.getWorkItemWithDetails(workItemId, workspaceId);
    if (!details) return reply.status(404).send({ error: 'Work item not found' });

    return reply.send(details);
  });

  // PUT /:workItemId - update work item
  app.put('/:workItemId', async (request, reply) => {
    const { workspaceId, workItemId } = request.params as { workspaceId: string; workItemId: string };
    const allowed = await requireRequestAction(request as any, reply as any, 'workspace.manage', workspaceId, 'Not allowed to manage work items in this workspace');
    if (!allowed) return;

    const body = updateWorkItemSchema.parse(request.body);

    const workItem = await service.updateWorkItem(workItemId, workspaceId, body);
    if (!workItem) return reply.status(404).send({ error: 'Work item not found' });

    return reply.send(workItem);
  });

  // POST /:workItemId/transition - transition status
  app.post('/:workItemId/transition', async (request, reply) => {
    const { workspaceId, workItemId } = request.params as { workspaceId: string; workItemId: string };
    const allowed = await requireRequestAction(request as any, reply as any, 'workspace.manage', workspaceId, 'Not allowed to manage work items in this workspace');
    if (!allowed) return;

    const { status } = transitionSchema.parse(request.body);

    try {
      const workItem = await service.transitionWorkItem(workItemId, workspaceId, status);
      return reply.send(workItem);
    } catch (err: any) {
      if (err.message?.includes('Invalid transition')) {
        return reply.status(400).send({ error: err.message });
      }
      if (err.message?.includes('not found')) {
        return reply.status(404).send({ error: err.message });
      }
      throw err;
    }
  });

  // POST /:workItemId/participants - add participant
  app.post('/:workItemId/participants', async (request, reply) => {
    const { workspaceId, workItemId } = request.params as { workspaceId: string; workItemId: string };
    const allowed = await requireRequestAction(request as any, reply as any, 'workspace.manage', workspaceId, 'Not allowed to manage work items in this workspace');
    if (!allowed) return;

    const body = addParticipantSchema.parse(request.body);

    const participant = await service.addParticipant({
      workItemId,
      ...body,
    });

    return reply.status(201).send(participant);
  });

  // GET /:workItemId/participants - list participants
  app.get('/:workItemId/participants', async (request, reply) => {
    const { workspaceId, workItemId } = request.params as { workspaceId: string; workItemId: string };
    const allowed = await requireRequestAction(request as any, reply as any, 'workspace.view', workspaceId, 'Not allowed to view work items in this workspace');
    if (!allowed) return;

    const participants = await service.getParticipants(workItemId);
    return reply.send(participants);
  });
}
