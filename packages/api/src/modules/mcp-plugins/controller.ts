import { z } from "zod"
import type { FastifyInstance, FastifyReply } from "fastify"
import { REUSE_SCOPES } from "@synapse/shared/constants"
import { db } from "../../infrastructure/database/kysely.js"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { requireRequestAction } from "../access/guards.js"
import {
  getRequestAccessSubject,
  listAuthorizedResourceIds,
} from "../access/service.js"
import {
  createPluginInstallPlan,
  getInstallation,
  getInstallations,
  getOrganization,
  getPlugin,
  listOrganizations,
  listPluginCategories,
  listPlugins,
  McpPluginError,
} from "./service.js"
import {
  getPluginAuthSession,
  handlePluginAuthCallback,
  inspectPluginAuthSession,
  PluginAuthError,
  startPluginAuthSession,
} from "./plugin-auth-connections.js"
import { getEventLogs, getToolCallLogs } from "./audit.js"

const lifecycleScopeSchema = z.enum(REUSE_SCOPES)
const conversationTypeMaskSchema = z.number().int().min(1).max(15)

const installPlanSchema = z.object({})

const startAuthSchema = z.object({
  installationId: z.uuid().optional(),
  draftConfig: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const log = createLogger("mcp.controller")

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof McpPluginError) {
    return reply.status(error.statusCode).send({ error: error.message })
  }
  if (error instanceof PluginAuthError) {
    return reply.status(error.statusCode).send({ error: error.message })
  }
  if (error instanceof z.ZodError) {
    return reply.status(400).send({
      error: "Validation error",
      details: error.issues,
    })
  }
  log.error({ err: error }, "[MCP Controller]")
  return reply.status(500).send({ error: "Internal server error" })
}

async function requireWorkspacePermission(
  request: any,
  reply: FastifyReply,
  action: "workspace.view" | "workspace.manage_plugins",
  errorMessage: string
) {
  const { workspaceId } = request.params as { workspaceId: string }
  return requireRequestAction(request, reply, action, workspaceId, errorMessage)
}

