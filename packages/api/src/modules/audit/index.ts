import type { FastifyInstance } from "fastify"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { requireRequestAction } from "../access/guards.js"
import { countWorkspaceAuditLogs, listWorkspaceAuditLogs } from "./repo.js"
import { z } from "zod"

const querySchema = z.object({
  workspaceId: z.uuid().optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.uuid().optional(),
  page: z.coerce.number().default(1),
  pageSize: z.coerce.number().default(50),
})

export default async function auditModule(app: FastifyInstance) {
  // List audit logs for a workspace
  app.get(
    "/api/v1/workspaces/:workspaceId/audit-logs",
    {
      preHandler: [authMiddleware, workspaceMiddleware],
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

      const qs = querySchema.parse(request.query)

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

      return {
        items,
        total,
        page: qs.page,
        pageSize: qs.pageSize,
      }
    }
  )
}
