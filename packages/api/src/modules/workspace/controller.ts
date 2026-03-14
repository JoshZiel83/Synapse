import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authMiddleware, optionalAuth } from '../../infrastructure/middleware/auth.js';
import { authzEnabled, checkPermission } from '../../infrastructure/authz/index.js';
import {
  createWorkspace,
  listUserWorkspaces,
  getWorkspaceById,
  updateWorkspace,
  checkMembership,
  addMember,
  listMembers,
  listWorkspaceRoleAssignments,
  assignWorkspaceRole,
  revokeWorkspaceRole,
  type WorkspaceSupplementalRole,
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

const workspaceRoleSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['model_admin', 'actor_admin', 'capability_admin', 'memory_admin', 'relay_admin', 'conversation_admin']),
  metadata: z.record(z.unknown()).optional(),
});

// ── Helpers ──

type WorkspaceParams = { workspaceId: string };

function hasLegacyWorkspacePermission(
  trustLevel: string | null,
  permission: string,
) {
  switch (permission) {
    case 'view':
      return Boolean(trustLevel);
    case 'create_conversation':
      return trustLevel === 'owner' || trustLevel === 'admin' || trustLevel === 'member';
    case 'manage':
    case 'manage_members':
    case 'manage_actors':
    case 'manage_conversations':
    case 'manage_capabilities':
    case 'manage_memories':
    case 'manage_relays':
    case 'manage_models':
      return trustLevel === 'owner' || trustLevel === 'admin';
    default:
      return false;
  }
}

async function canWorkspacePermission(
  workspaceId: string,
  userId: string,
  permission: string,
): Promise<boolean> {
  if (!authzEnabled()) {
    const trustLevel = await checkMembership(workspaceId, userId);
    return hasLegacyWorkspacePermission(trustLevel, permission);
  }

  return checkPermission({
    resourceType: 'workspace',
    resourceId: workspaceId,
    permission,
    subject: { type: 'user', id: userId },
  });
}

async function requireWorkspacePermission(
  request: FastifyRequest<{ Params: WorkspaceParams }>,
  reply: FastifyReply,
  permission: string,
  errorMessage = 'Forbidden'
): Promise<boolean> {
  const { workspaceId } = request.params;
  const userId = (request as any).user!.userId;

  const allowed = await canWorkspacePermission(workspaceId, userId, permission);
  if (!allowed) {
    reply.status(403).send({ error: errorMessage });
    return false;
  }

  return true;
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
  const allowed = await requireWorkspacePermission(request, reply, 'view', 'Not allowed to view this workspace');
  if (!allowed) return;

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
  const allowed = await requireWorkspacePermission(request, reply, 'manage', 'Not allowed to manage this workspace');
  if (!allowed) return;

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
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    'manage_members',
    'Not allowed to manage workspace members'
  );
  if (!allowed) return;

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
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    'manage_members',
    'Not allowed to view workspace members'
  );
  if (!allowed) return;

  const members = await listMembers(request.params.workspaceId);
  return reply.send({ data: members });
}

export async function handleListWorkspaceRoles(
  request: FastifyRequest<{ Params: WorkspaceParams }>,
  reply: FastifyReply
) {
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    'manage_members',
    'Not allowed to view workspace roles'
  );
  if (!allowed) return;

  const roles = await listWorkspaceRoleAssignments(request.params.workspaceId);
  return reply.send({ data: roles });
}

export async function handleGetWorkspaceNavigation(
  request: FastifyRequest<{ Params: WorkspaceParams }>,
  reply: FastifyReply
) {
  const userId = (request as any).user!.userId;
  const { workspaceId } = request.params;

  const [canViewWorkspace, canAccessWorkspaceModels, canAccessWorkspaceRoles] = await Promise.all([
    canWorkspacePermission(workspaceId, userId, 'view'),
    canWorkspacePermission(workspaceId, userId, 'manage_models'),
    canWorkspacePermission(workspaceId, userId, 'manage_members'),
  ]);

  return reply.send({
    data: {
      canViewWorkspace,
      canAccessWorkspaceModels,
      canAccessWorkspaceUserModels: canViewWorkspace,
      canAccessWorkspaceRoles,
    },
  });
}

