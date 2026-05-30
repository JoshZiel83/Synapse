import type { FastifyInstance } from "fastify"
import { db } from "../../infrastructure/database/kysely.js"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { requireRequestAction } from "../access/guards.js"
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
      let countQuery = db
        .selectFrom("audit_logs as al")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("al.workspace_id", "=", workspaceId)
      let dataQuery = db
        .selectFrom("audit_logs as al")
        .leftJoin("users as u", "u.id", "al.user_id")
        .leftJoin("actors as a", "a.id", "al.actor_id")
        .select([
          "al.id",
          "al.action",
          "al.resource_type as resourceType",
          "al.resource_id as resourceId",
          "al.user_id as userId",
          "al.actor_id as actorId",
          "al.details",
          "al.ip_address as ipAddress",
          "al.created_at as createdAt",
          "u.email as userName",
          "a.name as actorName",
        ])
        .where("al.workspace_id", "=", workspaceId)

      if (qs.action) {
        countQuery = countQuery.where("al.action", "=", qs.action)
        dataQuery = dataQuery.where("al.action", "=", qs.action)
      }
      if (qs.resourceType) {
        countQuery = countQuery.where("al.resource_type", "=", qs.resourceType)
        dataQuery = dataQuery.where("al.resource_type", "=", qs.resourceType)
      }
      if (qs.resourceId) {
        countQuery = countQuery.where("al.resource_id", "=", qs.resourceId)
        dataQuery = dataQuery.where("al.resource_id", "=", qs.resourceId)
      }

      const [countResult, items] = await Promise.all([
        countQuery.executeTakeFirst(),
        dataQuery
          .orderBy("al.created_at", "desc")
          .limit(qs.pageSize)
          .offset(offset)
          .execute(),
      ])

      return {
        items,
        total: parseInt(countResult?.count || "0", 10),
        page: qs.page,
        pageSize: qs.pageSize,
      }
    }
  )
}
