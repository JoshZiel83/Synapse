import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteShorthandOptions,
} from "fastify"
import type { z } from "zod"
import { sendData } from "./respond.js"

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH"

/**
 * Route-surface markers (docs/architecture-boundary-refactor-master-plan.md
 * §5.3 mechanism B). They make a route's surface explicit at the registration
 * site so `guard-layering.mjs` can enforce the envelope contract without a
 * per-endpoint string whitelist:
 *
 *   - `appRoute`  → app-facing. The handler returns a domain value; the helper
 *     wraps it through `sendData(reply, schema, value)` → `{ data }`. Handlers
 *     that own a no-content write may `reply.status(204).send()` and return
 *     `undefined` (the helper then does nothing further).
 *   - `wireRoute` → machine/wire-facing. The handler sends a bare payload
 *     itself; the helper never wraps in `{ data }`.
 *
 * Mixed modules (Tier C) must use these (or split `*.app.ts` / `*.wire.ts`
 * controllers) instead of bare `app.get/post(...)`.
 */

function register(
  app: FastifyInstance,
  method: HttpMethod,
  path: string,
  opts: RouteShorthandOptions,
  handler: (request: FastifyRequest, reply: FastifyReply) => unknown
): void {
  const fn = {
    GET: app.get,
    POST: app.post,
    PUT: app.put,
    DELETE: app.delete,
    PATCH: app.patch,
  }[method].bind(app)
  fn(path, opts, handler as never)
}

export function appRoute<S extends z.ZodType>(
  app: FastifyInstance,
  method: HttpMethod,
  path: string,
  config: { schema: S; options?: RouteShorthandOptions },
  handler: (
    request: FastifyRequest,
    reply: FastifyReply
  ) => Promise<z.input<S> | undefined> | z.input<S> | undefined
): void {
  register(app, method, path, config.options ?? {}, async (request, reply) => {
    const value = await handler(request, reply)
    // No-content / already-sent (e.g. 204 write, redirect) → don't double-send.
    if (value === undefined || reply.sent) return reply
    // Respect a status the handler set before returning (e.g. reply.status(201)
    // for a create) — sendData defaults to 200 and would otherwise clobber it.
    const status =
      reply.statusCode && reply.statusCode !== 200 ? reply.statusCode : 200
    return sendData(reply, config.schema, value, status)
  })
}

export function wireRoute(
  app: FastifyInstance,
  method: HttpMethod,
  path: string,
  config: { options?: RouteShorthandOptions },
  handler: (request: FastifyRequest, reply: FastifyReply) => unknown
): void {
  register(app, method, path, config.options ?? {}, handler)
}
