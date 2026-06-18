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
import {
  TransportAccountResponseSchema,
  TransportAccountsResponseSchema,
  TransportConnectorsResponseSchema,
  TransportAccountCreateInputSchema,
  TransportExternalUserResponseSchema,
  TransportExternalUserLinkedMemberInputSchema,
  TransportExternalUsersResponseSchema,
  TransportExternalUsersListQuerySchema,
  TransportSessionResponseSchema,
  TransportSessionSettingsInputSchema,
  TransportSessionsResponseSchema,
  TransportAccountUpdateInputSchema,
} from "@synapse/shared/schemas"
import { appRoute } from "../../infrastructure/http/route.js"
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
  refreshTransportRuntimeState,
  requireWorkspaceAction,
} from "./controller/_shared.js"
import imFeishuController from "./controller/feishu.js"
import imWecomController from "./controller/wecom.js"
import imQqController from "./controller/qq.js"
import imWeixinController from "./controller/weixin.js"
import imDingtalkController from "./controller/dingtalk.js"
import imTelegramController from "./controller/telegram.js"
import imWhatsappController from "./controller/whatsapp.js"
import imWhatsappUnofficialController from "./controller/whatsapp_unofficial.js"

// Generic IM app request bodies/queries live in @synapse/shared/schemas; the
// per-transport credential controllers are migrated separately.
const accountSchema = TransportAccountCreateInputSchema
const updateAccountSchema = TransportAccountUpdateInputSchema
const transportSessionSettingsSchema = TransportSessionSettingsInputSchema
const linkedUserSchema = TransportExternalUserLinkedMemberInputSchema
const externalUsersQuerySchema = TransportExternalUsersListQuerySchema

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
  await imTelegramController(app)
  await imWhatsappController(app)
  await imWhatsappUnofficialController(app)

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/im/connectors",
    { schema: TransportConnectorsResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to view IM connectors in this workspace"
      )
      if (!allowed) return
      return { connectors: listTransportConnectorCapabilities() }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/im/accounts",
    { schema: TransportAccountsResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to view IM accounts in this workspace"
      )
      if (!allowed) return

      const { workspaceId } = request.params as { workspaceId: string }
      const accounts = await listTransportAccounts(workspaceId)
      return { accounts }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/im/sessions",
    { schema: TransportSessionsResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to view IM sessions in this workspace"
      )
      if (!allowed) return

      const { workspaceId } = request.params as { workspaceId: string }
      const sessions = await listTransportSessions(workspaceId)
      return { sessions }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/im/external-users",
    { schema: TransportExternalUsersResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to view IM external users in this workspace"
      )
      if (!allowed) return

      const { workspaceId } = request.params as { workspaceId: string }
      const query = externalUsersQuerySchema.parse(request.query || {})
      const externalUsers = await listTransportExternalUsers({
        workspaceId,
        transportAccountId: query.transportAccountId,
      })
      return { externalUsers }
    }
  )

  appRoute(
    app,
    "PUT",
    "/api/v1/workspaces/:workspaceId/im/sessions/:sessionId/settings",
    { schema: TransportSessionResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM sessions in this workspace"
      )
      if (!allowed) return

      const { workspaceId, sessionId } = request.params as {
        workspaceId: string
        sessionId: string
      }
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
      return { session }
    }
  )

  appRoute(
    app,
    "PUT",
    "/api/v1/workspaces/:workspaceId/im/external-users/:addressId/workspace-member",
    { schema: TransportExternalUserResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM external users in this workspace"
      )
      if (!allowed) return

      const { workspaceId, addressId } = request.params as {
        workspaceId: string
        addressId: string
      }
      const body = linkedUserSchema.parse(request.body)
      const externalUser = await setTransportAddressLinkedUser({
        workspaceId,
        transportAddressId: addressId,
        workspaceMemberId: body.workspaceMemberId,
      })
      return { externalUser }
    }
  )

  // Generic transport_account CRUD — schema includes transport_kind so the
  // service dispatches to the right connector validateCredentials.
  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/im/accounts",
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
          reply.status(400).send({
            error: "invalid_account_config",
            issues: err.issues.map((i) => ({
              path: i.path,
              code: i.code,
              message: i.message,
            })),
          })
          return
        }
        throw err
      }
      await refreshTransportRuntimeState()
      reply.status(201)
      return { account }
    }
  )

  appRoute(
    app,
    "PUT",
    "/api/v1/workspaces/:workspaceId/im/accounts/:accountId",
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
          reply.status(400).send({
            error: "invalid_account_config",
            issues: err.issues.map((i) => ({
              path: i.path,
              code: i.code,
              message: i.message,
            })),
          })
          return
        }
        throw err
      }
      await refreshTransportRuntimeState()
      return { account }
    }
  )
}
