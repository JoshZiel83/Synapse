import type { FastifyRequest, FastifyReply, FastifyInstance } from "fastify"
import { createLogger } from "../logger/index.js"
import { insertMiddlewareAuditLog } from "./repo.js"

const log = createLogger("audit")

// High-volume, unauthenticated telemetry-ingest endpoints that must NOT write an
// audit row per request — otherwise a browser-report flood (POST /api/v1/reports
// is unauthenticated by design) amplifies into unbounded audit-table writes.
const AUDIT_EXCLUDED_PATHS: ReadonlySet<string> = new Set(["/api/v1/reports"])

export function auditMiddleware(app: FastifyInstance) {
  app.addHook(
    "onResponse",
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Only audit mutating requests
      if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return

      // Skip telemetry-ingest endpoints (strip any query string first).
      if (AUDIT_EXCLUDED_PATHS.has(request.url.split("?")[0])) return

      const action = deriveAction(request.method, request.url)
      if (!action) return

      try {
        await insertMiddlewareAuditLog({
          workspaceId: (request.params as any)?.workspaceId || null,
          userId: (request as any).user?.userId || null,
          action,
          resourceType: deriveResourceType(request.url),
          resourceId: (request.params as any)?.id || null,
          details: {
            method: request.method,
            url: request.url,
            statusCode: reply.statusCode,
          },
          ipAddress: request.ip,
        })
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
