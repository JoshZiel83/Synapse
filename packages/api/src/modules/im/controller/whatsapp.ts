/**
 * WhatsApp Cloud API REST endpoints (mounted as a Fastify plugin from
 * controller.ts).
 *
 * Provides a TYPED create/update route that takes the discrete Cloud-API
 * credential fields (phoneNumberId, wabaId, accessToken, appSecret, appId,
 * webhookVerifyToken, graphApiVersion) and assembles the generic
 * credentials JSON for the shared account service. The generic
 * POST /im/accounts route also works (open `credentials` record) — this is
 * the typed-credentials polish (mirrors controller/wecom.ts).
 *
 * Zod schemas are defined LOCALLY here (this connector lives in its own
 * isolation boundary and must not edit shared/schemas/im.ts). connectionMode
 * is fixed to "webhook" (Cloud API is webhook-only).
 *
 * The webhook POST (events) + GET (hub.challenge verify) routes live in the
 * shared `public-controller.ts`, NOT here. A live phoneNumberId probe would
 * live here (validators are sync) — omitted in v1 (the probe needs Meta
 * business verification complete first; see OD-NEW-E).
 */

import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { TransportAccountResponseSchema } from "@synapse/shared/schemas"
import { appRoute } from "../../../infrastructure/http/route.js"
import { createTransportAccount, updateTransportAccount } from "../service.js"
import {
  refreshTransportRuntimeState,
  requireWorkspaceAction,
} from "./_shared.js"

// ── Local zod schemas (never edit shared/schemas/im.ts from this boundary) ──

const ownerScopeSchema = z.enum(["workspace", "workspace_member"]).optional()

const createSchema = z.object({
  displayName: z.string().trim().min(1).max(255),
  accountKey: z.string().trim().min(1).max(120).optional(),
  // Cloud API is webhook-only.
  connectionMode: z.literal("webhook").default("webhook"),
  phoneNumberId: z.string().trim().min(1).max(255),
  wabaId: z.string().trim().min(1).max(255),
  accessToken: z.string().trim().min(1).max(4096),
  appSecret: z.string().trim().min(1).max(512),
  appId: z.string().trim().min(1).max(255),
  webhookVerifyToken: z.string().trim().min(1).max(512),
  graphApiVersion: z.string().trim().min(2).max(16).optional(),
  status: z.enum(["active", "disabled", "error"]).optional(),
  ownerScope: ownerScopeSchema,
  ownerWorkspaceMemberId: z.string().trim().min(1).nullable().optional(),
})

const updateSchema = z.object({
  displayName: z.string().trim().min(1).max(255).optional(),
  phoneNumberId: z.string().trim().min(1).max(255).optional(),
  wabaId: z.string().trim().min(1).max(255).optional(),
  accessToken: z.string().trim().min(1).max(4096).optional(),
  appSecret: z.string().trim().min(1).max(512).optional(),
  appId: z.string().trim().min(1).max(255).optional(),
  webhookVerifyToken: z.string().trim().min(1).max(512).optional(),
  graphApiVersion: z.string().trim().min(2).max(16).optional(),
  status: z.enum(["active", "disabled", "error"]).optional(),
  ownerScope: ownerScopeSchema,
  ownerWorkspaceMemberId: z.string().trim().min(1).nullable().optional(),
})

export default async function imWhatsappController(
  app: FastifyInstance
): Promise<void> {
  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/im/accounts/whatsapp",
    { schema: TransportAccountResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return

      const { workspaceId } = request.params as { workspaceId: string }
      const body = createSchema.parse(request.body)

      const credentials: Record<string, unknown> = {
        phoneNumberId: body.phoneNumberId,
        wabaId: body.wabaId,
        accessToken: body.accessToken,
        appSecret: body.appSecret,
        appId: body.appId,
        webhookVerifyToken: body.webhookVerifyToken,
        ...(body.graphApiVersion
          ? { graphApiVersion: body.graphApiVersion }
          : {}),
      }

      const account = await createTransportAccount({
        workspaceId,
        transportKind: "whatsapp",
        accountKey: body.accountKey || body.phoneNumberId,
        displayName: body.displayName,
        ...(body.ownerScope ? { ownerScope: body.ownerScope } : {}),
        ownerWorkspaceMemberId: body.ownerWorkspaceMemberId ?? null,
        connectionMode: "webhook",
        ...(body.status ? { status: body.status } : {}),
        credentials,
      })
      await refreshTransportRuntimeState()
      reply.status(201)
      return { account }
    }
  )

  appRoute(
    app,
    "PUT",
    "/api/v1/workspaces/:workspaceId/im/accounts/whatsapp/:accountId",
    { schema: TransportAccountResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return

      const { workspaceId, accountId } = request.params as {
        workspaceId: string
        accountId: string
      }
      const body = updateSchema.parse(request.body)

      // Only include credentials if at least one field was supplied —
      // otherwise the service treats the JSONB column as a TOTAL replacement
      // and would wipe stored values (the wecom precedent). NOTE: the
      // generic validateCredentials requires the FULL bundle, so a partial
      // credential update through this route can fail validation — callers
      // updating credentials should send the complete set. Kept partial here
      // to allow non-credential updates (displayName/status/owner) without
      // re-sending secrets.
      const credEntries = {
        ...(body.phoneNumberId ? { phoneNumberId: body.phoneNumberId } : {}),
        ...(body.wabaId ? { wabaId: body.wabaId } : {}),
        ...(body.accessToken ? { accessToken: body.accessToken } : {}),
        ...(body.appSecret ? { appSecret: body.appSecret } : {}),
        ...(body.appId ? { appId: body.appId } : {}),
        ...(body.webhookVerifyToken
          ? { webhookVerifyToken: body.webhookVerifyToken }
          : {}),
        ...(body.graphApiVersion
          ? { graphApiVersion: body.graphApiVersion }
          : {}),
      }
      const credentials =
        Object.keys(credEntries).length > 0 ? credEntries : undefined

      const account = await updateTransportAccount({
        workspaceId,
        accountId,
        expectedTransportKind: "whatsapp",
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.ownerScope ? { ownerScope: body.ownerScope } : {}),
        ...(body.ownerWorkspaceMemberId !== undefined
          ? { ownerWorkspaceMemberId: body.ownerWorkspaceMemberId }
          : {}),
        ...(body.status ? { status: body.status } : {}),
        ...(credentials ? { credentials } : {}),
      })
      await refreshTransportRuntimeState()
      return { account }
    }
  )
}
