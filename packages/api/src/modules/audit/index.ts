import type { FastifyInstance } from "fastify"
import {
  AuditLogListQuerySchema,
  AuditLogListViewSchema,
} from "@synapse/shared/schemas"
import { appRoute } from "../../infrastructure/http/route.js"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { requireRequestAction } from "../access/guards.js"
import { presentAuditLogList } from "./presenter.js"
import { countWorkspaceAuditLogs, listWorkspaceAuditLogs } from "./repo.js"

export default async function auditModule(app: FastifyInstance) {
  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/audit-logs",
    {
      schema: AuditLogListViewSchema,
      options: { preHandler: [authMiddleware, workspaceMiddleware] },
    },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to view audit logs in this workspace"
      )
      if (!allowed) return

      const qs = AuditLogListQuerySchema.parse(request.query)

      const offset = (qs.page - 1) * qs.pageSize
      const filters = {
        action: qs.action,
        resourceType: qs.resourceType,
        resourceId: qs.resourceId,
      }

      const [total, items] = await Promise.all([
        countWorkspaceAuditLogs(workspaceId, filters),
        listWorkspaceAuditLogs(workspaceId, filters, qs.pageSize, offset),
      ])

      return presentAuditLogList({
        items,
        total,
        page: qs.page,
        pageSize: qs.pageSize,
      })
    }
  )
}
