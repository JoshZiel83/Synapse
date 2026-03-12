import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { workspaceMiddleware } from '../../infrastructure/middleware/workspace.js';
import {
  CapabilityError,
  getCapabilityAuthorizationSummary,
  issueCapabilityGrant,
  listCapabilityGrants,
  revokeCapabilityGrant,
} from './service.js';

const grantScopeSchema = z.enum(['workspace', 'conversation', 'actor_global', 'actor_conversation', 'user']);

const issueGrantSchema = z.object({
  grantScope: grantScopeSchema.optional(),
  conversationId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  permissions: z.array(z.string().min(1)).optional(),
  reason: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const authorizationQuerySchema = z.object({
  conversationId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  userCount: z.coerce.number().int().min(0).optional(),
});

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof CapabilityError) {
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

export function registerCapabilityRoutes(app: FastifyInstance) {
  const preHandler = [authMiddleware, workspaceMiddleware];
  const prefix = '/api/v1/workspaces/:workspaceId/capabilities';

  app.get(`${prefix}/bindings/:bindingId/grants`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId, bindingId } = request.params as { workspaceId: string; bindingId: string };
      const summary = await getCapabilityAuthorizationSummary({ workspaceId, bindingId });
      return reply.status(200).send({
        grants: await listCapabilityGrants(bindingId),
        requiredPermissions: summary.requiredPermissions,
        suggestedGrantScope: summary.suggestedGrantScope,
        reason: summary.reason,
      });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get(`${prefix}/bindings/:bindingId/authorization`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId, bindingId } = request.params as { workspaceId: string; bindingId: string };
      const query = authorizationQuerySchema.parse(request.query ?? {});
      const summary = await getCapabilityAuthorizationSummary({
        workspaceId,
        bindingId,
        actorId: query.actorId,
        conversationId: query.conversationId,
        userId: query.userId,
        userCount: query.userCount,
      });
      return reply.status(200).send({ summary });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post(`${prefix}/bindings/:bindingId/grants`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId, bindingId } = request.params as { workspaceId: string; bindingId: string };
      const user = (request as any).user;
      const body = issueGrantSchema.parse(request.body);
      const grant = await issueCapabilityGrant({
        bindingId,
        workspaceId,
        grantScope: body.grantScope,
        conversationId: body.conversationId,
        actorId: body.actorId,
        userId: body.userId,
        permissions: body.permissions,
        grantedBy: user?.id || user?.userId,
        reason: body.reason,
        metadata: body.metadata,
      });
      return reply.status(201).send({ grant });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.delete(`${prefix}/grants/:grantId`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId, grantId } = request.params as { workspaceId: string; grantId: string };
      const grant = await revokeCapabilityGrant(grantId, workspaceId);
      return reply.status(200).send({ grant });
    } catch (error) {
      return handleError(reply, error);
    }
  });
}
