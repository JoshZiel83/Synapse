import type { FastifyRequest, FastifyReply, FastifyInstance } from "fastify"
import { db, type TableInsert } from "../database/kysely.js"
import { createLogger } from "../logger/index.js"

const log = createLogger("audit")

export function auditMiddleware(app: FastifyInstance) {
  app.addHook(
    "onResponse",
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Only audit mutating requests
      if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return

      const action = deriveAction(request.method, request.url)
      if (!action) return

      try {
        await db
          .insertInto("auditLogs")
          .values({
            workspaceId: (request.params as any)?.workspaceId || null,
            userId: (request as any).user?.userId || null,
            action,
            resourceType: deriveResourceType(request.url),
            resourceId: (request.params as any)?.id || null,
            details: {
              method: request.method,
              url: request.url,
              statusCode: reply.statusCode,
            } as TableInsert<"auditLogs">["details"],
            ipAddress: request.ip,
          })
          .execute()
      } catch (err) {
        log.error({ err }, "Audit log insert failed")
      }
    }
  )
}

function deriveAction(method: string, url: string): string | null {
  const segments = url.split("/").filter(Boolean)
  const resource = segments.find(
    (s) => !s.match(/^[0-9a-f-]{36}$/i) && s !== "api" && s !== "v1"
  )
  if (!resource) return null

  const actionMap: Record<string, string> = {
    POST: "create",
    PUT: "update",
    PATCH: "update",
    DELETE: "delete",
  }

  return `${resource}.${actionMap[method] || method.toLowerCase()}`
}

function deriveResourceType(url: string): string {
  const segments = url.split("/").filter(Boolean)
  return (
    segments.find(
      (s) => !s.match(/^[0-9a-f-]{36}$/i) && s !== "api" && s !== "v1"
    ) || "unknown"
  )
}
