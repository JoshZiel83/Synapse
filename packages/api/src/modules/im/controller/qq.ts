/**
 * QQ-specific REST endpoints.
 *
 * POST/PUT /im/accounts/qq routes that take QQ Bot credentials as discrete
 * fields and assemble the generic `credentials` + `config` JSON for the
 * shared account service.
 *
 * Why credentials vs config split:
 *   - `appId` + `clientSecret` (+ optional `botSecret` for Ed25519 if OQ1
 *     finds the QQ console exposes a separate secret) live in `credentials`.
 *     Connector reads them via getQqCredentialsOrThrow().
 *   - `webhookInboundConfirmed`, `allowProactiveBestEffort`, and
 *     `configuredUrlDomains` are non-secret operator toggles → `config`.
 *     Connector reads them via readQqAccountConfig() which also runs the
 *     server-side normalization (lowercase, strip scheme/path/port, reject
 *     wildcards/IPs).
 */

import type { FastifyInstance } from "fastify"
import { createTransportAccount, updateTransportAccount } from "../service.js"
import {
  qqAccountSchema,
  refreshTransportRuntimeState,
  requireWorkspaceAction,
  updateQqAccountSchema,
} from "./_shared.js"

export default async function imQqController(
  app: FastifyInstance
): Promise<void> {
  app.post<{ Params: { workspaceId: string }; Body: unknown }>(
    "/api/v1/workspaces/:workspaceId/im/accounts/qq",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return

      const { workspaceId } = request.params
      const body = qqAccountSchema.parse(request.body)
      const credentials: Record<string, unknown> = {
        appId: body.appId,
        clientSecret: body.clientSecret,
      }
      if (body.botSecret) credentials.botSecret = body.botSecret
      const config: Record<string, unknown> = {
        webhookInboundConfirmed: body.webhookInboundConfirmed ?? false,
        allowProactiveBestEffort: body.allowProactiveBestEffort ?? false,
        configuredUrlDomains: body.configuredUrlDomains ?? [],
      }

      const account = await createTransportAccount({
        workspaceId,
        transportKind: "qq",
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
        config,
      })
      await refreshTransportRuntimeState()
      return reply.status(201).send({ account })
    }
  )

  app.put<{
    Params: { workspaceId: string; accountId: string }
    Body: unknown
  }>(
    "/api/v1/workspaces/:workspaceId/im/accounts/qq/:accountId",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return

      const { workspaceId, accountId } = request.params
      const body = updateQqAccountSchema.parse(request.body)
      const credentials =
        body.appId || body.clientSecret || body.botSecret
          ? {
              ...(body.appId ? { appId: body.appId } : {}),
              ...(body.clientSecret ? { clientSecret: body.clientSecret } : {}),
              ...(body.botSecret ? { botSecret: body.botSecret } : {}),
            }
          : undefined
      const config =
        body.webhookInboundConfirmed !== undefined ||
        body.allowProactiveBestEffort !== undefined ||
        body.configuredUrlDomains !== undefined
          ? {
              ...(body.webhookInboundConfirmed !== undefined
                ? { webhookInboundConfirmed: body.webhookInboundConfirmed }
                : {}),
              ...(body.allowProactiveBestEffort !== undefined
                ? {
                    allowProactiveBestEffort: body.allowProactiveBestEffort,
                  }
                : {}),
              ...(body.configuredUrlDomains !== undefined
                ? { configuredUrlDomains: body.configuredUrlDomains }
                : {}),
            }
          : undefined

      const account = await updateTransportAccount({
        workspaceId,
        accountId,
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
      return reply.send({ account })
    }
  )
}
