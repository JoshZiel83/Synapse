import { z } from "zod"
import type { FastifyInstance, FastifyReply } from "fastify"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import {
  requireRequestAction,
  listAuthorizedResourceIdsDefault,
} from "../access/guards.js"
import { getRequestAccessSubject } from "../access/service.js"
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
import { presentPluginCategory, presentPublisher } from "./presenter.js"
import { getEventLogs, getToolCallLogs } from "./audit.js"
import { appRoute, wireRoute } from "../../infrastructure/http/route.js"
import {
  MarketplacePluginViewSchema,
  MarketplacePublisherViewSchema,
  PluginCategoryViewSchema,
  PluginInstallationDetailViewSchema,
  PluginAuthSessionEnvelopeSchema,
  PluginInstallPlanEnvelopeSchema,
  PluginAuditLogListSchema,
  StartPluginAuthInputSchema,
} from "@synapse/shared/schemas"

// App-facing request body lives in @synapse/shared (§5.1.1) so the API parser
// and the web/mobile clients share one definition. install-plan takes no body.
const installPlanSchema = z.object({})
const startAuthSchema = StartPluginAuthInputSchema

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

  appRoute(
    app,
    "GET",
    "/api/v1/mcp/marketplace",
    { schema: z.array(MarketplacePluginViewSchema), options: authHook },
    async (request, reply) => {
      try {
        const { search, tags, categories, transport } = request.query as {
          search?: string
          tags?: string
          categories?: string
          transport?: string
        }
        return await listPlugins({
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
      } catch (error) {
        handleError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/mcp/categories",
    { schema: z.array(PluginCategoryViewSchema), options: authHook },
    async (_request, reply) => {
      try {
        const categories = await listPluginCategories()
        return categories.map(presentPluginCategory)
      } catch (error) {
        handleError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/mcp/marketplace/:pluginId",
    { schema: MarketplacePluginViewSchema, options: authHook },
    async (request, reply) => {
      try {
        const { pluginId } = request.params as { pluginId: string }
        return await getPlugin(pluginId)
      } catch (error) {
        handleError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/mcp/organizations",
    { schema: z.array(MarketplacePublisherViewSchema), options: authHook },
    async (_request, reply) => {
      try {
        const orgs = await listOrganizations()
        return orgs.map(presentPublisher)
      } catch (error) {
        handleError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/mcp/organizations/:orgId",
    {
      schema: MarketplacePublisherViewSchema.extend({
        plugins: z.array(MarketplacePluginViewSchema),
      }),
      options: authHook,
    },
    async (request, reply) => {
      try {
        const { orgId } = request.params as { orgId: string }
        const org = await getOrganization(orgId)
        if (!org) {
          throw new McpPluginError(404, "Publisher not found")
        }
        const plugins = await listPlugins({ orgId })
        return { ...presentPublisher(org), plugins }
      } catch (error) {
        handleError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/mcp/plugins/:pluginId/install-plan",
    { schema: PluginInstallPlanEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.manage_plugins",
          "Not allowed to manage plugin installations in this workspace"
        )
        if (!allowed) return undefined

        const { workspaceId, pluginId } = request.params as {
          workspaceId: string
          pluginId: string
        }
        installPlanSchema.parse(request.body || {})
        const plan = await createPluginInstallPlan({
          workspaceId,
          pluginId,
        })
        return { plan }
      } catch (error) {
        handleError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/mcp/plugins/:pluginId/auth/:bindingKey/start",
    { schema: PluginAuthSessionEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.manage_plugins",
          "Not allowed to manage plugin installations in this workspace"
        )
        if (!allowed) return undefined

        const { workspaceId, pluginId, bindingKey } = request.params as {
          workspaceId: string
          pluginId: string
          bindingKey: string
        }
        const body = startAuthSchema.parse(request.body || {})
        const workspaceMember = (request as any).workspaceMember
        return await startPluginAuthSession({
          workspaceId,
          pluginId,
          installationId: body.installationId,
          bindingKey,
          workspaceMemberId: workspaceMember?.id,
          draftConfig: body.draftConfig,
          metadata: body.metadata,
        })
      } catch (error) {
        handleError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/mcp/auth/sessions/:sessionId",
    { schema: PluginAuthSessionEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.manage_plugins",
          "Not allowed to manage plugin installations in this workspace"
        )
        if (!allowed) return undefined

        const { workspaceId, sessionId } = request.params as {
          workspaceId: string
          sessionId: string
        }
        const workspaceMember = (request as any).workspaceMember
        return {
          session: await getPluginAuthSession(
            sessionId,
            workspaceId,
            workspaceMember?.id
          ),
        }
      } catch (error) {
        handleError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/mcp/auth/sessions/:sessionId/inspect",
    { schema: PluginAuthSessionEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.manage_plugins",
          "Not allowed to manage plugin installations in this workspace"
        )
        if (!allowed) return undefined

        const { workspaceId, sessionId } = request.params as {
          workspaceId: string
          sessionId: string
        }
        const workspaceMember = (request as any).workspaceMember
        return await inspectPluginAuthSession({
          workspaceId,
          sessionId,
          workspaceMemberId: workspaceMember?.id,
        })
      } catch (error) {
        handleError(reply, error)
        return undefined
      }
    }
  )

  wireRoute(
    app,
    "GET",
    "/api/v1/mcp/auth/callback",
    {},
    async (request, reply) => {
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
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/mcp/installations",
    {
      schema: z.array(PluginInstallationDetailViewSchema),
      options: workspaceHook,
    },
    async (request, reply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.view",
          "Not allowed to view plugin installations in this workspace"
        )
        if (!allowed) return undefined

        const { workspaceId } = request.params as { workspaceId: string }
        const installationIds = await listAuthorizedResourceIdsDefault({
          subject: getRequestAccessSubject(request),
          action: "plugin_installation.edit",
        })
        if (installationIds.length === 0) {
          return []
        }
        const { pluginId } = z
          .object({
            pluginId: z.uuid().optional(),
          })
          .parse(request.query || {})
        return await getInstallations(workspaceId, {
          installationIds,
          pluginId,
        })
      } catch (error) {
        handleError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/mcp/installations/:installId",
    { schema: PluginInstallationDetailViewSchema, options: workspaceHook },
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
        if (!allowed) return undefined

        const { workspaceId } = request.params as {
          workspaceId: string
        }
        return await getInstallation(workspaceId, installId)
      } catch (error) {
        handleError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/mcp/audit/tool-calls",
    { schema: PluginAuditLogListSchema, options: workspaceHook },
    async (request, reply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.manage_plugins",
          "Not allowed to view plugin audit logs in this workspace"
        )
        if (!allowed) return undefined

        const { workspaceId } = request.params as { workspaceId: string }
        const { pluginId, sessionId, actorId, limit, before } =
          request.query as {
            pluginId?: string
            sessionId?: string
            actorId?: string
            limit?: string
            before?: string
          }
        return await getToolCallLogs(workspaceId, {
          pluginId,
          sessionId,
          actorId,
          limit: limit ? parseInt(limit, 10) : undefined,
          before,
        })
      } catch (error) {
        handleError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/mcp/audit/events",
    { schema: PluginAuditLogListSchema, options: workspaceHook },
    async (request, reply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request,
          reply,
          "workspace.manage_plugins",
          "Not allowed to view plugin audit logs in this workspace"
        )
        if (!allowed) return undefined

        const { workspaceId } = request.params as { workspaceId: string }
        const { eventType, pluginId, limit, before } = request.query as {
          eventType?: string
          pluginId?: string
          limit?: string
          before?: string
        }
        return await getEventLogs(workspaceId, {
          eventType,
          pluginId,
          limit: limit ? parseInt(limit, 10) : undefined,
          before,
        })
      } catch (error) {
        handleError(reply, error)
        return undefined
      }
    }
  )
}
