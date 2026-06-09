import { z } from "zod"
import type { FastifyInstance, FastifyReply } from "fastify"
import {
  actorRef,
  CAPABILITY_ACCESS_TARGET_TYPES,
  conversationRef,
  remoteAgentRef,
  SUBJECT_KIND,
  workspaceMemberRef,
  workspaceRef,
  WORKSPACE_APP_GRANT_PERMISSIONS,
  WORKSPACE_APP_KINDS,
  type CapabilityAccessTarget,
  type WorkspaceAppGrantPermission,
  type WorkspaceAppKind,
} from "@synapse/shared"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { requireRequestAction } from "../access/guards.js"
import {
  approveWorkspaceAppGrantRequest,
  cancelWorkspaceAppGrantRequestByRequester,
  discoverWorkspaceAppsForMember,
  getWorkspaceAppInventoryDetail,
  listWorkspaceAppGrantRequestsView,
  listWorkspaceAppGrantsView,
  listWorkspaceAppsInventory,
  rejectWorkspaceAppGrantRequest,
  replaceWorkspaceAppGrants,
  submitWorkspaceAppGrantRequest,
} from "./service.js"

const workspaceAppKindSchema = z.enum(WORKSPACE_APP_KINDS)
const workspaceAppGrantPermissionSchema = z.enum(
  WORKSPACE_APP_GRANT_PERMISSIONS
)
const conversationTypeMaskSchema = z.number().int().min(1).max(15)

const targetSchema = z.object({
  subject: z.object({
    kind: z.enum(CAPABILITY_ACCESS_TARGET_TYPES),
    workspaceId: z.uuid().optional(),
    memberId: z.uuid().optional(),
    conversationId: z.uuid().optional(),
    actorId: z.uuid().optional(),
    remoteAgentId: z.uuid().optional(),
  }),
  scope: z
    .object({
      kind: z.literal("conversation"),
      conversationId: z.uuid(),
    })
    .optional(),
})

const replaceGrantsSchema = z.object({
  grants: z.array(
    z.object({
      target: targetSchema,
      permissions: z.array(workspaceAppGrantPermissionSchema).min(1),
      conversationTypeMaskOverride: conversationTypeMaskSchema
        .nullable()
        .optional(),
      reason: z.string().trim().min(1).optional(),
    })
  ),
})

const requestDirectionSchema = z
  .enum(["incoming", "outgoing"])
  .default("incoming")
const createGrantRequestSchema = z.object({
  reason: z.string().trim().min(1).optional(),
})

function toCapabilityAccessTarget(
  input: z.infer<typeof targetSchema>
): CapabilityAccessTarget {
  const subject =
    input.subject.kind === SUBJECT_KIND.WORKSPACE
      ? workspaceRef(input.subject.workspaceId || "")
      : input.subject.kind === SUBJECT_KIND.WORKSPACE_MEMBER
        ? workspaceMemberRef(input.subject.memberId || "")
        : input.subject.kind === SUBJECT_KIND.CONVERSATION
          ? conversationRef(input.subject.conversationId || "")
          : input.subject.kind === SUBJECT_KIND.ACTOR
            ? actorRef(input.subject.actorId || "")
            : remoteAgentRef(input.subject.remoteAgentId || "")

  const scope = input.scope
    ? conversationRef(input.scope.conversationId)
    : undefined
  return scope ? { subject, scope } : { subject }
}

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    return reply.status(400).send({
      error: "Validation error",
      details: error.issues,
    })
  }
  const message =
    error instanceof Error ? error.message : "Internal server error"
  if (/not found|does not belong to this app/i.test(message)) {
    return reply.status(404).send({ error: message })
  }
  if (/not allowed|permission|forbidden/i.test(message)) {
    return reply.status(403).send({ error: message })
  }
  if (/pending|exists|already/i.test(message)) {
    return reply.status(409).send({ error: message })
  }
  return reply.status(500).send({ error: message })
}

