import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { workspaceMiddleware } from '../../infrastructure/middleware/workspace.js';
import {
  listOrganizations, getOrganization,
  listPlugins, getPlugin,
  listPluginCategories,
  createPluginInstallPlan,
  installPluginUnified, uninstallPluginUnified, getInstallation, getInstallations, updateInstallation,
  validateConfig,
  McpPluginError,
} from './service.js';
import {
  getPluginAuthSession,
  handlePluginAuthCallback,
  PluginAuthError,
  startPluginAuthSession,
} from './auth-service.js';
import { getToolCallLogs, getEventLogs } from './audit.js';

// ============ Schemas ============

const installSchema = z.object({
  pluginId: z.string().uuid(),
  scopeType: z.enum(['workspace', 'conversation', 'actor_global', 'actor_conversation', 'user']),
  actorId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  lifecycleScope: z.enum(['turn', 'workspace', 'conversation', 'actor_global', 'actor_conversation', 'user']).optional(),
  configData: z.record(z.unknown()).optional(),
  authSessionIds: z.record(z.string().uuid()).optional(),
});

const updateInstallSchema = z.object({
  isEnabled: z.boolean().optional(),
  configData: z.record(z.unknown()).optional(),
  lifecycleScope: z.enum(['turn', 'workspace', 'conversation', 'actor_global', 'actor_conversation', 'user']).optional(),
  scopeType: z.enum(['workspace', 'conversation', 'actor_global', 'actor_conversation', 'user']).optional(),
  actorId: z.string().uuid().nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
  userId: z.string().uuid().nullable().optional(),
  authSessionIds: z.record(z.string().uuid()).optional(),
});

const installPlanSchema = z.object({
  scopeType: z.enum(['workspace', 'conversation', 'actor_global', 'actor_conversation', 'user']),
  actorId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
});

// ============ Error handling ============

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof McpPluginError) {
    return reply.status(error.statusCode).send({ error: error.message });
  }
  if (error instanceof PluginAuthError) {
    return reply.status(error.statusCode).send({ error: error.message });
  }
  if (error instanceof z.ZodError) {
    return reply.status(400).send({ error: 'Validation error', details: error.errors });
  }
  console.error('[MCP Controller]', error);
  return reply.status(500).send({ error: 'Internal server error' });
}

// ============ Route registration ============

