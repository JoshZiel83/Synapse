/**
 * Fastify guard for authorize-by-action checks. The factory variant
 * (`createRequireRequestAction(db)`) takes an explicit Kysely instance so
 * tests can run against a per-test DB without touching the global. The
 * default export (`requireRequestAction`) is bound to the runtime default
 * `db` and is what request handlers use.
 *
 * This satisfies the P0 "access module is db-injectable" rule (the underlying
 * `authorizeAction` accepts `db` explicitly) while keeping the 66 existing
 * Fastify call sites unchanged.
 */

import type { FastifyReply, FastifyRequest } from "fastify"
import { db as defaultDb } from "../../infrastructure/database/kysely.js"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import { authorizeAction, getRequestAccessSubject } from "./service.js"
import type { AccessAction } from "./actions.js"

export function createRequireRequestAction(db: KyselyDb) {
  return async function requireRequestAction(
    request: FastifyRequest,
    reply: FastifyReply,
    action: AccessAction,
    resourceId: string,
    errorMessage = "Forbidden"
  ) {
    const allowed = await authorizeAction(db, {
      subject: getRequestAccessSubject(request),
      action,
      resourceId,
    })

    if (!allowed) {
      reply.status(403).send({ error: errorMessage })
      return false
    }

    return true
  }
}

export const requireRequestAction = createRequireRequestAction(defaultDb)
