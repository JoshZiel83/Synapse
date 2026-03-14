import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { workspaceMiddleware } from '../../infrastructure/middleware/workspace.js';
import {
  SkillError,
  createSkill,
  createSkillInstallPlan,
  getSkill,
  getSkillAsset,
  installSkill,
  listSkillAssets,
  listSkillInstallations,
  listSkills,
  uninstallSkill,
  updateSkillInstallation,
} from './service.js';

const scopeEnum = z.enum(['workspace', 'conversation', 'actor_global', 'actor_conversation', 'user']);

const uploadSkillSchema = z.object({
  slug: z.string().optional(),
  version: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  longDescription: z.string().optional(),
  iconUrl: z.string().url().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  files: z.array(z.object({
    path: z.string().min(1),
    content: z.string().optional(),
    binaryBase64: z.string().optional(),
    mediaType: z.string().optional(),
  })).min(1),
});

const installSchema = z.object({
  skillId: z.string().uuid(),
  attachmentType: scopeEnum,
  actorId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
});

const updateInstallSchema = z.object({
  isEnabled: z.boolean().optional(),
  attachmentType: scopeEnum.optional(),
  actorId: z.string().uuid().nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
  userId: z.string().uuid().nullable().optional(),
});

const installPlanSchema = z.object({
  attachmentType: scopeEnum,
  actorId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
});

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof SkillError) {
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

export function registerSkillRoutes(app: FastifyInstance) {
  const preHandler = [authMiddleware, workspaceMiddleware];
  const prefix = '/api/v1/workspaces/:workspaceId/skills';

  app.get(prefix, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const skills = await listSkills(workspaceId);
      return reply.status(200).send({ skills });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post(prefix, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const user = (request as any).user;
      const body = uploadSkillSchema.parse(request.body);
      const skill = await createSkill({
        workspaceId,
        uploadedBy: user?.id || user?.userId,
        ...body,
      });
      return reply.status(201).send({ skill });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get(`${prefix}/:skillId`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId, skillId } = request.params as { workspaceId: string; skillId: string };
      const skill = await getSkill(workspaceId, skillId);
      return reply.status(200).send({ skill });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get(`${prefix}/:skillId/assets`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId, skillId } = request.params as { workspaceId: string; skillId: string };
      const assets = await listSkillAssets(workspaceId, skillId);
      return reply.status(200).send({ assets });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get(`${prefix}/:skillId/asset`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId, skillId } = request.params as { workspaceId: string; skillId: string };
      const { path } = request.query as { path?: string };
      if (!path) {
        return reply.status(400).send({ error: 'path is required' });
      }
      const asset = await getSkillAsset(workspaceId, skillId, path);
      return reply.status(200).send({ asset });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post(`${prefix}/:skillId/install-plan`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId, skillId } = request.params as { workspaceId: string; skillId: string };
      const body = installPlanSchema.parse(request.body);
      const plan = await createSkillInstallPlan({
        workspaceId,
        skillId,
        attachmentType: body.attachmentType,
        actorId: body.actorId,
        conversationId: body.conversationId,
        userId: body.userId,
      });
      return reply.status(200).send({ plan });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get(`${prefix}/installations`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const { attachmentType, actorId, conversationId, userId, skillId } = request.query as {
        attachmentType?: 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user';
        actorId?: string;
        conversationId?: string;
        userId?: string;
        skillId?: string;
      };
      const installations = await listSkillInstallations(workspaceId, {
        attachmentType,
        actorId,
        conversationId,
        userId,
        skillId,
      });
      return reply.status(200).send({ installations });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post(`${prefix}/installations`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const user = (request as any).user;
      const body = installSchema.parse(request.body);
      const installation = await installSkill({
        workspaceId,
        skillId: body.skillId,
        attachmentType: body.attachmentType,
        actorId: body.actorId,
        conversationId: body.conversationId,
        userId: body.userId,
        installedBy: user?.id || user?.userId,
      });
      return reply.status(201).send({ installation });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.put(`${prefix}/installations/:installationId`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { installationId } = request.params as { installationId: string };
      const body = updateInstallSchema.parse(request.body);
      const installation = await updateSkillInstallation(installationId, body);
      return reply.status(200).send({ installation });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.delete(`${prefix}/installations/:installationId`, { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { installationId } = request.params as { installationId: string };
      await uninstallSkill(installationId);
      return reply.status(204).send();
    } catch (error) {
      return handleError(reply, error);
    }
  });
}
