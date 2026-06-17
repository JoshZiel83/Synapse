import type { FastifyRequest, FastifyReply } from "fastify"
import { requireRequestAction } from "../../modules/access/guards.js"
import { findActiveWorkspaceMemberForMiddleware } from "./repo.js"

export async function workspaceMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const workspaceId = (request.params as any).workspaceId
  if (!workspaceId) {
    return reply.status(400).send({ error: "Workspace ID is required" })
  }

  const user = (request as any).user
  if (!user) {
    return reply.status(401).send({ error: "Authentication required" })
  }

  const member = await findActiveWorkspaceMemberForMiddleware({
    workspaceId,
    userId: user.userId,
  })

  ;(request as any).workspaceMember = member ?? null

  const allowed = await requireRequestAction(
    request,
    reply,
    "workspace.view",
    workspaceId,
    "Not allowed to access this workspace"
  )
  if (!allowed) {
    return
  }
}
