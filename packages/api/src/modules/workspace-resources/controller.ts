import { z } from "zod"
import type { FastifyInstance, FastifyReply } from "fastify"
import {
  actorRef,
  CAPABILITY_ACCESS_TARGET_TYPES,
  conversationRef,
  remoteAgentRef,
  SUBJECT_KIND,
  WORKSPACE_RESOURCE_KIND,
  WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTION,
  workspaceMemberRef,
  workspaceRef,
  type CapabilityAccessTarget,
  type WorkspaceResourceGrantPermission,
  type WorkspaceResourceKind,
} from "@synapse/shared"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { requireRequestAction } from "../access/guards.js"
import {
  approveWorkspaceResourceGrantRequest,
  cancelWorkspaceResourceGrantRequestByRequester,
  createWorkspaceResource,
  deleteWorkspaceResource,
  discoverWorkspaceResourcesForMember,
  getWorkspaceResourceInventoryDetail,
  listWorkspaceResourceGrantRecords,
  listWorkspaceResourceGrantRequestRecords,
  listWorkspaceResourcesInventory,
  rejectWorkspaceResourceGrantRequest,
  replaceWorkspaceResourceGrants,
  submitWorkspaceResourceGrantRequest,
  updateWorkspaceResource,
} from "./service.js"
import {
  presentGrant,
  presentGrantRequest,
  presentWorkspaceResource,
} from "./presenter.js"
import { appRoute } from "../../infrastructure/http/route.js"
import {
  WorkspaceResourceGrantTargetSchema,
  ReplaceWorkspaceResourceGrantsInputSchema,
  CreateWorkspaceResourceGrantRequestInputSchema,
  CreateWorkspaceResourceInputSchema,
  UpdateWorkspaceResourceInputSchema,
  WorkspaceResourceDiscoverQuerySchema,
  WorkspaceResourceEnvelopeViewSchema,
  WorkspaceResourceGrantRequestListQuerySchema,
  WorkspaceResourceListQuerySchema,
  WorkspaceResourceListViewSchema,
  WorkspaceResourceGrantListViewSchema,
  WorkspaceResourceGrantRequestListViewSchema,
  WorkspaceResourceGrantRequestEnvelopeViewSchema,
  WorkspaceResourceSuccessViewSchema,
} from "@synapse/shared/schemas"

const workspaceResourceEnvelopeSchema = WorkspaceResourceEnvelopeViewSchema
const workspaceResourcesEnvelopeSchema = WorkspaceResourceListViewSchema
const grantsEnvelopeSchema = WorkspaceResourceGrantListViewSchema
const grantRequestsEnvelopeSchema = WorkspaceResourceGrantRequestListViewSchema
const grantRequestEnvelopeSchema =
  WorkspaceResourceGrantRequestEnvelopeViewSchema
const successEnvelopeSchema = WorkspaceResourceSuccessViewSchema

// App-facing request bodies / queries live in @synapse/shared (§5.1.1) so the
// API parser and the web/mobile clients share one definition. The grant target
// schema feeds toCapabilityAccessTarget below (typed via z.infer).
const targetSchema = WorkspaceResourceGrantTargetSchema
const replaceGrantsSchema = ReplaceWorkspaceResourceGrantsInputSchema
const createGrantRequestSchema = CreateWorkspaceResourceGrantRequestInputSchema
const createWorkspaceResourceSchema = CreateWorkspaceResourceInputSchema
const updateWorkspaceResourceSchema = UpdateWorkspaceResourceInputSchema
const workspaceResourceListQuerySchema = WorkspaceResourceListQuerySchema
const workspaceResourceDiscoverQuerySchema =
  WorkspaceResourceDiscoverQuerySchema
