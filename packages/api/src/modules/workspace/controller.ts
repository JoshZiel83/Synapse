import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import {
  createWorkspace,
  listUserWorkspaces,
  getWorkspaceById,
  updateWorkspace,
  checkMembership,
  addMember,
  listMembers,
} from './service.js';

// ── Schemas ──

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
});

const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
});

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  trustLevel: z.enum(['admin', 'member', 'guest']),
});

// ── Helpers ──

type WorkspaceParams = { workspaceId: string };

async function requireMembership(
  request: FastifyRequest<{ Params: WorkspaceParams }>,
  reply: FastifyReply
): Promise<string | null> {
  const { workspaceId } = request.params;
  const userId = (request as any).user!.userId;
  const trustLevel = await checkMembership(workspaceId, userId);
  if (!trustLevel) {
    reply.status(403).send({ error: 'Not a member of this workspace' });
    return null;
  }
  return trustLevel;
}

// ── Handlers ──

export async function handleCreateWorkspace(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const parsed = createWorkspaceSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
  }

  const workspace = await createWorkspace({
    name: parsed.data.name,
    description: parsed.data.description,
    userId: (request as any).user!.userId,
  });

  return reply.status(201).send(workspace);
}

export async function handleListWorkspaces(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const workspaces = await listUserWorkspaces((request as any).user!.userId);
  return reply.send({ data: workspaces });
}

export async function handleGetWorkspace(
  request: FastifyRequest<{ Params: WorkspaceParams }>,
  reply: FastifyReply
) {
  const trustLevel = await requireMembership(request, reply);
  if (!trustLevel) return;

  const workspace = await getWorkspaceById(request.params.workspaceId);
  if (!workspace) {
    return reply.status(404).send({ error: 'Workspace not found' });
  }

  return reply.send(workspace);
}

export async function handleUpdateWorkspace(
  request: FastifyRequest<{ Params: WorkspaceParams }>,
  reply: FastifyReply
) {
  const trustLevel = await requireMembership(request, reply);
  if (!trustLevel) return;

  if (trustLevel !== 'owner' && trustLevel !== 'admin') {
    return reply.status(403).send({ error: 'Only owners and admins can update workspaces' });
  }

  const parsed = updateWorkspaceSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
  }

  const workspace = await updateWorkspace(request.params.workspaceId, parsed.data);
  if (!workspace) {
    return reply.status(404).send({ error: 'Workspace not found' });
  }

  return reply.send(workspace);
}

export async function handleAddMember(
  request: FastifyRequest<{ Params: WorkspaceParams }>,
  reply: FastifyReply
) {
  const trustLevel = await requireMembership(request, reply);
  if (!trustLevel) return;

  if (trustLevel !== 'owner' && trustLevel !== 'admin') {
    return reply.status(403).send({ error: 'Only owners and admins can add members' });
  }

  const parsed = addMemberSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
  }

  const member = await addMember({
    workspaceId: request.params.workspaceId,
    userId: parsed.data.userId,
    trustLevel: parsed.data.trustLevel,
  });

  if (!member) {
    return reply.status(409).send({ error: 'User is already a member of this workspace' });
  }

  return reply.status(201).send(member);
}

export async function handleListMembers(
  request: FastifyRequest<{ Params: WorkspaceParams }>,
  reply: FastifyReply
) {
  const trustLevel = await requireMembership(request, reply);
  if (!trustLevel) return;

  const members = await listMembers(request.params.workspaceId);
  return reply.send({ data: members });
}

// ── Plugin registration ──

export async function registerWorkspaceRoutes(fastify: FastifyInstance) {
  const authHook = { preHandler: [authMiddleware] };
  const workspaceAuthHook = { preHandler: [authMiddleware] };

  // Workspace collection routes
  fastify.post('/api/v1/workspaces', authHook, handleCreateWorkspace);
  fastify.get('/api/v1/workspaces', authHook, handleListWorkspaces);

  // Workspace instance routes
  fastify.get<{ Params: WorkspaceParams }>(
    '/api/v1/workspaces/:workspaceId',
    workspaceAuthHook,
    handleGetWorkspace
  );
  fastify.put<{ Params: WorkspaceParams }>(
    '/api/v1/workspaces/:workspaceId',
    workspaceAuthHook,
    handleUpdateWorkspace
  );

  // Workspace member routes
  fastify.post<{ Params: WorkspaceParams }>(
    '/api/v1/workspaces/:workspaceId/members',
    workspaceAuthHook,
    handleAddMember
  );
  fastify.get<{ Params: WorkspaceParams }>(
    '/api/v1/workspaces/:workspaceId/members',
    workspaceAuthHook,
    handleListMembers
  );
}