export function registerMcpPluginRoutes(app: FastifyInstance) {
  const wsPreHandler = [authMiddleware, workspaceMiddleware];
  const authPreHandler = [authMiddleware];

  // ========== Marketplace (auth required) ==========

  app.get('/api/v1/mcp/marketplace', { preHandler: authPreHandler }, async (request, reply) => {
    try {
      const { search, tags, categories, transport } = request.query as { search?: string; tags?: string; categories?: string; transport?: string };
      const plugins = await listPlugins({
        search,
        transport,
        tags: tags ? tags.split(',') : undefined,
        categorySlugs: categories ? categories.split(',') : undefined,
      });
      reply.send(plugins);
    } catch (error) {
      handleError(reply, error);
    }
  });

  app.get('/api/v1/mcp/categories', { preHandler: authPreHandler }, async (_request, reply) => {
    try {
      const categories = await listPluginCategories();
      reply.send(categories);
    } catch (error) {
      handleError(reply, error);
    }
  });

  app.get('/api/v1/mcp/marketplace/:pluginId', { preHandler: authPreHandler }, async (request, reply) => {
    try {
      const { pluginId } = request.params as { pluginId: string };
      const plugin = await getPlugin(pluginId);
      reply.send(plugin);
    } catch (error) {
      handleError(reply, error);
    }
  });

  app.post('/api/v1/workspaces/:workspaceId/mcp/plugins/:pluginId/install-plan', { preHandler: wsPreHandler }, async (request, reply) => {
    try {
      const { workspaceId, pluginId } = request.params as { workspaceId: string; pluginId: string };
      const data = installPlanSchema.parse(request.body);
      const plan = await createPluginInstallPlan({
        workspaceId,
        pluginId,
        bindingScope: data.scopeType,
        actorId: data.actorId,
        conversationId: data.conversationId,
        userId: data.userId,
      });
      reply.send({ plan });
    } catch (error) {
      handleError(reply, error);
    }
  });

  app.post('/api/v1/workspaces/:workspaceId/mcp/plugins/:pluginId/auth/:providerKey/start', { preHandler: wsPreHandler }, async (request, reply) => {
    try {
      const { workspaceId, pluginId, providerKey } = request.params as { workspaceId: string; pluginId: string; providerKey: string };
      const user = (request as any).user;
      const result = await startPluginAuthSession({
        workspaceId,
        pluginId,
        providerKey,
        userId: user.id || user.userId,
      });
      reply.send(result);
    } catch (error) {
      handleError(reply, error);
    }
  });

  app.get('/api/v1/workspaces/:workspaceId/mcp/auth/sessions/:sessionId', { preHandler: wsPreHandler }, async (request, reply) => {
    try {
      const { workspaceId, sessionId } = request.params as { workspaceId: string; sessionId: string };
      const user = (request as any).user;
      const session = await getPluginAuthSession(sessionId, workspaceId, user.id || user.userId);
      reply.send({ session });
    } catch (error) {
      handleError(reply, error);
    }
  });

  app.get('/api/v1/mcp/auth/callback', async (request, reply) => {
    try {
      const { state, code, error, error_description: errorDescription } = request.query as {
        state?: string;
        code?: string;
        error?: string;
        error_description?: string;
      };
      const session = await handlePluginAuthCallback({ state, code, error, errorDescription });
      reply
        .type('text/html; charset=utf-8')
        .send(`<!doctype html><html><body><script>window.opener&&window.opener.postMessage({type:'synapse:mcp-auth',sessionId:'${session.id}',status:'${session.status}'},'*');window.close&&window.close();</script><p>Authorization ${session.status}. You can close this window.</p></body></html>`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Authorization failed';
      reply
        .status(400)
        .type('text/html; charset=utf-8')
        .send(`<!doctype html><html><body><p>${message}</p></body></html>`);
    }
  });

  // ========== Organizations ==========

  app.get('/api/v1/mcp/organizations', { preHandler: authPreHandler }, async (_request, reply) => {
    try {
      const orgs = await listOrganizations();
      reply.send(orgs);
    } catch (error) {
      handleError(reply, error);
    }
  });

  app.get('/api/v1/mcp/organizations/:orgId', { preHandler: authPreHandler }, async (request, reply) => {
    try {
      const { orgId } = request.params as { orgId: string };
      const org = await getOrganization(orgId);
      const plugins = await listPlugins({ orgId });
      reply.send({ ...org, plugins });
    } catch (error) {
      handleError(reply, error);
    }
  });

  // ========== Unified Installations ==========

  app.get('/api/v1/workspaces/:workspaceId/mcp/installations', { preHandler: wsPreHandler }, async (request, reply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const { scopeType, conversationId, actorId, userId, pluginId } = request.query as {
        scopeType?: any; conversationId?: string; actorId?: string; userId?: string; pluginId?: string;
      };
      const installations = await getInstallations(workspaceId, { scopeType, conversationId, actorId, userId, pluginId });
      reply.send(installations);
    } catch (error) {
      handleError(reply, error);
    }
  });

  app.get('/api/v1/workspaces/:workspaceId/mcp/installations/:installId', { preHandler: wsPreHandler }, async (request, reply) => {
    try {
      const { workspaceId, installId } = request.params as { workspaceId: string; installId: string };
      const installation = await getInstallation(workspaceId, installId);
      reply.send({ installation });
    } catch (error) {
      handleError(reply, error);
    }
  });

  app.post('/api/v1/workspaces/:workspaceId/mcp/installations', { preHandler: wsPreHandler }, async (request, reply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const data = installSchema.parse(request.body);
      const user = (request as any).user;

      // Validate config against plugin's validation rules if config provided
      if (data.configData) {
        const plugin = await getPlugin(data.pluginId);
        const rules = plugin.validation_rules || [];
        if (rules.length > 0) {
          const validation = validateConfig(data.configData, rules);
          if (!validation.valid) {
            return reply.status(400).send({ error: 'Validation failed', details: validation.errors });
          }
        }
      }

      const installation = await installPluginUnified({
        workspaceId,
        pluginId: data.pluginId,
        scopeType: data.scopeType,
        actorId: data.actorId,
        conversationId: data.conversationId,
        userId: data.userId,
        lifecycleScope: data.lifecycleScope,
        configData: data.configData,
        authSessionIds: data.authSessionIds,
        installedBy: user.id || user.userId,
      });
      reply.status(201).send(installation);
    } catch (error) {
      handleError(reply, error);
    }
  });

  app.put('/api/v1/workspaces/:workspaceId/mcp/installations/:installId', { preHandler: wsPreHandler }, async (request, reply) => {
    try {
      const { installId } = request.params as { installId: string };
      const data = updateInstallSchema.parse(request.body);

      // Validate config against plugin's validation rules if updating config
      if (data.configData) {
        const { query: dbQuery } = await import('../../infrastructure/database/index.js');
        const installRow = await dbQuery('SELECT package_id FROM capability_bindings WHERE id = $1', [installId]);
        if (installRow.rows.length > 0) {
          const plugin = await getPlugin(installRow.rows[0].package_id);
          const rules = plugin.validation_rules || [];
          if (rules.length > 0) {
            const validation = validateConfig(data.configData, rules);
            if (!validation.valid) {
              return reply.status(400).send({ error: 'Validation failed', details: validation.errors });
            }
          }
        }
      }

      const user = (request as any).user;
      const installation = await updateInstallation(installId, {
        ...data,
        updatedBy: user.id || user.userId,
      });
      reply.send(installation);
    } catch (error) {
      handleError(reply, error);
    }
  });

  app.delete('/api/v1/workspaces/:workspaceId/mcp/installations/:installId', { preHandler: wsPreHandler }, async (request, reply) => {
    try {
      const { installId } = request.params as { installId: string };
      await uninstallPluginUnified(installId);
      reply.send({ success: true });
    } catch (error) {
      handleError(reply, error);
    }
  });

  // ========== Audit Logs ==========

  app.get('/api/v1/workspaces/:workspaceId/mcp/audit/tool-calls', { preHandler: wsPreHandler }, async (request, reply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const { pluginId, sessionId, actorId, limit, before } = request.query as {
        pluginId?: string; sessionId?: string; actorId?: string; limit?: string; before?: string;
      };
      const logs = await getToolCallLogs(workspaceId, {
        pluginId, sessionId, actorId,
        limit: limit ? parseInt(limit) : undefined,
        before,
      });
      reply.send(logs);
    } catch (error) {
      handleError(reply, error);
    }
  });

  app.get('/api/v1/workspaces/:workspaceId/mcp/audit/events', { preHandler: wsPreHandler }, async (request, reply) => {
    try {
      const { workspaceId } = request.params as { workspaceId: string };
      const { eventType, pluginId, limit, before } = request.query as {
        eventType?: string; pluginId?: string; limit?: string; before?: string;
      };
      const logs = await getEventLogs(workspaceId, {
        eventType, pluginId,
        limit: limit ? parseInt(limit) : undefined,
        before,
      });
      reply.send(logs);
    } catch (error) {
      handleError(reply, error);
    }
  });
}
