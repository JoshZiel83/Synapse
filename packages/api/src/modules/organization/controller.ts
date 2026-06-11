import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import { formatValidationDetails } from "../../infrastructure/validation-error.js"
import {
  ACTOR_DOC_TEMPLATES,
  ACTOR_DOC_VISIBILITIES,
  ACTOR_PACKAGE_SYNC_MODES,
  ACTOR_ROLES,
  CAPABILITY_ACCESS_TARGET_TYPES,
  CANONICAL_FILE_CATEGORIES,
  SUBJECT_KIND,
  WORKSPACE_APP_GRANT_PERMISSIONS,
  actorRef,
  conversationRef,
  type ActorDoc,
  type CapabilityAccessTarget,
  type WorkspaceAppGrantPermission,
  remoteAgentRef,
  workspaceMemberRef,
  workspaceRef,
} from "@synapse/shared"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { requireRequestAction } from "../access/guards.js"
import { workspaceMemberSubject } from "../access/service.js"
import type { AccessAction } from "../access/actions.js"
import * as service from "./service.js"
import { presentActorVersionRow } from "./presenter.js"

const actorDocKeys = new Set(
  ACTOR_DOC_TEMPLATES.map((template) => template.key)
)

const contentBlockSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.uuid().optional(),
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    id: z.uuid().optional(),
    type: z.literal("file_ref"),
    sha256: z.string().length(64),
    path: z.string().min(1).optional(),
    mimeType: z.string(),
    name: z.string(),
    sizeBytes: z.number(),
    category: z.enum(CANONICAL_FILE_CATEGORIES),
  }),
])

const actorDocSchema = z.object({
  id: z.uuid().optional(),
  key: z.custom<ActorDoc["key"]>(
    (value) =>
      typeof value === "string" &&
      (actorDocKeys.has(value as any) || value === "custom"),
    { message: "Invalid actor doc key" }
  ),
  title: z.string().min(1).max(255),
  content: z.array(contentBlockSchema).default([]),
  visibility: z.enum(ACTOR_DOC_VISIBILITIES),
  priority: z.number().int().min(-1000).max(1000),
})

const workspaceAppGrantPermissionSchema = z.enum(
  WORKSPACE_APP_GRANT_PERMISSIONS
)
const initialGrantSubjectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(SUBJECT_KIND.WORKSPACE),
    workspaceId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.WORKSPACE_MEMBER),
    memberId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.CONVERSATION),
    conversationId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.ACTOR),
    actorId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.REMOTE_AGENT),
    remoteAgentId: z.uuid(),
  }),
])
const initialGrantTargetSchema = z.object({
  subject: initialGrantSubjectSchema,
  scope: z
    .object({
      kind: z.literal(SUBJECT_KIND.CONVERSATION),
      conversationId: z.uuid(),
    })
    .optional(),
})
const initialGrantSchema = z.object({
  target: initialGrantTargetSchema,
  permissions: z.array(workspaceAppGrantPermissionSchema).min(1),
  conversationTypeMaskOverride: z
    .number()
    .int()
    .min(1)
    .max(15)
    .nullable()
    .optional(),
  reason: z.string().trim().min(1).optional(),
})

function toCapabilityAccessTarget(
  input: z.infer<typeof initialGrantTargetSchema>
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

const installActorPackageSchema = z.object({
  displayName: z.string().min(1).max(255).optional(),
  title: z.string().max(255).optional(),
  parentId: z.uuid().nullable().optional(),
  syncMode: z.enum(ACTOR_PACKAGE_SYNC_MODES).default("notify"),
  grants: z.array(initialGrantSchema).optional(),
})

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

  app.get("/", async (request, reply) => {
    const { workspaceId } = request.params as WorkspaceParams
    const actors = await service.listActors(
      workspaceId,
      workspaceMemberSubject((request as any).workspaceMember!.id)
    )
    return reply.send(actors)
  })

  app.get("/tree", async (request, reply) => {
    const { workspaceId } = request.params as WorkspaceParams
    const tree = await service.getFullOrgTree(
      workspaceId,
      workspaceMemberSubject((request as any).workspaceMember!.id)
    )
    return reply.send(tree)
  })

  app.get("/packages", async (request, reply) => {
    const { workspaceId } = request.params as WorkspaceParams
    const { search } = request.query as { search?: string }
    const packages = await service.listActorPackages({ workspaceId, search })
    return reply.send(packages)
  })

  app.get("/packages/:packageId", async (request, reply) => {
    try {
      const { workspaceId, packageId } = request.params as WorkspaceParams & {
        packageId: string
      }
      const actorPackage = await service.getActorPackage(packageId, workspaceId)
      return reply.send(actorPackage)
    } catch (error) {
      return reply.status(404).send({
        error:
          error instanceof Error ? error.message : "Actor package not found",
      })
    }
  })

  app.post("/packages/:packageId/install", async (request, reply) => {
    const allowed = await requireWorkspacePermission(
      request as FastifyRequest<{ Params: WorkspaceParams }>,
      reply,
      "workspace.manage_actors",
      "Not allowed to manage actors"
    )
    if (!allowed) return

    const parsed = installActorPackageSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: formatValidationDetails(parsed.error),
      })
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
          permissions: grant.permissions as WorkspaceAppGrantPermission[],
          conversationTypeMaskOverride:
            grant.conversationTypeMaskOverride ?? null,
          reason: grant.reason,
        })),
      })
      return reply.status(201).send(result)
    } catch (error) {
      return reply.status(400).send({
        error:
          error instanceof Error
            ? error.message
            : "Failed to install actor package",
      })
    }
  })

  app.get("/:actorId/versions", async (request, reply) => {
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
    if (!allowed) return

    const versions = await service.listActorVersions(actorId, workspaceId)
    return reply.send(
      versions.map(({ row, docs }) => presentActorVersionRow(row, docs))
    )
  })

  app.get("/:actorId", async (request, reply) => {
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
    if (!allowed) return

    const actor = await service.getActor(actorId, workspaceId)
    if (!actor) {
      return reply.status(404).send({ error: "Actor not found" })
    }

    return reply.send(actor)
  })
}
