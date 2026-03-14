import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { AUTHZ_PLATFORM_ID, authzEnabled, checkPermission } from '../../infrastructure/authz/index.js';
import {
  assignPlatformRole,
  hasPlatformRole,
  listPlatformRoleAssignments,
  revokePlatformRole,
  type PlatformRole,
} from './admin-service.js';

const platformRoleSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['super_admin', 'workspace_admin', 'model_admin', 'support', 'auditor']),
  metadata: z.record(z.unknown()).optional(),
});

async function requirePlatformManagePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  errorMessage: string,
) {
  const userId = (request as any).user!.userId;

  const allowed = await canPlatformPermission(userId, 'manage');
  if (!allowed) {
    reply.status(403).send({ error: errorMessage });
    return false;
  }

  return true;
}

async function canPlatformPermission(
  userId: string,
  permission: string,
) {
  if (!authzEnabled()) {
    const allowed = await hasPlatformRole(userId, ['super_admin']);
    return allowed;
  }

  return checkPermission({
    resourceType: 'platform',
    resourceId: AUTHZ_PLATFORM_ID,
    permission,
    subject: { type: 'user', id: userId },
  });
}

export function registerPlatformRoutes(app: FastifyInstance) {
  const authHook = { preHandler: [authMiddleware] };

  app.get('/api/v1/platform/navigation', authHook, async (request, reply) => {
    const userId = (request as any).user!.userId;
    const canManagePlatform = await canPlatformPermission(userId, 'manage');

    return reply.send({
      data: {
        canAccessPlatformModels: canManagePlatform,
        canAccessPlatformRoles: canManagePlatform,
      },
    });
  });

  app.get('/api/v1/platform/roles', authHook, async (request, reply) => {
    const allowed = await requirePlatformManagePermission(
      request,
      reply,
      'Not allowed to manage platform roles',
    );
    if (!allowed) return;

    const roles = await listPlatformRoleAssignments();
    return reply.send({ data: roles });
  });

  app.post('/api/v1/platform/roles', authHook, async (request, reply) => {
    const allowed = await requirePlatformManagePermission(
      request,
      reply,
      'Not allowed to manage platform roles',
    );
    if (!allowed) return;

    const parsed = platformRoleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    try {
      const role = await assignPlatformRole({
        userId: parsed.data.userId,
        role: parsed.data.role as PlatformRole,
        assignedBy: (request as any).user!.userId,
        metadata: parsed.data.metadata as Record<string, unknown> | undefined,
      });
      return reply.status(201).send(role);
    } catch (err: any) {
      const msg = err.message || 'Failed to assign platform role';
      if (msg === 'User not found') {
        return reply.status(404).send({ error: msg });
      }
      if (msg === 'Role already assigned') {
        return reply.status(409).send({ error: msg });
      }
      throw err;
    }
  });

  app.post<{
    Params: { role: PlatformRole; userId: string };
  }>('/api/v1/platform/roles/:role/users/:userId/revoke', authHook, async (request, reply) => {
    const allowed = await requirePlatformManagePermission(
      request,
      reply,
      'Not allowed to manage platform roles',
    );
    if (!allowed) return;

    try {
      await revokePlatformRole(request.params.userId, request.params.role);
      return reply.status(204).send();
    } catch (err: any) {
      const msg = err.message || 'Failed to revoke platform role';
      if (msg === 'Role not found') {
        return reply.status(404).send({ error: msg });
      }
      if (msg === 'Config-managed role cannot be revoked manually') {
        return reply.status(409).send({ error: msg });
      }
      throw err;
    }
  });
}
