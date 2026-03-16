import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { workspaceMiddleware } from '../../infrastructure/middleware/workspace.js';
import { AUTHZ_PLATFORM_ID } from '../../infrastructure/authz/index.js';
import { requireRequestAction } from '../access/guards.js';
import {
  SkillError,
  getInstalledSkill,
  getMarketplaceSkill,
  installMarketplaceSkill,
  listInstalledSkills,
  listMarketplaceSkills,
  publishMarketplaceSkill,
  uninstallInstalledSkill,
  updateInstalledSkill,
  upgradeInstalledSkill,
} from './service.js';

const useScopeSchema = z.enum(['workspace', 'conversation', 'actor_global', 'actor_conversation', 'user']);

const skillFileSchema = z.object({
  path: z.string().min(1),
  contentBlocks: z.array(z.any()).default([]),
});

const publishSkillSchema = z.object({
  skillId: z.string().uuid().optional(),
  slug: z.string().min(1),
  name: z.string().min(1),
  summary: z.string().optional(),
  iconUrl: z.string().url().optional(),
  tags: z.array(z.string()).optional(),
  version: z.string().min(1),
  entryPath: z.string().optional(),
  changelog: z.string().optional(),
  isActive: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
  files: z.array(skillFileSchema).min(1),
});

const installSkillSchema = z.object({
  marketSkillId: z.string().uuid(),
  useScope: useScopeSchema,
  actorId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
});

const updateInstalledSkillSchema = z.object({
  name: z.string().min(1).optional(),
  summary: z.string().optional(),
  iconUrl: z.string().url().nullable().optional(),
  tags: z.array(z.string()).optional(),
  entryPath: z.string().optional(),
  useScope: useScopeSchema.optional(),
  actorId: z.string().uuid().nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
  userId: z.string().uuid().nullable().optional(),
  isEnabled: z.boolean().optional(),
  files: z.array(skillFileSchema).optional(),
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

async function requirePlatformManage(
  request: FastifyRequest,
  reply: FastifyReply,
  errorMessage: string,
) {
  return requireRequestAction(
    request,
    reply,
    'platform.manage',
    AUTHZ_PLATFORM_ID,
    errorMessage,
  );
}

export function registerSkillRoutes(app: FastifyInstance) {
  const authHook = { preHandler: [authMiddleware] };
  const workspaceHook = { preHandler: [authMiddleware, workspaceMiddleware] };

  app.get('/api/v1/skills/marketplace', authHook, async (request, reply) => {
    try {
      const { search, tags } = request.query as {
        search?: string;
        tags?: string;
      };
      const skills = await listMarketplaceSkills({
        search,
        tags: tags ? tags.split(',').map((tag) => tag.trim()).filter(Boolean) : undefined,
      });
      return reply.status(200).send({ skills });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/skills/marketplace/:skillId', authHook, async (request, reply) => {
    try {
      const { skillId } = request.params as { skillId: string };
      const skill = await getMarketplaceSkill(skillId);
      return reply.status(200).send({ skill });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/api/v1/skills/marketplace', authHook, async (request, reply) => {
    try {
      const allowed = await requirePlatformManage(
        request,
        reply,
        'Not allowed to publish marketplace skills',
      );
      if (!allowed) return;

      const body = publishSkillSchema.parse(request.body);
      const user = (request as any).user;
      const skill = await publishMarketplaceSkill({
        ...body,
        authorUserId: user?.id || user?.userId,
      });
      return reply.status(201).send({ skill });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/workspaces/:workspaceId/skills', workspaceHook, async (request, reply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const allowed = await requireRequestAction(
        request,
        reply,
        'workspace.view',
        workspaceId,
        'Not allowed to view installed skills in this workspace',
      );
      if (!allowed) return;

      const { useScope, actorId, conversationId, userId, sourceSkillId } = request.query as {
        useScope?: 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user';
        actorId?: string;
        conversationId?: string;
        userId?: string;
        sourceSkillId?: string;
      };

      const skills = await listInstalledSkills(workspaceId, {
        useScope,
        actorId,
        conversationId,
        userId,
        sourceSkillId,
      });
      return reply.status(200).send({ skills });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/api/v1/workspaces/:workspaceId/skills', workspaceHook, async (request, reply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const allowed = await requireRequestAction(
        request,
        reply,
        'workspace.manage_capabilities',
        workspaceId,
        'Not allowed to install skills in this workspace',
      );
      if (!allowed) return;

      const body = installSkillSchema.parse(request.body);
      const user = (request as any).user;
      const skill = await installMarketplaceSkill({
        workspaceId,
        marketSkillId: body.marketSkillId,
        useScope: body.useScope,
        actorId: body.actorId,
        conversationId: body.conversationId,
        userId: body.userId,
        installedBy: user?.id || user?.userId,
      });
      return reply.status(201).send({ skill });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/workspaces/:workspaceId/skills/:installedSkillId', workspaceHook, async (request, reply) => {
    try {
      const { workspaceId, installedSkillId } = request.params as { workspaceId: string; installedSkillId: string };
      const allowed = await requireRequestAction(
        request,
        reply,
        'workspace.view',
        workspaceId,
        'Not allowed to view installed skill details in this workspace',
      );
      if (!allowed) return;

      const skill = await getInstalledSkill(workspaceId, installedSkillId);
      return reply.status(200).send({ skill });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.put('/api/v1/workspaces/:workspaceId/skills/:installedSkillId', workspaceHook, async (request, reply) => {
    try {
      const { workspaceId, installedSkillId } = request.params as { workspaceId: string; installedSkillId: string };
      const allowed = await requireRequestAction(
        request,
        reply,
        'workspace.manage_capabilities',
        workspaceId,
        'Not allowed to edit installed skills in this workspace',
      );
      if (!allowed) return;

      const body = updateInstalledSkillSchema.parse(request.body);
      const skill = await updateInstalledSkill({
        workspaceId,
        installedSkillId,
        ...body,
      });
      return reply.status(200).send({ skill });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/api/v1/workspaces/:workspaceId/skills/:installedSkillId/upgrade', workspaceHook, async (request, reply) => {
    try {
      const { workspaceId, installedSkillId } = request.params as { workspaceId: string; installedSkillId: string };
      const allowed = await requireRequestAction(
        request,
        reply,
        'workspace.manage_capabilities',
        workspaceId,
        'Not allowed to upgrade installed skills in this workspace',
      );
      if (!allowed) return;

      const skill = await upgradeInstalledSkill({
        workspaceId,
        installedSkillId,
      });
      return reply.status(200).send({ skill });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.delete('/api/v1/workspaces/:workspaceId/skills/:installedSkillId', workspaceHook, async (request, reply) => {
    try {
      const { workspaceId, installedSkillId } = request.params as { workspaceId: string; installedSkillId: string };
      const allowed = await requireRequestAction(
        request,
        reply,
        'workspace.manage_capabilities',
        workspaceId,
        'Not allowed to uninstall skills in this workspace',
      );
      if (!allowed) return;

      await uninstallInstalledSkill(workspaceId, installedSkillId);
      return reply.status(204).send();
    } catch (error) {
      return handleError(reply, error);
    }
  });
}
