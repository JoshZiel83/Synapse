import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authMiddleware, optionalAuth } from '../../infrastructure/middleware/auth.js';
import {
  createWorkspace,
  listUserWorkspaces,
  getWorkspaceById,
  updateWorkspace,
  checkMembership,
  addMember,
  listMembers,
} from './service.js';
import {
  createInvite,
  getInviteByToken,
  redeemInvite,
  listWorkspaceInvites,
  revokeInvite,
} from './invite-service.js';

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

const createInviteSchema = z.object({
  trustLevel: z.enum(['admin', 'member', 'guest']).optional(),
  maxUses: z.number().int().positive().optional(),
  expiresAt: z.string().optional(),
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

// ── Invite Handlers ──

type InviteParams = { workspaceId: string; inviteId: string };
type TokenParams = { token: string };

export async function handleCreateInvite(
  request: FastifyRequest<{ Params: WorkspaceParams }>,
  reply: FastifyReply
) {
  const trustLevel = await requireMembership(request, reply);
  if (!trustLevel) return;
  if (trustLevel !== 'owner' && trustLevel !== 'admin') {
    return reply.status(403).send({ error: 'Only owners and admins can create invites' });
  }

  const parsed = createInviteSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
  }

  const invite = await createInvite({
    workspaceId: request.params.workspaceId,
    createdBy: (request as any).user!.userId,
    trustLevel: parsed.data.trustLevel,
    maxUses: parsed.data.maxUses,
    expiresAt: parsed.data.expiresAt,
  });

  return reply.status(201).send(invite);
}

export async function handleListInvites(
  request: FastifyRequest<{ Params: WorkspaceParams }>,
  reply: FastifyReply
) {
  const trustLevel = await requireMembership(request, reply);
  if (!trustLevel) return;
  if (trustLevel !== 'owner' && trustLevel !== 'admin') {
    return reply.status(403).send({ error: 'Only owners and admins can view invites' });
  }

  const invites = await listWorkspaceInvites(request.params.workspaceId);
  return reply.send({ data: invites });
}

export async function handleRevokeInvite(
  request: FastifyRequest<{ Params: InviteParams }>,
  reply: FastifyReply
) {
  const { workspaceId, inviteId } = request.params;
  const userId = (request as any).user!.userId;
  const tl = await checkMembership(workspaceId, userId);
  if (!tl || (tl !== 'owner' && tl !== 'admin')) {
    return reply.status(403).send({ error: 'Only owners and admins can revoke invites' });
  }

  const revoked = await revokeInvite(inviteId, workspaceId);
  if (!revoked) {
    return reply.status(404).send({ error: 'Invite not found' });
  }
  return reply.send(revoked);
}

export async function handleGetInviteInfo(
  request: FastifyRequest<{ Params: TokenParams }>,
  reply: FastifyReply
) {
  const invite = await getInviteByToken(request.params.token);
  if (!invite || invite.isRevoked) {
    return reply.status(404).send({ error: 'Invite not found or revoked' });
  }
  if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
    return reply.status(410).send({ error: 'Invite has expired' });
  }
  if (invite.maxUses !== null && invite.useCount >= invite.maxUses) {
    return reply.status(410).send({ error: 'Invite has reached maximum uses' });
  }

  // Return public info only
  return reply.send({
    token: invite.token,
    workspaceName: invite.workspaceName,
    trustLevel: invite.trustLevel,
  });
}

export async function handleRedeemInvite(
  request: FastifyRequest<{ Params: TokenParams }>,
  reply: FastifyReply
) {
  const userId = (request as any).user!.userId;
  try {
    const result = await redeemInvite(request.params.token, userId);
    return reply.send(result);
  } catch (err: any) {
    const msg = err.message || 'Failed to redeem invite';
    if (msg === 'Already a member of this workspace') {
      return reply.status(409).send({ error: msg });
    }
    return reply.status(400).send({ error: msg });
  }
}

// ── Plugin registration ──

export async function registerWorkspaceRoutes(fastify: FastifyInstance) {
  const authHook = { preHandler: [authMiddleware] };
  const workspaceAuthHook = { preHandler: [authMiddleware] };
  const optionalAuthHook = { preHandler: [optionalAuth] };

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

  // Workspace invite management (requires workspace membership)
  fastify.post<{ Params: WorkspaceParams }>(
    '/api/v1/workspaces/:workspaceId/invites',
    workspaceAuthHook,
    handleCreateInvite
  );
  fastify.get<{ Params: WorkspaceParams }>(
    '/api/v1/workspaces/:workspaceId/invites',
    workspaceAuthHook,
    handleListInvites
  );
  fastify.delete<{ Params: InviteParams }>(
    '/api/v1/workspaces/:workspaceId/invites/:inviteId',
    workspaceAuthHook,
    handleRevokeInvite
  );

  // Public invite routes (by token)
  fastify.get<{ Params: TokenParams }>(
    '/api/v1/invites/:token',
    optionalAuthHook,
    handleGetInviteInfo
  );
  fastify.post<{ Params: TokenParams }>(
    '/api/v1/invites/:token/redeem',
    authHook,
    handleRedeemInvite
  );
}
