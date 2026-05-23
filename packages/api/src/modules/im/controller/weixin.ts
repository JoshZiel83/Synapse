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

  app.get<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/im/me/weixin-binding",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to access WeChat binding in this workspace"
      )
      if (!allowed) return

      const binding = await getCurrentUserWeixinBinding({
        workspaceId: request.params.workspaceId,
        userId: (request as any).user!.userId,
      })
      return reply.send({ binding })
    }
  )

  app.get<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/im/me/weixin-binding/candidates",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to access WeChat binding in this workspace"
      )
      if (!allowed) return

      const members = await listMembers(request.params.workspaceId)
      return reply.send({ data: members })
    }
  )

  app.post<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/im/me/weixin-binding/qr",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to bind WeChat in this workspace"
      )
      if (!allowed) return

      const { workspaceId } = request.params
      const workspaceMemberId = (request as any).workspaceMember?.id as string
      const userId = (request as any).user!.userId as string
      const existing = await getCurrentUserWeixinBinding({
        workspaceId,
        userId,
      })
      if (existing) {
        return reply.status(409).send({ error: "WeChat already bound" })
      }

      const session = await startWeixinQrLoginSession({
        workspaceId,
        ownerScope: "workspace_member",
        ownerWorkspaceMemberId: workspaceMemberId,
        inboundActorMode: "follow_owner_chief_actor",
      })
      return reply.status(201).send({ session })
    }
  )

  app.get<{
    Params: { workspaceId: string; sessionId: string }
  }>(
    "/api/v1/workspaces/:workspaceId/im/me/weixin-binding/qr/:sessionId",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to access WeChat binding in this workspace"
      )
      if (!allowed) return

      const { workspaceId, sessionId } = request.params
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
        return reply.status(404).send({ error: "Weixin QR session not found" })
      }

      const session = await getWeixinQrLoginSession({
        workspaceId,
        sessionId,
      })
      if (!session) {
        return reply.status(404).send({ error: "Weixin QR session not found" })
      }
      return reply.send({ session })
    }
  )

  app.post<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/im/me/weixin-binding/link",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to link WeChat in this workspace"
      )
      if (!allowed) return

      try {
        const binding = await linkCurrentUserWeixinBinding({
          workspaceId: request.params.workspaceId,
          userId: (request as any).user!.userId,
        })
        return reply.send({ binding })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to link WeChat"
        if (message === "WeChat binding not found") {
          return reply.status(404).send({ error: message })
        }
        if (
          message ===
          "WeChat user is already linked to another workspace member"
        ) {
          return reply.status(409).send({ error: message })
        }
        return reply.status(400).send({ error: message })
      }
    }
  )

  app.put<{ Params: { workspaceId: string }; Body: unknown }>(
    "/api/v1/workspaces/:workspaceId/im/me/weixin-binding/auto-link",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to configure WeChat binding in this workspace"
      )
      if (!allowed) return

      try {
        const body = bindingAutoLinkSchema.parse(request.body)
        const binding = await setCurrentUserWeixinBindingAutoLink({
          workspaceId: request.params.workspaceId,
          userId: (request as any).user!.userId,
          targetWorkspaceMemberId: body.workspaceMemberId,
        })
        return reply.send({ binding })
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to configure WeChat binding"
        if (message === "WeChat binding not found") {
          return reply.status(404).send({ error: message })
        }
        if (message === "Workspace member not found") {
          return reply.status(404).send({ error: message })
        }
        return reply.status(400).send({ error: message })
      }
    }
  )

  // -------- Workspace-managed WeChat bot QR --------

  app.post<{ Params: { workspaceId: string }; Body: unknown }>(
    "/api/v1/workspaces/:workspaceId/im/accounts/weixin/qr",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return

      const { workspaceId } = request.params
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
      return reply.status(201).send({ session })
    }
  )

  app.get<{
    Params: { workspaceId: string; sessionId: string }
  }>(
    "/api/v1/workspaces/:workspaceId/im/accounts/weixin/qr/:sessionId",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return

      const session = await getWeixinQrLoginSession({
        workspaceId: request.params.workspaceId,
        sessionId: request.params.sessionId,
      })
      if (!session) {
        return reply.status(404).send({ error: "Weixin QR session not found" })
      }
      return reply.send({ session })
    }
  )
}
