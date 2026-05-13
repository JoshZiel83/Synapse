import type { FastifyReply, FastifyRequest } from "fastify"
import {
  authorizeAction,
  getRequestAccessSubject,
  type AccessSubject,
} from "./service.js"
import type { AccessAction } from "./actions.js"

export async function requireSubjectAction(
  subject: AccessSubject,
  action: AccessAction,
  resourceId: string
) {
  return authorizeAction({
    subject,
    action,
    resourceId,
  })
}

export async function requireRequestAction(
  request: FastifyRequest,
  reply: FastifyReply,
  action: AccessAction,
  resourceId: string,
  errorMessage = "Forbidden"
) {
  const allowed = await requireSubjectAction(
    getRequestAccessSubject(request),
    action,
    resourceId
  )

  if (!allowed) {
    reply.status(403).send({ error: errorMessage })
    return false
  }

  return true
}

export async function requireRequestParamAction(
  request: FastifyRequest,
  reply: FastifyReply,
  action: AccessAction,
  paramKey: string,
  errorMessage = "Forbidden"
) {
  const resourceId = String((request.params as any)?.[paramKey] || "")
  if (!resourceId) {
    reply.status(400).send({ error: `${paramKey} is required` })
    return false
  }

  return requireRequestAction(request, reply, action, resourceId, errorMessage)
}