export async function handleAssignWorkspaceRole(
  request: FastifyRequest<{ Params: WorkspaceParams }>,
  reply: FastifyReply
) {
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    'manage_members',
    'Not allowed to manage workspace roles'
  );
  if (!allowed) return;

  const parsed = workspaceRoleSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
  }

  try {
    const role = await assignWorkspaceRole({
      workspaceId: request.params.workspaceId,
      userId: parsed.data.userId,
      role: parsed.data.role as WorkspaceSupplementalRole,
      assignedBy: (request as any).user!.userId,
      metadata: parsed.data.metadata as Record<string, unknown> | undefined,
    });
    return reply.status(201).send(role);
  } catch (err: any) {
    const msg = err.message || 'Failed to assign workspace role';
    if (msg === 'User is not a member of this workspace') {
      return reply.status(400).send({ error: msg });
    }
    if (msg === 'Role already assigned') {
      return reply.status(409).send({ error: msg });
    }
    throw err;
  }
}

export async function handleRevokeWorkspaceRole(
  request: FastifyRequest<{ Params: WorkspaceParams & { userId: string; role: WorkspaceSupplementalRole } }>,
  reply: FastifyReply
) {
  const allowed = await requireWorkspacePermission(
    request as FastifyRequest<{ Params: WorkspaceParams }>,
    reply,
    'manage_members',
    'Not allowed to manage workspace roles'
  );
  if (!allowed) return;

  try {
    await revokeWorkspaceRole(request.params.workspaceId, request.params.userId, request.params.role);
    return reply.status(204).send();
  } catch (err: any) {
    const msg = err.message || 'Failed to revoke workspace role';
    if (msg === 'Role not found') {
      return reply.status(404).send({ error: msg });
    }
    throw err;
  }
}

// ── Invite Handlers ──

type InviteParams = { workspaceId: string; inviteId: string };
type TokenParams = { token: string };

export async function handleCreateInvite(
  request: FastifyRequest<{ Params: WorkspaceParams }>,
  reply: FastifyReply
) {
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    'manage_members',
    'Not allowed to manage workspace invites'
  );
  if (!allowed) return;

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
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    'manage_members',
    'Not allowed to view workspace invites'
  );
  if (!allowed) return;

  const invites = await listWorkspaceInvites(request.params.workspaceId);
  return reply.send({ data: invites });
}

export async function handleRevokeInvite(
  request: FastifyRequest<{ Params: InviteParams }>,
  reply: FastifyReply
) {
  const allowed = await requireWorkspacePermission(
    request as FastifyRequest<{ Params: WorkspaceParams }>,
    reply,
    'manage_members',
    'Not allowed to manage workspace invites'
  );
  if (!allowed) return;

  const { workspaceId, inviteId } = request.params;

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
  fastify.get<{ Params: WorkspaceParams }>(
    '/api/v1/workspaces/:workspaceId/navigation',
    authHook,
    handleGetWorkspaceNavigation
  );
  fastify.get<{ Params: WorkspaceParams }>(
    '/api/v1/workspaces/:workspaceId/roles',
    workspaceAuthHook,
    handleListWorkspaceRoles
  );
  fastify.post<{ Params: WorkspaceParams }>(
    '/api/v1/workspaces/:workspaceId/roles',
    workspaceAuthHook,
    handleAssignWorkspaceRole
  );
  fastify.post<{ Params: WorkspaceParams & { userId: string; role: WorkspaceSupplementalRole } }>(
    '/api/v1/workspaces/:workspaceId/roles/:role/users/:userId/revoke',
    workspaceAuthHook,
    handleRevokeWorkspaceRole
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
