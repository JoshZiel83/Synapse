/**
 * Main IM controller. Owns:
 *   - middleware wiring
 *   - generic transport_account / session / external-user / connector
 *     endpoints that work for every transport_kind
 *
 * Per-transport routes that diverge from the generic shape live in:
 *   - controller/feishu.ts   (POST/PUT /im/accounts/feishu)
 *   - controller/weixin.ts   (binding lifecycle + QR-login flows)
 *   - controller/wecom.ts    (POST/PUT /im/accounts/wecom)
 *   - controller/dingtalk.ts (POST/PUT /im/accounts/dingtalk + Device Flow)
 *   - controller/qq.ts       (POST/PUT /im/accounts/qq)
 */

import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import {
  createTransportAccount,
  listTransportAccounts,
  listTransportExternalUsers,
  listTransportSessions,
  setTransportAddressLinkedUser,
  updateTransportAccount,
  updateTransportSessionSettings,
} from "./service.js"
import { listTransportConnectorCapabilities } from "./connectors/index.js"
import {
  accountSchema,
  linkedUserSchema,
  refreshTransportRuntimeState,
  requireWorkspaceAction,
  transportSessionSettingsSchema,
  updateAccountSchema,
} from "./controller/_shared.js"
import imFeishuController from "./controller/feishu.js"
import imWecomController from "./controller/wecom.js"
import imQqController from "./controller/qq.js"
import imWeixinController from "./controller/weixin.js"
import imDingtalkController from "./controller/dingtalk.js"

export default async function imController(app: FastifyInstance) {
  app.addHook("onRequest", authMiddleware)
  app.addHook("onRequest", workspaceMiddleware)

  // Per-transport routes registered as plugins on the same app so they
  // inherit the auth + workspace middleware above.
  await imFeishuController(app)
  await imWecomController(app)
  await imWeixinController(app)
  await imDingtalkController(app)
  await imQqController(app)

  app.get<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/im/connectors",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to view IM connectors in this workspace"
      )
      if (!allowed) return
      return reply.send({ connectors: listTransportConnectorCapabilities() })
    }
  )

  app.get<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/im/accounts",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to view IM accounts in this workspace"
      )
      if (!allowed) return

      const { workspaceId } = request.params
      const accounts = await listTransportAccounts(workspaceId)
      return reply.send({ accounts })
    }
  )

  app.get<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/im/sessions",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to view IM sessions in this workspace"
      )
      if (!allowed) return

      const { workspaceId } = request.params
      const sessions = await listTransportSessions(workspaceId)
      return reply.send({ sessions })
    }
  )

  app.get<{
    Params: { workspaceId: string }
    Querystring: { transportAccountId?: string }
  }>(
    "/api/v1/workspaces/:workspaceId/im/external-users",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to view IM external users in this workspace"
      )
      if (!allowed) return

      const { workspaceId } = request.params
      const externalUsers = await listTransportExternalUsers({
        workspaceId,
        transportAccountId: request.query.transportAccountId,
      })
      return reply.send({ externalUsers })
    }
  )

  app.put<{
    Params: { workspaceId: string; sessionId: string }
    Body: unknown
  }>(
    "/api/v1/workspaces/:workspaceId/im/sessions/:sessionId/settings",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM sessions in this workspace"
      )
      if (!allowed) return

      const { workspaceId, sessionId } = request.params
      const body = transportSessionSettingsSchema.parse(request.body)
      const session = await updateTransportSessionSettings({
        workspaceId,
        transportEndpointId: sessionId,
        outboundEnabled: body.outboundEnabled,
        inboundActorMode: body.inboundActorMode,
        inboundActorId:
          body.inboundActorId === null ? null : body.inboundActorId,
        metadata: body.metadata,
      })
      return reply.send({ session })
    }
  )

  app.put<{
    Params: { workspaceId: string; addressId: string }
    Body: unknown
  }>(
    "/api/v1/workspaces/:workspaceId/im/external-users/:addressId/workspace-member",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM external users in this workspace"
      )
      if (!allowed) return

      const { workspaceId, addressId } = request.params
      const body = linkedUserSchema.parse(request.body)
      const address = await setTransportAddressLinkedUser({
        workspaceId,
        transportAddressId: addressId,
        workspaceMemberId: body.workspaceMemberId,
      })
      return reply.send({ address })
    }
  )

  // Generic transport_account CRUD — schema includes transport_kind so the
  // service dispatches to the right connector validateCredentials.
  app.post<{ Params: { workspaceId: string }; Body: unknown }>(
    "/api/v1/workspaces/:workspaceId/im/accounts",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return

      const { workspaceId } = request.params
      const body = accountSchema.parse(request.body)
      // Catch the service-layer per-transport config validator's
      // ZodError so a wildcard / IP in `config.configuredUrlDomains`
      // (QQ-specific gate, currently the only transport with one)
      // surfaces as 400 instead of Fastify's default 500.
      let account
      try {
        account = await createTransportAccount({
          workspaceId,
          transportKind: body.transportKind,
          accountKey: body.accountKey,
          displayName: body.displayName,
          ownerScope: body.ownerScope,
          ownerWorkspaceMemberId: body.ownerWorkspaceMemberId ?? null,
          connectionMode: body.connectionMode,
          status: body.status,
          inboundActorMode: body.inboundActorMode,
          inboundActorId:
            body.inboundActorId === null ? null : body.inboundActorId,
          credentials: body.credentials,
          config: body.config,
          metadata: body.metadata,
        })
      } catch (err) {
        if (err instanceof z.ZodError) {
          return reply.status(400).send({
            error: "invalid_account_config",
            issues: err.issues.map((i) => ({
              path: i.path,
              code: i.code,
              message: i.message,
            })),
          })
        }
        throw err
      }
      await refreshTransportRuntimeState()
      return reply.status(201).send({ account })
    }
  )

  app.put<{
    Params: { workspaceId: string; accountId: string }
    Body: unknown
  }>(
    "/api/v1/workspaces/:workspaceId/im/accounts/:accountId",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return

      const { workspaceId, accountId } = request.params
      const body = updateAccountSchema.parse(request.body)
      let account
      try {
        account = await updateTransportAccount({
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
          credentials: body.credentials,
          config: body.config,
          metadata: body.metadata,
        })
      } catch (err) {
        if (err instanceof z.ZodError) {
          return reply.status(400).send({
            error: "invalid_account_config",
            issues: err.issues.map((i) => ({
              path: i.path,
              code: i.code,
              message: i.message,
            })),
          })
        }
        throw err
      }
      await refreshTransportRuntimeState()
      return reply.send({ account })
    }
  )
}
