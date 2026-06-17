/**
 * Personal-WeChat (ilinkai) REST endpoints.
 *
 * Owns the routes that diverge from the generic account CRUD shape:
 * QR-login flows (current-user binding + workspace-managed bot) and the
 * workspace-member binding lifecycle (auto-link, manual link).
 *
 * Mounted as a Fastify plugin from controller.ts.
 */

import type { FastifyInstance } from "fastify"
import {
  WeixinBindingCandidatesResponseSchema,
  WeixinBindingResponseSchema,
  WeixinQrSessionResponseSchema,
} from "@synapse/shared/schemas"
import { appRoute } from "../../../infrastructure/http/route.js"
import { listMembers } from "../../workspace/service.js"
import {
  getCurrentUserWeixinBinding,
  linkCurrentUserWeixinBinding,
  setCurrentUserWeixinBindingAutoLink,
} from "../service.js"
import {
  getWeixinQrLoginSession,
  getWeixinQrLoginSessionOwner,
  startWeixinQrLoginSession,
} from "../connectors/weixin/qr-login.js"
import {
  bindingAutoLinkSchema,
  requireWorkspaceAction,
  weixinQrSessionSchema,
} from "./_shared.js"

export default async function imWeixinController(
  app: FastifyInstance
): Promise<void> {
  // -------- Current user's WeChat binding --------

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/im/me/weixin-binding",
    { schema: WeixinBindingResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to access WeChat binding in this workspace"
      )
      if (!allowed) return

      const params = request.params as { workspaceId: string }
      const binding = await getCurrentUserWeixinBinding({
        workspaceId: params.workspaceId,
        userId: (request as any).user!.userId,
      })
      return { binding }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/im/me/weixin-binding/candidates",
    { schema: WeixinBindingCandidatesResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to access WeChat binding in this workspace"
      )
      if (!allowed) return

      const params = request.params as { workspaceId: string }
      const members = await listMembers(params.workspaceId)
      return { members }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/im/me/weixin-binding/qr",
    { schema: WeixinQrSessionResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to bind WeChat in this workspace"
      )
      if (!allowed) return

      const { workspaceId } = request.params as { workspaceId: string }
      const workspaceMemberId = (request as any).workspaceMember?.id as string
      const userId = (request as any).user!.userId as string
      const existing = await getCurrentUserWeixinBinding({
        workspaceId,
        userId,
      })
      if (existing) {
        reply.status(409).send({ error: "WeChat already bound" })
        return
      }

      const session = await startWeixinQrLoginSession({
        workspaceId,
        ownerScope: "workspace_member",
        ownerWorkspaceMemberId: workspaceMemberId,
        inboundActorMode: "follow_owner_chief_actor",
      })
      reply.status(201)
      return { session }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/im/me/weixin-binding/qr/:sessionId",
    { schema: WeixinQrSessionResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to access WeChat binding in this workspace"
      )
      if (!allowed) return

      const { workspaceId, sessionId } = request.params as {
        workspaceId: string
        sessionId: string
      }
      const workspaceMemberId = (request as any).workspaceMember?.id as string
      const owner = await getWeixinQrLoginSessionOwner({
        workspaceId,
        sessionId,
      })
      if (
        !owner ||
        owner.ownerScope !== "workspace_member" ||
        owner.ownerWorkspaceMemberId !== workspaceMemberId
      ) {
        reply.status(404).send({ error: "Weixin QR session not found" })
        return
      }

      const session = await getWeixinQrLoginSession({
        workspaceId,
        sessionId,
      })
      if (!session) {
        reply.status(404).send({ error: "Weixin QR session not found" })
        return
      }
      return { session }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/im/me/weixin-binding/link",
    { schema: WeixinBindingResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to link WeChat in this workspace"
      )
      if (!allowed) return

      const params = request.params as { workspaceId: string }
      try {
        const binding = await linkCurrentUserWeixinBinding({
          workspaceId: params.workspaceId,
          userId: (request as any).user!.userId,
        })
        return { binding }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to link WeChat"
        if (message === "WeChat binding not found") {
          reply.status(404).send({ error: message })
          return
        }
        if (
          message ===
          "WeChat user is already linked to another workspace member"
        ) {
          reply.status(409).send({ error: message })
          return
        }
        reply.status(400).send({ error: message })
        return
      }
    }
  )

  appRoute(
    app,
    "PUT",
    "/api/v1/workspaces/:workspaceId/im/me/weixin-binding/auto-link",
    { schema: WeixinBindingResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to configure WeChat binding in this workspace"
      )
      if (!allowed) return

      const params = request.params as { workspaceId: string }
      try {
        const body = bindingAutoLinkSchema.parse(request.body)
        const binding = await setCurrentUserWeixinBindingAutoLink({
          workspaceId: params.workspaceId,
          userId: (request as any).user!.userId,
          targetWorkspaceMemberId: body.workspaceMemberId,
        })
        return { binding }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to configure WeChat binding"
        if (message === "WeChat binding not found") {
          reply.status(404).send({ error: message })
          return
        }
        if (message === "Workspace member not found") {
          reply.status(404).send({ error: message })
          return
        }
        reply.status(400).send({ error: message })
        return
      }
    }
  )

  // -------- Workspace-managed WeChat bot QR --------

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/im/accounts/weixin/qr",
    { schema: WeixinQrSessionResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return

      const { workspaceId } = request.params as { workspaceId: string }
      const body = weixinQrSessionSchema.parse(request.body)
      const session = await startWeixinQrLoginSession({
        workspaceId,
        displayName: body.displayName,
        baseUrl: body.baseUrl,
        botType: body.botType,
        ownerScope: body.ownerScope,
        ownerWorkspaceMemberId: body.ownerWorkspaceMemberId ?? null,
        inboundActorMode: body.inboundActorMode,
        inboundActorId:
          body.inboundActorId === null ? null : body.inboundActorId,
      })
      reply.status(201)
      return { session }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/im/accounts/weixin/qr/:sessionId",
    { schema: WeixinQrSessionResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return

      const params = request.params as {
        workspaceId: string
        sessionId: string
      }
      const session = await getWeixinQrLoginSession({
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
      })
      if (!session) {
        reply.status(404).send({ error: "Weixin QR session not found" })
        return
      }
      return { session }
    }
  )
}