const grantRequestListQuerySchema = WorkspaceResourceGrantRequestListQuerySchema

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
  if (/not found|does not belong to this workspace resource/i.test(message)) {
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

export function registerWorkspaceResourceRoutes(app: FastifyInstance) {
  const workspaceHook = { preHandler: [authMiddleware, workspaceMiddleware] }

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/workspace-resources",
    { schema: workspaceResourceEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string }
      try {
        const body = createWorkspaceResourceSchema.parse(request.body)
        const createAction =
          body.kind === WORKSPACE_RESOURCE_KIND.ACTOR
            ? "workspace.manage_actors"
            : body.kind === WORKSPACE_RESOURCE_KIND.REMOTE_AGENT
              ? "workspace.manage_remote_agents"
              : body.kind === WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL
                ? "workspace.manage_skills"
                : "workspace.manage_plugins"
        const allowed = await requireRequestAction(
          request,
          reply,
          createAction,
          workspaceId,
          "Not allowed to create this workspace resource"
        )
        if (!allowed) return
        const resource = await createWorkspaceResource({
          workspaceId,
          userId: (request as any).user.userId,
          input: {
            ...body,
            grants: body.grants?.map((grant) => ({
              target: toCapabilityAccessTarget(grant.target),
              permissions:
                grant.permissions as WorkspaceResourceGrantPermission[],
              conversationTypeMaskOverride:
                grant.conversationTypeMaskOverride ?? null,
              reason: grant.reason,
            })),
          } as any,
        })
        reply.status(201)
        return { resource: presentWorkspaceResource(resource) }
      } catch (error) {
        handleError(reply, error)
        return
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/workspace-resources",
    { schema: workspaceResourcesEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to view workspace resources in this workspace"
      )
      if (!allowed) return
      try {
        const query = workspaceResourceListQuerySchema.parse(
          request.query || {}
        )
        const resources = await listWorkspaceResourcesInventory({
          workspaceId,
          userId: (request as any).user.userId,
          kind: query.kind as WorkspaceResourceKind | undefined,
        })
        return { resources: resources.map(presentWorkspaceResource) }
      } catch (error) {
        handleError(reply, error)
        return
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/workspace-resources/discover",
    { schema: workspaceResourcesEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to discover workspace resources in this workspace"
      )
      if (!allowed) return
      try {
        const query = workspaceResourceDiscoverQuerySchema.parse(
          request.query || {}
        )
        const resources = await discoverWorkspaceResourcesForMember({
          workspaceId,
          userId: (request as any).user.userId,
          conversationId: query.conversationId,
        })
        return { resources: resources.map(presentWorkspaceResource) }
      } catch (error) {
        handleError(reply, error)
        return
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/workspace-resources/:resourceId",
    { schema: workspaceResourceEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      const { workspaceId, resourceId } = request.params as {
        workspaceId: string
        resourceId: string
      }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to view workspace resource details in this workspace"
      )
      if (!allowed) return
      try {
        const resource = await getWorkspaceResourceInventoryDetail({
          workspaceId,
          resourceId,
          userId: (request as any).user.userId,
        })
        return { resource: presentWorkspaceResource(resource) }
      } catch (error) {
        handleError(reply, error)
        return
      }
    }
  )

  appRoute(
    app,
    "PUT",
    "/api/v1/workspaces/:workspaceId/workspace-resources/:resourceId",
    { schema: workspaceResourceEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      const { workspaceId, resourceId } = request.params as {
        workspaceId: string
        resourceId: string
      }
      try {
        const body = updateWorkspaceResourceSchema.parse(request.body)
        const resource = await updateWorkspaceResource({
          workspaceId,
          resourceId,
          userId: (request as any).user.userId,
          input: body as any,
        })
        return { resource: presentWorkspaceResource(resource) }
      } catch (error) {
        handleError(reply, error)
        return
      }
    }
  )

  appRoute(
    app,
    "DELETE",
    "/api/v1/workspaces/:workspaceId/workspace-resources/:resourceId",
    { schema: successEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      const { workspaceId, resourceId } = request.params as {
        workspaceId: string
        resourceId: string
      }
      try {
        const deleted = await deleteWorkspaceResource({
          workspaceId,
          resourceId,
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
    "/api/v1/workspaces/:workspaceId/workspace-resources/:resourceId/grants",
    { schema: grantsEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      const { workspaceId, resourceId } = request.params as {
        workspaceId: string
        resourceId: string
      }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to view workspace resource grants in this workspace"
      )
      if (!allowed) return
      try {
        const grants = await listWorkspaceResourceGrantRecords({
          workspaceId,
          resourceId,
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
    "/api/v1/workspaces/:workspaceId/workspace-resources/:resourceId/grants",
    { schema: grantsEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      const { workspaceId, resourceId } = request.params as {
        workspaceId: string
        resourceId: string
      }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to manage workspace resource grants in this workspace"
      )
      if (!allowed) return
      try {
        const body = replaceGrantsSchema.parse(request.body)
        const grants = await replaceWorkspaceResourceGrants({
          workspaceId,
          resourceId,
          userId: (request as any).user.userId,
          grants: body.grants.map((grant) => ({
            target: toCapabilityAccessTarget(grant.target),
            permissions:
              grant.permissions as WorkspaceResourceGrantPermission[],
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
    "/api/v1/workspaces/:workspaceId/workspace-resources/:resourceId/grant-requests",
    { schema: grantRequestsEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      const { workspaceId, resourceId } = request.params as {
        workspaceId: string
        resourceId: string
      }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to view workspace resource grant requests in this workspace"
      )
      if (!allowed) return
      try {
        const query = grantRequestListQuerySchema.parse(request.query || {})
        const requests = await listWorkspaceResourceGrantRequestRecords({
          workspaceId,
          resourceId,
          userId: (request as any).user.userId,
          direction:
            query.direction ||
            WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTION.INCOMING,
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
    "/api/v1/workspaces/:workspaceId/workspace-resources/:resourceId/grant-requests",
    { schema: grantRequestEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      const { workspaceId, resourceId } = request.params as {
        workspaceId: string
        resourceId: string
      }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to request workspace resource access in this workspace"
      )
      if (!allowed) return
      try {
        const body = createGrantRequestSchema.parse(request.body || {})
        const grantRequest = await submitWorkspaceResourceGrantRequest({
          workspaceId,
          resourceId,
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
    "/api/v1/workspaces/:workspaceId/workspace-resources/:resourceId/grant-requests/:requestId/approve",
    { schema: grantRequestEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      const { workspaceId, resourceId, requestId } = request.params as {
        workspaceId: string
        resourceId: string
        requestId: string
      }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to resolve workspace resource grant requests in this workspace"
      )
      if (!allowed) return
      try {
        const grantRequest = await approveWorkspaceResourceGrantRequest({
          workspaceId,
          resourceId,
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
    "/api/v1/workspaces/:workspaceId/workspace-resources/:resourceId/grant-requests/:requestId/reject",
    { schema: grantRequestEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      const { workspaceId, resourceId, requestId } = request.params as {
        workspaceId: string
        resourceId: string
        requestId: string
      }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to resolve workspace resource grant requests in this workspace"
      )
      if (!allowed) return
      try {
        const grantRequest = await rejectWorkspaceResourceGrantRequest({
          workspaceId,
          resourceId,
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
    "/api/v1/workspaces/:workspaceId/workspace-resources/:resourceId/grant-requests/:requestId/cancel",
    { schema: successEnvelopeSchema, options: workspaceHook },
    async (request, reply) => {
      const { workspaceId, resourceId, requestId } = request.params as {
        workspaceId: string
        resourceId: string
        requestId: string
      }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.view",
        workspaceId,
        "Not allowed to cancel workspace resource grant requests in this workspace"
      )
      if (!allowed) return
      try {
        const cancelled = await cancelWorkspaceResourceGrantRequestByRequester({
          workspaceId,
          resourceId,
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
