/**
 * WhatsApp (unofficial / Baileys) REST endpoints (mounted as a Fastify plugin
 * from controller.ts).
 *
 * Owns the bespoke flows that the generic account CRUD cannot express:
 *   - QR / pairing-code login sessions (start → poll status → linked), mirroring
 *     weixin's QR controller but driven by a transient Baileys socket.
 *   - An OPERATOR kill-switch toggle for the session-guard pause flag (a manual
 *     stop for a protocol break — see plan §4.5).
 *
 * All zod schemas are LOCAL (the shared `schemas/im.ts` is intentionally not
 * edited). Schemas are kept permissive on output and strict on input.
 */

import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { appRoute } from "../../../infrastructure/http/route.js"
import { getTransportAccountById } from "../service.js"
import {
  requireWorkspaceAction,
  whatsappUnofficialLoginStartSchema,
} from "./_shared.js"
import {
  cancelWhatsappLoginSession,
  getWhatsappLoginSession,
  startWhatsappLoginSession,
} from "../connectors/whatsapp_unofficial/login-qr.js"
import {
  clearSessionPause,
  getSessionPause,
  pauseSessionOperator,
} from "../connectors/whatsapp_unofficial/session-guard.js"

// ───────────────────────── local schemas ─────────────────────────
// The login-START request schema is single-sourced in @synapse/shared
// (consumed via the _shared.js alias). The login-session + session-guard
// RESPONSE schemas stay local: they carry epoch-ms expiresAt / runtime
// kill-switch state, which would clash with shared/im.ts's ISO convention.

const loginSessionResponseSchema = z.object({
  session: z.object({
    sessionId: z.string(),
    status: z.string(),
    qrDataUrl: z.string().optional(),
    pairingCode: z.string().optional(),
    transportAccountId: z.string().optional(),
    errorMessage: z.string().optional(),
    expiresAt: z.number(),
  }),
})

const operatorPauseInputSchema = z
  .object({
    accountId: z.string().uuid(),
    /** true = engage the kill-switch; false = clear it. */
    paused: z.boolean(),
    /** optional override for the operator-pause TTL (seconds). */
    ttlSeconds: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60 * 60)
      .optional(),
  })
  .strict()

const operatorPauseResponseSchema = z.object({
  accountId: z.string(),
  paused: z.boolean(),
  reason: z.string().nullable(),
  remainingMs: z.number(),
})

function presentSession(session: {
  sessionId: string
  status: string
  qrDataUrl?: string
  pairingCode?: string
  transportAccountId?: string
  errorMessage?: string
  expiresAt: number
}): z.infer<typeof loginSessionResponseSchema> {
  return {
    session: {
      sessionId: session.sessionId,
      status: session.status,
      ...(session.qrDataUrl ? { qrDataUrl: session.qrDataUrl } : {}),
      ...(session.pairingCode ? { pairingCode: session.pairingCode } : {}),
      ...(session.transportAccountId
        ? { transportAccountId: session.transportAccountId }
        : {}),
      ...(session.errorMessage ? { errorMessage: session.errorMessage } : {}),
      expiresAt: session.expiresAt,
    },
  }
}

export default async function imWhatsappUnofficialController(
  app: FastifyInstance
): Promise<void> {
  // -------- Start a login session (QR or pairing-code) --------
  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/im/accounts/whatsapp_unofficial/login",
    { schema: loginSessionResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return

      const { workspaceId } = request.params as { workspaceId: string }
      const body = whatsappUnofficialLoginStartSchema.parse(request.body ?? {})
      const session = await startWhatsappLoginSession({
        workspaceId,
        displayName: body.displayName,
        phoneNumberE164: body.phoneNumberE164,
        ownerScope: body.ownerScope,
        ownerWorkspaceMemberId: body.ownerWorkspaceMemberId ?? null,
        inboundActorMode: body.inboundActorMode,
        inboundActorId: body.inboundActorId ?? null,
      })
      reply.status(201)
      return presentSession(session)
    }
  )

  // -------- Poll a login session's status --------
  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/im/accounts/whatsapp_unofficial/login/:sessionId",
    { schema: loginSessionResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return

      const { workspaceId, sessionId } = request.params as {
        workspaceId: string
        sessionId: string
      }
      const session = await getWhatsappLoginSession({ workspaceId, sessionId })
      if (!session) {
        reply.status(404).send({ error: "WhatsApp login session not found" })
        return
      }
      return presentSession(session)
    }
  )

  // -------- Cancel a login session --------
  appRoute(
    app,
    "DELETE",
    "/api/v1/workspaces/:workspaceId/im/accounts/whatsapp_unofficial/login/:sessionId",
    { schema: z.object({ ok: z.boolean() }) },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return

      const { workspaceId, sessionId } = request.params as {
        workspaceId: string
        sessionId: string
      }
      await cancelWhatsappLoginSession({ workspaceId, sessionId })
      return { ok: true }
    }
  )

  // -------- Operator kill-switch (session-guard pause toggle) --------
  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/im/accounts/whatsapp_unofficial/session-guard",
    { schema: operatorPauseResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return

      const { workspaceId } = request.params as { workspaceId: string }
      const body = operatorPauseInputSchema.parse(request.body)

      // The pause flag is keyed by accountId alone (no workspace component), so
      // we MUST verify the account belongs to THIS workspace before toggling —
      // otherwise workspace.manage on workspace A could pause/unpause any
      // account in workspace B (cross-workspace IDOR/DoS). getTransportAccountById
      // is workspace-agnostic, so the explicit workspace + kind check is required.
      const acct = await getTransportAccountById(body.accountId)
      if (
        !acct ||
        acct.workspaceId !== workspaceId ||
        acct.transportKind !== "whatsapp_unofficial"
      ) {
        reply.status(404).send({ error: "account not found" })
        return
      }

      if (body.paused) {
        await pauseSessionOperator(body.accountId, body.ttlSeconds)
      } else {
        await clearSessionPause(body.accountId)
      }
      const pause = await getSessionPause(body.accountId)
      return {
        accountId: body.accountId,
        paused: pause != null,
        reason: pause?.reason ?? null,
        remainingMs: pause?.remainingMs ?? 0,
      }
    }
  )
}
