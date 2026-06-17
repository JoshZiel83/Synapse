import { z } from "zod"
import type { FastifyInstance, FastifyReply } from "fastify"
import {
  actorRef,
  CAPABILITY_ACCESS_TARGET_TYPES,
  conversationRef,
  remoteAgentRef,
  SUBJECT_KIND,
  WORKSPACE_APP_KIND,
  WORKSPACE_APP_GRANT_REQUEST_DIRECTION,
  workspaceMemberRef,
  workspaceRef,
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
  createWorkspaceApp,
  deleteWorkspaceApp,
  discoverWorkspaceAppsForMember,
  getWorkspaceAppInventoryDetail,
  listWorkspaceAppGrantRecords,
  listWorkspaceAppGrantRequestRecords,
  listWorkspaceAppsInventory,
  rejectWorkspaceAppGrantRequest,
  replaceWorkspaceAppGrants,
  submitWorkspaceAppGrantRequest,
  updateWorkspaceApp,
} from "./service.js"
import {
  presentGrant,
  presentGrantRequest,
  presentWorkspaceApp,
} from "./presenter.js"
import { appRoute } from "../../infrastructure/http/route.js"
import {
  WorkspaceAppGrantTargetSchema,
  ReplaceWorkspaceAppGrantsInputSchema,
  CreateWorkspaceAppGrantRequestInputSchema,
  CreateWorkspaceAppInputSchema,
  UpdateWorkspaceAppInputSchema,
  WorkspaceAppDiscoverQuerySchema,
  WorkspaceAppEnvelopeViewSchema,
  WorkspaceAppGrantRequestListQuerySchema,
  WorkspaceAppListQuerySchema,
  WorkspaceAppListViewSchema,
  WorkspaceAppGrantListViewSchema,
  WorkspaceAppGrantRequestListViewSchema,
  WorkspaceAppGrantRequestEnvelopeViewSchema,
  WorkspaceAppSuccessViewSchema,
} from "@synapse/shared/schemas"

const workspaceAppEnvelopeSchema = WorkspaceAppEnvelopeViewSchema
const workspaceAppsEnvelopeSchema = WorkspaceAppListViewSchema
const grantsEnvelopeSchema = WorkspaceAppGrantListViewSchema
const grantRequestsEnvelopeSchema = WorkspaceAppGrantRequestListViewSchema
const grantRequestEnvelopeSchema = WorkspaceAppGrantRequestEnvelopeViewSchema
const successEnvelopeSchema = WorkspaceAppSuccessViewSchema

// App-facing request bodies / queries live in @synapse/shared (§5.1.1) so the
// API parser and the web/mobile clients share one definition. The grant target
// schema feeds toCapabilityAccessTarget below (typed via z.infer).
const targetSchema = WorkspaceAppGrantTargetSchema
const replaceGrantsSchema = ReplaceWorkspaceAppGrantsInputSchema
const createGrantRequestSchema = CreateWorkspaceAppGrantRequestInputSchema
const createWorkspaceAppSchema = CreateWorkspaceAppInputSchema
const updateWorkspaceAppSchema = UpdateWorkspaceAppInputSchema
const workspaceAppListQuerySchema = WorkspaceAppListQuerySchema
const workspaceAppDiscoverQuerySchema = WorkspaceAppDiscoverQuerySchema
const grantRequestListQuerySchema = WorkspaceAppGrantRequestListQuerySchema

function toCapabilityAccessTarget(
  input: z.infer<typeof targetSchema>
): CapabilityAccessTarget {
  const subject =
    input.subject.kind === SUBJECT_KIND.WORKSPACE
      ? workspaceRef(input.subject.workspaceId)
      : input.subject.kind === SUBJECT_KIND.WORKSPACE_MEMBER
        ? workspaceMemberRef(input.subject.memberId)
        : input.subject.kind === SUBJECT_KIND.CONVERSATION
          ? conversationRef(input.subject.conversationId)
          : input.subject.kind === SUBJECT_KIND.ACTOR
            ? actorRef(input.subject.actorId)
            : remoteAgentRef(input.subject.remoteAgentId)

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
  if (/required|must be|validation|invalid/i.test(message)) {
    return reply.status(400).send({ error: message })
  }
  if (/pending|exists|already/i.test(message)) {
    return reply.status(409).send({ error: message })
  }
  return reply.status(500).send({ error: message })
}

