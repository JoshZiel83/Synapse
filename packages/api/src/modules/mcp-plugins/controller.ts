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
  getPluginRecord,
  listOrganizations,
  listPluginCategories,
  listPluginRecords,
  McpPluginError,
} from "./service.js"
import {
  getPluginAuthSession,
  handlePluginAuthCallback,
  inspectPluginAuthSession,
  PluginAuthError,
  startPluginAuthSession,
} from "./plugin-auth-connections.js"
import {
  presentMarketplacePlugin,
  presentPluginInstallationDetail,
  presentPluginCategory,
  presentPublisher,
} from "./presenter.js"
import { getEventLogs, getToolCallLogs } from "./audit.js"
import { appRoute, wireRoute } from "../../infrastructure/http/route.js"
import {
  MarketplacePluginListViewSchema,
  MarketplacePluginViewSchema,
  MarketplacePublisherDetailViewSchema,
  MarketplacePublisherListViewSchema,
  MarketplacePublisherViewSchema,
  McpMarketplaceListQuerySchema,
  McpPluginEventAuditLogListQuerySchema,
  McpPluginInstallationListQuerySchema,
  McpPluginToolCallAuditLogListQuerySchema,
  PluginCategoryListViewSchema,
  PluginCategoryViewSchema,
  PluginInstallationDetailViewSchema,
  PluginInstallationListViewSchema,
  PluginAuthSessionEnvelopeSchema,
  PluginInstallPlanEnvelopeSchema,
  PluginAuditLogListSchema,
  PluginInstallPlanInputSchema,
  StartPluginAuthInputSchema,
} from "@synapse/shared/schemas"

// App-facing request body lives in @synapse/shared (§5.1.1) so the API parser
// and the web/mobile clients share one definition. install-plan takes no body.
const installPlanSchema = PluginInstallPlanInputSchema
const startAuthSchema = StartPluginAuthInputSchema
const marketplaceListQuerySchema = McpMarketplaceListQuerySchema
const installationListQuerySchema = McpPluginInstallationListQuerySchema
const toolCallAuditLogListQuerySchema = McpPluginToolCallAuditLogListQuerySchema
const eventAuditLogListQuerySchema = McpPluginEventAuditLogListQuerySchema

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
    { schema: MarketplacePluginListViewSchema, options: authHook },
    async (request, reply) => {
      try {
        const { search, tags, categories, transport } =
          marketplaceListQuerySchema.parse(request.query || {})
        const records = await listPluginRecords({
          search,
          transport,
          tags,
          categorySlugs: categories,
        })
        return records.map(presentMarketplacePlugin)
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
    { schema: PluginCategoryListViewSchema, options: authHook },
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
        return presentMarketplacePlugin(await getPluginRecord(pluginId))
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
    { schema: MarketplacePublisherListViewSchema, options: authHook },
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
      schema: MarketplacePublisherDetailViewSchema,
      options: authHook,
    },
    async (request, reply) => {
      try {
        const { orgId } = request.params as { orgId: string }
        const org = await getOrganization(orgId)
        if (!org) {
          throw new McpPluginError(404, "Publisher not found")
        }
        const plugins = await listPluginRecords({ orgId })
        return {
          ...presentPublisher(org),
          plugins: plugins.map(presentMarketplacePlugin),
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
      schema: PluginInstallationListViewSchema,
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
        const { pluginId } = installationListQuerySchema.parse(
          request.query || {}
        )
        const installations = await getInstallations(workspaceId, {
          installationIds,
          pluginId,
        })
        return installations.map(presentPluginInstallationDetail)
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
        return presentPluginInstallationDetail(
          await getInstallation(workspaceId, installId)
        )
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
          toolCallAuditLogListQuerySchema.parse(request.query || {})
        return await getToolCallLogs(workspaceId, {
          pluginId,
          sessionId,
          actorId,
          limit,
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
        const { eventType, pluginId, limit, before } =
          eventAuditLogListQuerySchema.parse(request.query || {})
        return await getEventLogs(workspaceId, {
          eventType,
          pluginId,
          limit,
          before,
        })
      } catch (error) {
        handleError(reply, error)
        return undefined
      }
    }
  )
}
