import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { formatValidationDetails } from "../../infrastructure/validation-error.js"
import {
  SUBJECT_KIND,
  actorRef,
  conversationRef,
  type CapabilityAccessTarget,
  remoteAgentRef,
  workspaceMemberRef,
  workspaceRef,
} from "@synapse/shared"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { appRoute } from "../../infrastructure/http/route.js"
import { requireRequestAction } from "../access/guards.js"
import { workspaceMemberSubject } from "../access/service.js"
import type { AccessAction } from "../access/actions.js"
import * as service from "./service.js"
import { presentActorVersionRow } from "./presenter.js"
import {
  ActorPackageInstallInputSchema,
  ActorPackageInstallResultViewSchema,
  ActorPackageListViewSchema,
  ActorPackageListQuerySchema,
  ActorPackageRecordViewSchema,
  type ActorPackageInitialGrantTargetInput,
  ActorListViewSchema,
  ActorTreeViewSchema,
  ActorVersionListViewSchema,
  ActorViewSchema,
} from "@synapse/shared/schemas"

function toCapabilityAccessTarget(
  input: ActorPackageInitialGrantTargetInput
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

type WorkspaceParams = { workspaceId: string }

async function requireWorkspacePermission(
  request: FastifyRequest<{ Params: WorkspaceParams }>,
  reply: FastifyReply,
  action: AccessAction,
  errorMessage: string
) {
  return requireRequestAction(
    request,
    reply,
    action,
    request.params.workspaceId,
    errorMessage
  )
}

async function requireActorPermission(
  request: FastifyRequest,
  reply: FastifyReply,
  actorId: string,
  action: AccessAction,
  errorMessage: string
) {
  return requireRequestAction(request, reply, action, actorId, errorMessage)
}

export async function organizationController(app: FastifyInstance) {
  app.addHook("onRequest", authMiddleware)
  app.addHook("onRequest", workspaceMiddleware)

  appRoute(
    app,
    "GET",
    "/",
    { schema: ActorListViewSchema },
    async (request) => {
      const { workspaceId } = request.params as WorkspaceParams
      return service.listActors(
        workspaceId,
        workspaceMemberSubject((request as any).workspaceMember!.id)
      )
    }
  )

  appRoute(
    app,
    "GET",
    "/tree",
    { schema: ActorTreeViewSchema },
    async (request) => {
      const { workspaceId } = request.params as WorkspaceParams
      return service.getFullOrgTree(
        workspaceId,
        workspaceMemberSubject((request as any).workspaceMember!.id)
      )
    }
  )

  appRoute(
    app,
    "GET",
    "/packages",
    { schema: ActorPackageListViewSchema },
    async (request) => {
      const { workspaceId } = request.params as WorkspaceParams
      const { search } = ActorPackageListQuerySchema.parse(request.query || {})
      return service.listActorPackages({ workspaceId, search })
    }
  )

  appRoute(
    app,
    "GET",
    "/packages/:packageId",
    { schema: ActorPackageRecordViewSchema },
    async (request, reply) => {
      try {
        const { workspaceId, packageId } = request.params as WorkspaceParams & {
          packageId: string
        }
        return await service.getActorPackage(packageId, workspaceId)
      } catch (error) {
        reply.status(404).send({
          error:
            error instanceof Error ? error.message : "Actor package not found",
        })
        return undefined
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/packages/:packageId/install",
    { schema: ActorPackageInstallResultViewSchema },
    async (request, reply) => {
      const allowed = await requireWorkspacePermission(
        request as FastifyRequest<{ Params: WorkspaceParams }>,
        reply,
        "workspace.manage_actors",
        "Not allowed to manage actors"
      )
      if (!allowed) return undefined

      const parsed = ActorPackageInstallInputSchema.safeParse(request.body)
      if (!parsed.success) {
        reply.status(400).send({
          error: "Validation failed",
          details: formatValidationDetails(parsed.error),
        })
        return undefined
      }

      try {
        const { workspaceId, packageId } = request.params as WorkspaceParams & {
          packageId: string
        }
        const result = await service.installActorPackage({
          workspaceId,
          packageId,
          createdByWorkspaceMemberId: (request as any).workspaceMember!.id,
          displayName: parsed.data.displayName,
          title: parsed.data.title,
          parentId: parsed.data.parentId,
          syncMode: parsed.data.syncMode,
          grants: parsed.data.grants?.map((grant) => ({
            target: toCapabilityAccessTarget(grant.target),
            permissions: grant.permissions,
            conversationTypeMaskOverride:
              grant.conversationTypeMaskOverride ?? null,
            reason: grant.reason,
          })),
        })
        reply.status(201)
        return result
      } catch (error) {
        reply.status(400).send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to install actor package",
        })
        return undefined
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/:actorId/versions",
    { schema: ActorVersionListViewSchema },
    async (request, reply) => {
      const { workspaceId, actorId } = request.params as WorkspaceParams & {
        actorId: string
      }
      const allowed = await requireActorPermission(
        request,
        reply,
        actorId,
        "actor.view",
        "Not allowed to view this actor"
      )
      if (!allowed) return undefined

      const versions = await service.listActorVersions(actorId, workspaceId)
      return versions.map(({ row, docs }) => presentActorVersionRow(row, docs))
    }
  )

  appRoute(
    app,
    "GET",
    "/:actorId",
    { schema: ActorViewSchema },
    async (request, reply) => {
      const { workspaceId, actorId } = request.params as WorkspaceParams & {
        actorId: string
      }
      const allowed = await requireActorPermission(
        request,
        reply,
        actorId,
        "actor.view",
        "Not allowed to view this actor"
      )
      if (!allowed) return undefined

      const actor = await service.getActor(actorId, workspaceId)
      if (!actor) {
        reply.status(404).send({ error: "Actor not found" })
        return undefined
      }

      return actor
    }
  )
}