export function registerWorkspaceAppRoutes(app: FastifyInstance) {
  const workspaceHook = { preHandler: [authMiddleware, workspaceMiddleware] }

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/workspace-apps",
    { schema: workspaceAppEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string }
      try {
        const body = createWorkspaceAppSchema.parse(request.body)
        const createAction =
          body.kind === WORKSPACE_APP_KIND.ACTOR
            ? "workspace.manage_actors"
            : body.kind === WORKSPACE_APP_KIND.REMOTE_AGENT
              ? "workspace.manage_remote_agents"
              : body.kind === WORKSPACE_APP_KIND.INSTALLED_SKILL
                ? "workspace.manage_skills"
                : "workspace.manage_plugins"
        const allowed = await requireRequestAction(
          request,
          reply,
          createAction,
          workspaceId,
          "Not allowed to create this workspace app"
        )
        if (!allowed) return
        const appRecord = await createWorkspaceApp({
          workspaceId,
          userId: (request as any).user.userId,
          input: {
            ...body,
            grants: body.grants?.map((grant) => ({
              target: toCapabilityAccessTarget(grant.target),
              permissions: grant.permissions as WorkspaceAppGrantPermission[],
              conversationTypeMaskOverride:
                grant.conversationTypeMaskOverride ?? null,
              reason: grant.reason,
            })),
          } as any,
        })
        reply.status(201)
        return { app: presentWorkspaceApp(appRecord) }
      } catch (error) {
        handleError(reply, error)
        return
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/workspace-apps",
    { schema: workspaceAppsEnvelopeSchema, options: workspaceHook },
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
        const query = workspaceAppListQuerySchema.parse(request.query || {})
        const apps = await listWorkspaceAppsInventory({
          workspaceId,
          userId: (request as any).user.userId,
          kind: query.kind as WorkspaceAppKind | undefined,
        })
        return { apps: apps.map(presentWorkspaceApp) }
      } catch (error) {
        handleError(reply, error)
        return
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/workspace-apps/discover",
    { schema: workspaceAppsEnvelopeSchema, options: workspaceHook },
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
        const query = workspaceAppDiscoverQuerySchema.parse(request.query || {})
        const apps = await discoverWorkspaceAppsForMember({
          workspaceId,
          userId: (request as any).user.userId,
          conversationId: query.conversationId,
        })
        return { apps: apps.map(presentWorkspaceApp) }
      } catch (error) {
        handleError(reply, error)
        return
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/workspace-apps/:appId",
    { schema: workspaceAppEnvelopeSchema, options: workspaceHook },
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
        const appRecord = await getWorkspaceAppInventoryDetail({
          workspaceId,
          appId,
          userId: (request as any).user.userId,
        })
        return { app: presentWorkspaceApp(appRecord) }
      } catch (error) {
        handleError(reply, error)
        return
      }
    }
  )

  appRoute(
    app,
    "PUT",
    "/api/v1/workspaces/:workspaceId/workspace-apps/:appId",
    { schema: workspaceAppEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      const { workspaceId, appId } = request.params as {
        workspaceId: string
        appId: string
      }
      try {
        const body = updateWorkspaceAppSchema.parse(request.body)
        const appRecord = await updateWorkspaceApp({
          workspaceId,
          appId,
          userId: (request as any).user.userId,
          input: body as any,
        })
        return { app: presentWorkspaceApp(appRecord) }
      } catch (error) {
        handleError(reply, error)
        return
      }
    }
  )

  appRoute(
    app,
    "DELETE",
    "/api/v1/workspaces/:workspaceId/workspace-apps/:appId",
    { schema: successEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      const { workspaceId, appId } = request.params as {
        workspaceId: string
        appId: string
      }
      try {
        const deleted = await deleteWorkspaceApp({
          workspaceId,
          appId,
          userId: (request as any).user.userId,
        })
        return { success: deleted }
      } catch (error) {
        handleError(reply, error)
        return
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/workspace-apps/:appId/grants",
    { schema: grantsEnvelopeSchema, options: workspaceHook },
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
        const grants = await listWorkspaceAppGrantRecords({
          workspaceId,
          appId,
          userId: (request as any).user.userId,
        })
        return { grants: grants.map(presentGrant) }
      } catch (error) {
        handleError(reply, error)
        return
      }
    }
  )

  appRoute(
    app,
    "PUT",
    "/api/v1/workspaces/:workspaceId/workspace-apps/:appId/grants",
    { schema: grantsEnvelopeSchema, options: workspaceHook },
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
        return { grants: grants.map(presentGrant) }
      } catch (error) {
        handleError(reply, error)
        return
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/workspace-apps/:appId/grant-requests",
    { schema: grantRequestsEnvelopeSchema, options: workspaceHook },
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
        const query = grantRequestListQuerySchema.parse(request.query || {})
        const requests = await listWorkspaceAppGrantRequestRecords({
          workspaceId,
          appId,
          userId: (request as any).user.userId,
          direction:
            query.direction || WORKSPACE_APP_GRANT_REQUEST_DIRECTION.INCOMING,
        })
        return { requests: requests.map(presentGrantRequest) }
      } catch (error) {
        handleError(reply, error)
        return
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/workspace-apps/:appId/grant-requests",
    { schema: grantRequestEnvelopeSchema, options: workspaceHook },
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
        reply.status(201)
        return { request: presentGrantRequest(grantRequest) }
      } catch (error) {
        handleError(reply, error)
        return
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/workspace-apps/:appId/grant-requests/:requestId/approve",
    { schema: grantRequestEnvelopeSchema, options: workspaceHook },
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
        return { request: presentGrantRequest(grantRequest) }
      } catch (error) {
        handleError(reply, error)
        return
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/workspace-apps/:appId/grant-requests/:requestId/reject",
    { schema: grantRequestEnvelopeSchema, options: workspaceHook },
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
        return { request: presentGrantRequest(grantRequest) }
      } catch (error) {
        handleError(reply, error)
        return
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/workspace-apps/:appId/grant-requests/:requestId/cancel",
    { schema: successEnvelopeSchema, options: workspaceHook },
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
        return { success: cancelled }
      } catch (error) {
        handleError(reply, error)
        return
      }
    }
  )
}