export function registerMcpPluginRoutes(app: FastifyInstance) {
  const authHook = { preHandler: [authMiddleware] }
  const workspaceHook = { preHandler: [authMiddleware, workspaceMiddleware] }

  app.get("/api/v1/mcp/marketplace", authHook, async (request, reply) => {
    try {
      const { search, tags, categories, transport } = request.query as {
        search?: string
        tags?: string
        categories?: string
        transport?: string
      }
      const plugins = await listPlugins({
        search,
        transport,
        tags: tags
          ? tags
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean)
          : undefined,
        categorySlugs: categories
          ? categories
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean)
          : undefined,
      })
      reply.send(plugins)
    } catch (error) {
      handleError(reply, error)
    }
  })

  app.get("/api/v1/mcp/categories", authHook, async (_request, reply) => {
    try {
      reply.send(await listPluginCategories())
    } catch (error) {
      handleError(reply, error)
    }
  })

  app.get(
    "/api/v1/mcp/marketplace/:pluginId",
    authHook,
    async (request, reply) => {
      try {
        const { pluginId } = request.params as { pluginId: string }
        reply.send(await getPlugin(pluginId))
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  app.get("/api/v1/mcp/organizations", authHook, async (_request, reply) => {
    try {
      reply.send(await listOrganizations())
    } catch (error) {
      handleError(reply, error)
    }
  })

  app.get(
    "/api/v1/mcp/organizations/:orgId",
    authHook,
    async (request, reply) => {
      try {
        const { orgId } = request.params as { orgId: string }
        const org = await getOrganization(orgId)
        const plugins = await listPlugins({ orgId })
        reply.send({ ...org, plugins })
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  app.post(
    "/api/v1/workspaces/:workspaceId/mcp/plugins/:pluginId/install-plan",
    workspaceHook,
    async (request, reply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.manage_plugins",
          "Not allowed to manage plugin installations in this workspace"
        )
        if (!allowed) return

        const { workspaceId, pluginId } = request.params as {
          workspaceId: string
          pluginId: string
        }
        installPlanSchema.parse(request.body || {})
        const plan = await createPluginInstallPlan({
          workspaceId,
          pluginId,
        })
        reply.send({ plan })
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  app.post(
    "/api/v1/workspaces/:workspaceId/mcp/plugins/:pluginId/auth/:bindingKey/start",
    workspaceHook,
    async (request, reply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.manage_plugins",
          "Not allowed to manage plugin installations in this workspace"
        )
        if (!allowed) return

        const { workspaceId, pluginId, bindingKey } = request.params as {
          workspaceId: string
          pluginId: string
          bindingKey: string
        }
        const body = startAuthSchema.parse(request.body || {})
        const workspaceMember = (request as any).workspaceMember
        const result = await startPluginAuthSession({
          workspaceId,
          pluginId,
          installationId: body.installationId,
          bindingKey,
          workspaceMemberId: workspaceMember?.id,
          draftConfig: body.draftConfig,
          metadata: body.metadata,
        })
        reply.send(result)
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  app.get(
    "/api/v1/workspaces/:workspaceId/mcp/auth/sessions/:sessionId",
    workspaceHook,
    async (request, reply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.manage_plugins",
          "Not allowed to manage plugin installations in this workspace"
        )
        if (!allowed) return

        const { workspaceId, sessionId } = request.params as {
          workspaceId: string
          sessionId: string
        }
        const workspaceMember = (request as any).workspaceMember
        reply.send({
          session: await getPluginAuthSession(
            sessionId,
            workspaceId,
            workspaceMember?.id
          ),
        })
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  app.post(
    "/api/v1/workspaces/:workspaceId/mcp/auth/sessions/:sessionId/inspect",
    workspaceHook,
    async (request, reply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.manage_plugins",
          "Not allowed to manage plugin installations in this workspace"
        )
        if (!allowed) return

        const { workspaceId, sessionId } = request.params as {
          workspaceId: string
          sessionId: string
        }
        const workspaceMember = (request as any).workspaceMember
        reply.send(
          await inspectPluginAuthSession({
            workspaceId,
            sessionId,
            workspaceMemberId: workspaceMember?.id,
          })
        )
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  app.get("/api/v1/mcp/auth/callback", async (request, reply) => {
    try {
      const {
        state,
        code,
        error,
        error_description: errorDescription,
      } = request.query as {
        state?: string
        code?: string
        error?: string
        error_description?: string
      }
      const session = await handlePluginAuthCallback({
        state,
        code,
        error,
        errorDescription,
      })
      reply
        .type("text/html; charset=utf-8")
        .send(
          `<!doctype html><html><body><script>window.opener&&window.opener.postMessage({type:'synapse:mcp-auth',sessionId:'${session.id}',status:'${session.status}'},'*');window.close&&window.close();</script><p>Authorization ${session.status}. You can close this window.</p></body></html>`
        )
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Authorization failed"
      reply
        .status(400)
        .type("text/html; charset=utf-8")
        .send(`<!doctype html><html><body><p>${message}</p></body></html>`)
    }
  })

  app.get(
    "/api/v1/workspaces/:workspaceId/mcp/installations",
    workspaceHook,
    async (request, reply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.view",
          "Not allowed to view plugin installations in this workspace"
        )
        if (!allowed) return

        const { workspaceId } = request.params as { workspaceId: string }
        const installationIds = await listAuthorizedResourceIds(db, {
          subject: getRequestAccessSubject(request),
          action: "plugin_installation.edit",
        })
        if (installationIds.length === 0) {
          return reply.send([])
        }
        const { pluginId } = z
          .object({
            pluginId: z.uuid().optional(),
          })
          .parse(request.query || {})
        reply.send(
          await getInstallations(workspaceId, {
            installationIds,
            pluginId,
          })
        )
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  app.get(
    "/api/v1/workspaces/:workspaceId/mcp/installations/:installId",
    workspaceHook,
    async (request, reply) => {
      try {
        const { installId } = request.params as { installId: string }
        const allowed = await requireRequestAction(
          request,
          reply,
          "plugin_installation.edit",
          installId,
          "Not allowed to view this plugin installation"
        )
        if (!allowed) return

        const { workspaceId } = request.params as {
          workspaceId: string
        }
        reply.send({
          installation: await getInstallation(workspaceId, installId),
        })
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  app.get(
    "/api/v1/workspaces/:workspaceId/mcp/audit/tool-calls",
    workspaceHook,
    async (request, reply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.manage_plugins",
          "Not allowed to view plugin audit logs in this workspace"
        )
        if (!allowed) return

        const { workspaceId } = request.params as { workspaceId: string }
        const { pluginId, sessionId, actorId, limit, before } =
          request.query as {
            pluginId?: string
            sessionId?: string
            actorId?: string
            limit?: string
            before?: string
          }
        reply.send(
          await getToolCallLogs(workspaceId, {
            pluginId,
            sessionId,
            actorId,
            limit: limit ? parseInt(limit, 10) : undefined,
            before,
          })
        )
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  app.get(
    "/api/v1/workspaces/:workspaceId/mcp/audit/events",
    workspaceHook,
    async (request, reply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.manage_plugins",
          "Not allowed to view plugin audit logs in this workspace"
        )
        if (!allowed) return

        const { workspaceId } = request.params as { workspaceId: string }
        const { eventType, pluginId, limit, before } = request.query as {
          eventType?: string
          pluginId?: string
          limit?: string
          before?: string
        }
        reply.send(
          await getEventLogs(workspaceId, {
            eventType,
            pluginId,
            limit: limit ? parseInt(limit, 10) : undefined,
            before,
          })
        )
      } catch (error) {
        handleError(reply, error)
      }
    }
  )
}
