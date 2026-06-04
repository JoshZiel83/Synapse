import { Buffer } from "node:buffer"
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify"
import { fromNodeHeaders } from "better-auth/node"
import { z } from "zod"
import { auth } from "./better-auth.js"
import { getProfile, updateProfile, AuthError } from "./service.js"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"

const updateMeSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    avatarFileId: z.uuid().nullable().optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.avatarFileId !== undefined,
    {
      message: "At least one field is required",
    }
  )

function handleAuthError(error: unknown, reply: FastifyReply) {
  if (error instanceof AuthError) {
    return reply
      .status(error.statusCode)
      .send({ error: error.message, code: error.code })
  }
  if (error instanceof z.ZodError) {
    return reply.status(400).send({
      error: "Validation failed",
      code: "VALIDATION_ERROR",
      details: error.issues.map((item) => ({
        field: item.path.join("."),
        message: item.message,
      })),
    })
  }
  throw error
}

/**
 * Bridge a Fastify request/reply to Better Auth's Web `auth.handler(Request)`.
 *
 * We deliberately do NOT use better-auth/node's `toNodeHandler` because the app
 * installs a custom application/json content-type parser that consumes the body
 * into `request.rawBody`; handing the raw Node stream to toNodeHandler would
 * double-read it. Instead we reconstruct a Web `Request` from the already-parsed
 * raw body and copy the Response (status + every Set-Cookie + body) back.
 */
async function handleWithBetterAuth(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const url = new URL(
    request.url,
    `${request.protocol}://${request.headers.host ?? "localhost"}`
  )

  const method = request.method.toUpperCase()
  const hasBody = method !== "GET" && method !== "HEAD"
  let body: string | undefined
  if (hasBody) {
    const raw = (request as { rawBody?: string }).rawBody
    if (typeof raw === "string" && raw.length > 0) {
      body = raw
    } else if (request.body !== undefined && request.body !== null) {
      // Defensive fallback for non-JSON content types: the JSON parser stores
      // rawBody, but reconstruct from the parsed body otherwise.
      body =
        typeof request.body === "string"
          ? request.body
          : JSON.stringify(request.body)
    }
  }

  const webRequest = new Request(url.toString(), {
    method,
    headers: fromNodeHeaders(request.headers),
    body,
  })

  const response = await auth.handler(webRequest)

  reply.status(response.status)
  // Copy headers, preserving MULTIPLE Set-Cookie headers (getSetCookie()).
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return
    reply.header(key, value)
  })
  const setCookies = response.headers.getSetCookie?.() ?? []
  for (const cookie of setCookies) {
    reply.header("set-cookie", cookie)
  }

  const arrayBuffer = await response.arrayBuffer()
  return reply.send(Buffer.from(arrayBuffer))
}

const authModule: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Custom profile endpoints. Registered BEFORE the Better Auth wildcard so the
  // explicit paths win; they preserve the legacy `{ user, session }` response
  // shape the web/mobile clients (and the proxy guard) still expect from /me.
  app.get(
    "/api/v1/auth/me",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return reply.status(200).send({
          user: await getProfile((request as any).user.userId),
          session: (request as any).authSession,
        })
      } catch (error) {
        return handleAuthError(error, reply)
      }
    }
  )

  app.put(
    "/api/v1/auth/me",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = updateMeSchema.parse(request.body)
        return reply.status(200).send({
          user: await updateProfile((request as any).user.userId, {
            name: body.name,
            avatarFileId: body.avatarFileId,
          }),
          session: (request as any).authSession,
        })
      } catch (error) {
        return handleAuthError(error, reply)
      }
    }
  )

  // Everything else under /api/v1/auth/* is handled by Better Auth itself
  // (sign-up/sign-in/sign-out/get-session/list-sessions/revoke-session,
  // oauth2/*, device/*, the device-session-cookie bridge, ...).
  app.all("/api/v1/auth/*", async (request, reply) => {
    return handleWithBetterAuth(request, reply)
  })
}

export default authModule