export function registerWorkspaceAppRoutes(app: FastifyInstance) {
  const workspaceHook = { preHandler: [authMiddleware, workspaceMiddleware] }

  app.get(
    "/api/v1/workspaces/:workspaceId/workspace-apps",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to view workspace apps in this workspace"
      )
      if (!allowed) return
      try {
        const query = z
          .object({
            kind: workspaceAppKindSchema.optional(),
          })
          .parse(request.query || {})
        const apps = await listWorkspaceAppsInventory({
          workspaceId,
          userId: (request as any).user.userId,
          kind: query.kind as WorkspaceAppKind | undefined,
        })
        reply.send({ apps })
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  app.get(
    "/api/v1/workspaces/:workspaceId/workspace-apps/discover",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to discover workspace apps in this workspace"
      )
      if (!allowed) return
      try {
        const query = z
          .object({
            conversationId: z.uuid().optional(),
          })
          .parse(request.query || {})
        const apps = await discoverWorkspaceAppsForMember({
          workspaceId,
          userId: (request as any).user.userId,
          conversationId: query.conversationId,
        })
        reply.send({ apps })
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  app.get(
    "/api/v1/workspaces/:workspaceId/workspace-apps/:appId",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId, appId } = request.params as {
        workspaceId: string
        appId: string
      }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to view workspace app details in this workspace"
      )
      if (!allowed) return
      try {
        const appView = await getWorkspaceAppInventoryDetail({
          workspaceId,
          appId,
          userId: (request as any).user.userId,
        })
        reply.send({ app: appView })
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  app.get(
    "/api/v1/workspaces/:workspaceId/workspace-apps/:appId/grants",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId, appId } = request.params as {
        workspaceId: string
        appId: string
      }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to view workspace app grants in this workspace"
      )
      if (!allowed) return
      try {
        const grants = await listWorkspaceAppGrantsView({
          workspaceId,
          appId,
          userId: (request as any).user.userId,
        })
        reply.send({ grants })
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  app.put(
    "/api/v1/workspaces/:workspaceId/workspace-apps/:appId/grants",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId, appId } = request.params as {
        workspaceId: string
        appId: string
      }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to manage workspace app grants in this workspace"
      )
      if (!allowed) return
      try {
        const body = replaceGrantsSchema.parse(request.body)
        const grants = await replaceWorkspaceAppGrants({
          workspaceId,
          appId,
          userId: (request as any).user.userId,
          grants: body.grants.map((grant) => ({
            target: toCapabilityAccessTarget(grant.target),
            permissions: grant.permissions as WorkspaceAppGrantPermission[],
            conversationTypeMaskOverride:
              grant.conversationTypeMaskOverride ?? null,
            reason: grant.reason,
          })),
        })
        reply.send({ grants })
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  app.get(
    "/api/v1/workspaces/:workspaceId/workspace-apps/:appId/grant-requests",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId, appId } = request.params as {
        workspaceId: string
        appId: string
      }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to view workspace app grant requests in this workspace"
      )
      if (!allowed) return
      try {
        const query = z
          .object({ direction: requestDirectionSchema.optional() })
          .parse(request.query || {})
        const requests = await listWorkspaceAppGrantRequestsView({
          workspaceId,
          appId,
          userId: (request as any).user.userId,
          direction: query.direction || "incoming",
        })
        reply.send({ requests })
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  app.post(
    "/api/v1/workspaces/:workspaceId/workspace-apps/:appId/grant-requests",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId, appId } = request.params as {
        workspaceId: string
        appId: string
      }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to request workspace app access in this workspace"
      )
      if (!allowed) return
      try {
        const body = createGrantRequestSchema.parse(request.body || {})
        const grantRequest = await submitWorkspaceAppGrantRequest({
          workspaceId,
          appId,
          userId: (request as any).user.userId,
          reason: body.reason,
        })
        reply.status(201).send({ request: grantRequest })
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  app.post(
    "/api/v1/workspaces/:workspaceId/workspace-apps/:appId/grant-requests/:requestId/approve",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId, appId, requestId } = request.params as {
        workspaceId: string
        appId: string
        requestId: string
      }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to resolve workspace app grant requests in this workspace"
      )
      if (!allowed) return
      try {
        const grantRequest = await approveWorkspaceAppGrantRequest({
          workspaceId,
          appId,
          requestId,
          userId: (request as any).user.userId,
        })
        reply.send({ request: grantRequest })
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  app.post(
    "/api/v1/workspaces/:workspaceId/workspace-apps/:appId/grant-requests/:requestId/reject",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId, appId, requestId } = request.params as {
        workspaceId: string
        appId: string
        requestId: string
      }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to resolve workspace app grant requests in this workspace"
      )
      if (!allowed) return
      try {
        const grantRequest = await rejectWorkspaceAppGrantRequest({
          workspaceId,
          appId,
          requestId,
          userId: (request as any).user.userId,
        })
        reply.send({ request: grantRequest })
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  app.post(
    "/api/v1/workspaces/:workspaceId/workspace-apps/:appId/grant-requests/:requestId/cancel",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId, appId, requestId } = request.params as {
        workspaceId: string
        appId: string
        requestId: string
      }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to cancel workspace app grant requests in this workspace"
      )
      if (!allowed) return
      try {
        const cancelled = await cancelWorkspaceAppGrantRequestByRequester({
          workspaceId,
          appId,
          requestId,
          userId: (request as any).user.userId,
        })
        reply.send({ success: cancelled })
      } catch (error) {
        handleError(reply, error)
      }
    }
  )
}
