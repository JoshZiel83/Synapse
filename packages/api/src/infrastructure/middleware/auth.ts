import type { FastifyReply, FastifyRequest } from "fastify"
import { authenticateRequestSession } from "../../modules/auth/service.js"

async function attachAuthenticatedRequest(request: FastifyRequest) {
  const authenticated = await authenticateRequestSession(request)
  if (!authenticated) return null
  ;(request as any).user = {
    userId: authenticated.user.id,
    email: authenticated.user.email,
  }
  ;(request as any).authSession = authenticated.session

  return authenticated
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const authenticated = await attachAuthenticatedRequest(request)
  if (authenticated) return

  // Note: we no longer clear a cookie by name here. Better Auth's session
  // cookie carries an environment-dependent `__Secure-` prefix in production,
  // so business code must not assume a fixed cookie name; an unauthenticated
  // request simply gets a 401 and the client re-authenticates.
  return reply.status(401).send({
    error: "Authentication required",
    code: "UNAUTHENTICATED",
  })
}

export async function optionalAuth(request: FastifyRequest) {
  await attachAuthenticatedRequest(request)
}

export function getUserId(request: FastifyRequest): string {
  return (request as any).user?.userId
}
