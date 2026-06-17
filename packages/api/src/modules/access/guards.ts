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
import {
  authorizeAction,
  getRequestAccessSubject,
  listAuthorizedResourceIds,
  resolveWorkspaceAccessSubject,
} from "./service.js"
import { upsertAccessSubject } from "./subject-registry.js"
import { createGeneratedActorPixelArtAvatarFile } from "../avatar/service.js"
import type { PixelArtAvatarOptionsInput } from "../avatar/service.js"
import type { SubjectRef } from "@synapse/shared"
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

// Default-db-bound authz helpers for controllers (round-6 P1-6): a controller
// must not import the DB client just to thread it into the access engine. These
// bind the runtime default db (same edge-binding pattern as requireRequestAction
// above) so controllers call them with just `params`; the underlying
// authorizeAction / listAuthorizedResourceIds stay db-injectable for tests.
export function authorizeActionDefault(
  params: Parameters<typeof authorizeAction>[1]
): ReturnType<typeof authorizeAction> {
  return authorizeAction(defaultDb, params)
}

export function listAuthorizedResourceIdsDefault(
  params: Parameters<typeof listAuthorizedResourceIds>[1]
): ReturnType<typeof listAuthorizedResourceIds> {
  return listAuthorizedResourceIds(defaultDb, params)
}

export function resolveWorkspaceAccessSubjectDefault(
  workspaceId: string,
  userId: string
): ReturnType<typeof resolveWorkspaceAccessSubject> {
  return resolveWorkspaceAccessSubject(defaultDb, workspaceId, userId)
}

export function upsertAccessSubjectDefault(
  ref: SubjectRef
): ReturnType<typeof upsertAccessSubject> {
  return upsertAccessSubject(defaultDb, ref)
}

// Default-db binder for the avatar generator (round-6 P1-6): orchestrator/service.ts
// only imported the db client to thread it into this avatar-module function. The
// function stays executor-injectable for tests; the binder lives here (an
// allowlisted edge) so the orchestrator drops its db-client import.
export function createGeneratedActorPixelArtAvatarFileDefault(params: {
  workspaceId: string
  actorId: string
  actorDisplayName: string
  actorTitle: string
  uploaderUserId?: string | null
  options?: PixelArtAvatarOptionsInput
}): ReturnType<typeof createGeneratedActorPixelArtAvatarFile> {
  return createGeneratedActorPixelArtAvatarFile(defaultDb, params)
}
