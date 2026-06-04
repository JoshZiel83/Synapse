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
import { resolveOAuthErrorRedirect } from "./oauth-error-routing.js"
import { getProfile, updateProfile, AuthError } from "./service.js"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { db } from "../../infrastructure/database/kysely.js"

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
// Matches Better Auth's generic-OAuth callback: GET /api/v1/auth/oauth2/callback/:providerId
const OAUTH_CALLBACK_RE = /\/api\/v1\/auth\/oauth2\/callback\/[^/]+\/?$/

/**
 * Whether a request is an OAuth callback EARLY error we should intercept before
 * Better Auth: a GET to the callback path that carries `?error=` or has no
 * `?code=`. The happy path (a code, no error) returns false so Better Auth runs.
 * Exported for wiring tests.
 */
export function isOAuthCallbackEarlyError(
  method: string,
  pathname: string,
  searchParams: URLSearchParams
): boolean {
  if (method.toUpperCase() !== "GET") return false
  if (!OAUTH_CALLBACK_RE.test(pathname)) return false
  if (!searchParams.has("error") && searchParams.has("code")) return false
  return true
}

/**
 * Intercept OAuth callback EARLY errors (provider cancelled / no code) before
 * delegating to Better Auth, and route them to the right platform target (see
 * resolveOAuthErrorRedirect). Returns true if it handled the request.
 *
 * Wrapped so any failure falls through to the normal Better Auth handler rather
 * than 500-ing the callback.
 */
async function tryHandleOAuthCallbackError(
  request: FastifyRequest,
  reply: FastifyReply,
  url: URL
): Promise<boolean> {
  try {
    if (
      !isOAuthCallbackEarlyError(request.method, url.pathname, url.searchParams)
    ) {
      return false
    }

    const state = url.searchParams.get("state") ?? undefined
    // Better Auth's signed state cookie (prod gets the __Secure- prefix).
    const cookies = (request as { cookies?: Record<string, string> }).cookies
    const stateCookieValue =
      cookies?.["__Secure-better-auth.state"] ?? cookies?.["better-auth.state"]

    const { target, consumed } = await resolveOAuthErrorRedirect({
      executor: db,
      state,
      stateCookieValue,
      errorCode: url.searchParams.get("error") ?? undefined,
    })

    if (consumed && state) {
      // Early errors never reach Better Auth's own state consumption; clean up.
      await db
        .deleteFrom("verification")
        .where("identifier", "=", state)
        .execute()
        .catch(() => {})
    }

    reply.status(302).header("location", target)
    await reply.send("")
    return true
  } catch {
    return false
  }
}

async function handleWithBetterAuth(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const url = new URL(
    request.url,
    `${request.protocol}://${request.headers.host ?? "localhost"}`
  )

  // Cross-platform OAuth early-error routing must run before Better Auth, which
  // would otherwise send every early error to the single global errorURL.
  if (await tryHandleOAuthCallbackError(request, reply, url)) return

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
