/**
 * WeCom-specific REST endpoints.
 *
 * Mounted as a Fastify plugin from controller.ts. Owns the
 * POST/PUT /im/accounts/wecom routes that take WeCom AI-Bot credentials
 * (botId + secret) and optional config (baseWsUrl) as discrete fields and
 * assemble the generic credentials/config JSON for the shared account service.
 *
 * v1 connectionMode is fixed to `long_connection` (smart-bot WSS).
 */

import type { FastifyInstance } from "fastify"
import { TransportAccountResponseSchema } from "@synapse/shared/schemas"
import { appRoute } from "../../../infrastructure/http/route.js"
import { sendData } from "../../../infrastructure/http/respond.js"
import { createTransportAccount, updateTransportAccount } from "../service.js"
import {
  refreshTransportRuntimeState,
  requireWorkspaceAction,
  updateWecomAccountSchema,
  wecomAccountSchema,
} from "./_shared.js"

export default async function imWecomController(
  app: FastifyInstance
): Promise<void> {
  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/im/accounts/wecom",
    { schema: TransportAccountResponseSchema },
    async (request, reply): Promise<undefined> => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return

      const { workspaceId } = request.params as { workspaceId: string }
      const body = wecomAccountSchema.parse(request.body)
      const credentials: Record<string, unknown> = {
        botId: body.botId,
        secret: body.secret,
      }
      const config: Record<string, unknown> | undefined = body.baseWsUrl
        ? { baseWsUrl: body.baseWsUrl }
        : undefined

      const account = await createTransportAccount({
        workspaceId,
        transportKind: "wecom",
        accountKey: body.accountKey || body.botId,
        displayName: body.displayName,
        ownerScope: body.ownerScope,
        ownerWorkspaceMemberId: body.ownerWorkspaceMemberId ?? null,
        connectionMode: body.connectionMode,
        status: body.status,
        inboundActorMode: body.inboundActorMode,
        inboundActorId:
          body.inboundActorId === null ? null : body.inboundActorId,
        credentials,
        config,
      })
      await refreshTransportRuntimeState()
      sendData(reply, TransportAccountResponseSchema, { account }, 201)
      return
    }
  )

  appRoute(
    app,
    "PUT",
    "/api/v1/workspaces/:workspaceId/im/accounts/wecom/:accountId",
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
      const body = updateWecomAccountSchema.parse(request.body)
      // Only include credentials if at least one of the two fields was
      // supplied — otherwise the service treats the JSONB column as a
      // total replacement and would wipe a previously stored value.
      const credentials =
        body.botId || body.secret
          ? {
              ...(body.botId ? { botId: body.botId } : {}),
              ...(body.secret ? { secret: body.secret } : {}),
            }
          : undefined
      // Three-way semantics for baseWsUrl on the wire:
      //   undefined → don't touch the existing config JSONB
      //   null      → explicit "clear" — write {} so a previously saved
      //               custom WSS URL goes back to the SDK default
      //   string    → set / replace
      // Without the explicit-clear path, callers could only undo a
      // previously-set baseWsUrl by going through the generic
      // /im/accounts/:id route with `config: {}` — surprising.
      let config: Record<string, unknown> | undefined
      if (body.baseWsUrl === null) {
        config = {}
      } else if (typeof body.baseWsUrl === "string") {
        config = { baseWsUrl: body.baseWsUrl }
      } else {
        config = undefined
      }

      const account = await updateTransportAccount({
        workspaceId,
        accountId,
        expectedTransportKind: "wecom",
        displayName: body.displayName,
        ownerScope: body.ownerScope,
        ownerWorkspaceMemberId: body.ownerWorkspaceMemberId,
        connectionMode: body.connectionMode,
        status: body.status,
        inboundActorMode: body.inboundActorMode,
        inboundActorId:
          body.inboundActorId === null ? null : body.inboundActorId,
        credentials,
        config,
      })
      await refreshTransportRuntimeState()
      return { account }
    }
  )
}
