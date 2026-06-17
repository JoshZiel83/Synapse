/**
 * Feishu-specific REST endpoints.
 *
 * Mounted as a Fastify plugin from controller.ts. Owns the
 * POST/PUT /im/accounts/feishu routes that take Feishu app credentials
 * as discrete fields and assemble the generic `credentials` JSON for the
 * shared account service.
 */

import type { FastifyInstance } from "fastify"
import { TransportAccountResponseSchema } from "@synapse/shared/schemas"
import { appRoute } from "../../../infrastructure/http/route.js"
import { createTransportAccount, updateTransportAccount } from "../service.js"
import {
  feishuAccountSchema,
  refreshTransportRuntimeState,
  requireWorkspaceAction,
  updateFeishuAccountSchema,
} from "./_shared.js"

export default async function imFeishuController(
  app: FastifyInstance
): Promise<void> {
  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/im/accounts/feishu",
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
      const body = feishuAccountSchema.parse(request.body)
      const credentials: Record<string, unknown> = {
        appId: body.appId,
        appSecret: body.appSecret,
      }
      if (body.connectionMode === "webhook") {
        if (body.verificationToken) {
          credentials.verificationToken = body.verificationToken
        }
        if (body.encryptKey) {
          credentials.encryptKey = body.encryptKey
        }
      }
      if (body.domain) {
        credentials.domain = body.domain
      }

      const account = await createTransportAccount({
        workspaceId,
        transportKind: "feishu",
        accountKey: body.accountKey || body.appId,
        displayName: body.displayName,
        ownerScope: body.ownerScope,
        ownerWorkspaceMemberId: body.ownerWorkspaceMemberId ?? null,
        connectionMode: body.connectionMode,
        status: body.status,
        inboundActorMode: body.inboundActorMode,
        inboundActorId:
          body.inboundActorId === null ? null : body.inboundActorId,
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
    "/api/v1/workspaces/:workspaceId/im/accounts/feishu/:accountId",
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
      const body = updateFeishuAccountSchema.parse(request.body)
      const credentials =
        body.appId ||
        body.appSecret ||
        body.verificationToken ||
        body.encryptKey ||
        body.domain
          ? {
              ...(body.appId ? { appId: body.appId } : {}),
              ...(body.appSecret ? { appSecret: body.appSecret } : {}),
              ...(body.verificationToken
                ? { verificationToken: body.verificationToken }
                : {}),
              ...(body.encryptKey ? { encryptKey: body.encryptKey } : {}),
              ...(body.domain ? { domain: body.domain } : {}),
            }
          : undefined

      const account = await updateTransportAccount({
        workspaceId,
        accountId,
        // Per-transport route guard — assertExpectedTransportKind in
        // updateTransportAccount throws 404 `transport_account_kind_mismatch`
        // when the row's kind doesn't match. Prevents the Feishu route
        // from silently mutating a Weixin / WeCom account by id reuse.
        expectedTransportKind: "feishu",
        displayName: body.displayName,
        ownerScope: body.ownerScope,
        ownerWorkspaceMemberId: body.ownerWorkspaceMemberId,
        connectionMode: body.connectionMode,
        status: body.status,
        inboundActorMode: body.inboundActorMode,
        inboundActorId:
          body.inboundActorId === null ? null : body.inboundActorId,
        credentials,
      })
      await refreshTransportRuntimeState()
      return { account }
    }
  )
}
