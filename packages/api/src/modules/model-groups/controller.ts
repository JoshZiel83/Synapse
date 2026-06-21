import { z } from "zod"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { PLATFORM_RESOURCE_ID } from "../access/evaluator.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import {
  requireRequestAction,
  authorizeActionDefault,
} from "../access/guards.js"
import { userSubject, workspaceMemberSubject } from "../access/service.js"
import {
  addModelItem,
  createModelGroup,
  deleteModelGroup,
  deleteModelItem,
  getActorModelGroups,
  getItemVersions,
  getModelGroup,
  isModelGroupAvailableInWorkspace,
  issueModelGroupGrant,
  listModelGroupGrants,
  listPlatformModelGroups,
  listWorkspaceMemberOwnedModelGroups,
  listVisibleActorModelGroups,
  listWorkspaceModelGroups,
  ModelGroupError,
  revokeModelGroupGrant,
  setActorModelGroups,
  updateModelGroup,
  updateModelItem,
} from "./service.js"

import {
  presentActorModelGroup,
  presentGrantRow,
  presentGroupDetail,
  presentGroupItem,
  presentGroupRow,
  presentItemVersion,
} from "./presenter.js"
import {
  ActorModelGroupAssignmentListViewSchema,
  ActorModelGroupSetInputSchema as setActorGroupsSchema,
  ModelGroupCreateInputSchema as createGroupSchema,
  ModelGroupDetailViewSchema,
  ModelGroupGrantIssueInputSchema as issueGrantSchema,
  ModelGroupGrantListViewSchema,
  ModelGroupGrantViewSchema,
  ModelGroupItemCreateInputSchema as addItemSchema,
  ModelGroupItemUpdateInputSchema as updateItemSchema,
  ModelGroupItemVersionListViewSchema,
  ModelGroupItemViewSchema,
  ModelGroupListViewSchema,
  ModelGroupUpdateInputSchema as updateGroupSchema,
  ModelGroupViewSchema,
} from "@synapse/shared/schemas"
import { appRoute } from "../../infrastructure/http/route.js"

function handleError(error: unknown, reply: FastifyReply) {
  if (error instanceof ModelGroupError) {
    reply.status(error.statusCode).send({ error: error.message })
    return undefined
  }
  if (error instanceof z.ZodError) {
    reply.status(400).send({
      error: "Validation failed",
      details: error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    })
    return undefined
  }
  throw error
}

function created<T>(reply: FastifyReply, value: T): T {
  reply.status(201)
  return value
}

function sendNoContent(reply: FastifyReply): undefined {
  reply.status(204).send()
  return undefined
}

async function requireWorkspacePermission(
  request: FastifyRequest<{ Params: { workspaceId: string } }>,
  reply: FastifyReply,
  permission: "view" | "manage_models",
  errorMessage: string
) {
  const { workspaceId } = request.params
  return requireRequestAction(
    request,
    reply,
    permission === "view" ? "workspace.view" : "workspace.manage_models",
    workspaceId,
    errorMessage
  )
}

async function requireActorPermission(
  request: FastifyRequest<{ Params: { workspaceId: string; actorId: string } }>,
  reply: FastifyReply,
  permission: "view" | "edit",
  errorMessage: string
) {
  const { actorId } = request.params
  return requireRequestAction(
    request,
    reply,
    permission === "view" ? "actor.view" : "actor.edit",
    actorId,
    errorMessage
  )
}

async function requirePlatformPermission(
  request: FastifyRequest,
  reply: FastifyReply,
  _permission: "manage_models",
  errorMessage: string
) {
  return requireRequestAction(
    request,
    reply,
    "platform.manage_models",
    PLATFORM_RESOURCE_ID,
    errorMessage
  )
}

async function requireModelGroupPermission(
  principalId: string,
  groupId: string,
  permission: "view" | "edit" | "grant" | "delete",
  reply: FastifyReply,
  errorMessage: string,
  workspaceId?: string
) {
  const resolveAction = () => {
    switch (permission) {
      case "view":
        return "model_group.view"
      case "edit":
        return "model_group.edit"
      case "grant":
        return "model_group.grant"
      default:
        return "model_group.delete"
    }
  }
  const action = resolveAction()
  const allowed = await authorizeActionDefault({
    subject: workspaceId
      ? workspaceMemberSubject(principalId)
      : userSubject(principalId),
    action,
    resourceId: groupId,
  })

  if (!allowed) {
    reply.status(403).send({ error: errorMessage })
    return false
  }

  return true
}

async function requireWorkspaceVisibleGroup(
  request: FastifyRequest<{ Params: { workspaceId: string; groupId: string } }>,
  reply: FastifyReply
) {
  const { workspaceId, groupId } = request.params
  const visible = await isModelGroupAvailableInWorkspace(groupId, workspaceId)
  if (!visible) {
    reply.status(404).send({ error: "Model group not found" })
    return null
  }
  return getModelGroup(groupId)
}

async function requirePlatformGroup(
  request: FastifyRequest<{ Params: { groupId: string } }>,
  reply: FastifyReply
) {
  const group = await getModelGroup(request.params.groupId)
  if (group.ownerType !== "platform") {
    reply.status(404).send({ error: "Model group not found" })
    return null
  }
  return group
}

async function requireWorkspaceMemberOwnedGroup(
  request: FastifyRequest<{ Params: { workspaceId: string; groupId: string } }>,
  reply: FastifyReply
) {
  const workspaceMemberId = (request as any).workspaceMember?.id as
    | string
    | undefined
  if (!workspaceMemberId) {
    reply.status(403).send({ error: "Workspace member not found" })
    return null
  }
  const group = await getModelGroup(request.params.groupId)
  if (
    group.ownerType !== "workspace_member" ||
    group.ownerWorkspaceMemberId !== workspaceMemberId
  ) {
    reply.status(404).send({ error: "Model group not found" })
    return null
  }
  return group
}

export function registerModelGroupRoutes(app: FastifyInstance) {
  const wsPrefix = "/api/v1/workspaces/:workspaceId/model-groups"
  const platformPrefix = "/api/v1/platform/model-groups"
  const workspaceMemberPrefix =
    "/api/v1/workspaces/:workspaceId/me/model-groups"
  const wsPreHandler = [authMiddleware, workspaceMiddleware]
  const authPreHandler = [authMiddleware]
  const noContentResponseSchema = z.undefined()

  appRoute(
    app,
    "GET",
    wsPrefix,
    {
      schema: ModelGroupListViewSchema,
      options: { preHandler: wsPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request as FastifyRequest<{ Params: { workspaceId: string } }>,
          reply,
          "manage_models",
          "Not allowed to manage model groups in this workspace"
        )
        if (!allowed) return

        const { workspaceId } = request.params as { workspaceId: string }
        const groups = await listWorkspaceModelGroups(workspaceId)
        return groups.map(presentGroupRow)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "POST",
    wsPrefix,
    { schema: ModelGroupViewSchema, options: { preHandler: wsPreHandler } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requireWorkspacePermission(
          request as FastifyRequest<{ Params: { workspaceId: string } }>,
          reply,
          "manage_models",
          "Not allowed to manage model groups in this workspace"
        )
        if (!allowed) return

        const { workspaceId } = request.params as { workspaceId: string }
        const body = createGroupSchema.parse(request.body)
        const workspaceMemberId = (request as any).workspaceMember?.id as string
        const group = await createModelGroup({
          ...body,
          ownerType: "workspace",
          workspaceId,
          createdByWorkspaceMemberId: workspaceMemberId,
        })
        return created(reply, presentGroupRow(group))
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "GET",
    `${wsPrefix}/:groupId`,
    {
      schema: ModelGroupDetailViewSchema,
      options: { preHandler: wsPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const workspaceAllowed = await requireWorkspacePermission(
          request as FastifyRequest<{ Params: { workspaceId: string } }>,
          reply,
          "manage_models",
          "Not allowed to manage model groups in this workspace"
        )
        if (!workspaceAllowed) return

        const group = await requireWorkspaceVisibleGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!group) return

        const workspaceMemberId = (request as any).workspaceMember?.id as string
        const groupAllowed = await requireModelGroupPermission(
          workspaceMemberId,
          group.id,
          "view",
          reply,
          "Not allowed to view this model group",
          (request.params as any).workspaceId
        )
        if (!groupAllowed) return

        return presentGroupDetail(group)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "PUT",
    `${wsPrefix}/:groupId`,
    {
      schema: ModelGroupDetailViewSchema,
      options: { preHandler: wsPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const workspaceAllowed = await requireWorkspacePermission(
          request as FastifyRequest<{ Params: { workspaceId: string } }>,
          reply,
          "manage_models",
          "Not allowed to manage model groups in this workspace"
        )
        if (!workspaceAllowed) return

        const scopedGroup = await requireWorkspaceVisibleGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!scopedGroup) return

        const workspaceMemberId = (request as any).workspaceMember?.id as string
        const groupAllowed = await requireModelGroupPermission(
          workspaceMemberId,
          scopedGroup.id,
          "edit",
          reply,
          "Not allowed to edit this model group",
          (request.params as any).workspaceId
        )
        if (!groupAllowed) return

        const body = updateGroupSchema.parse(request.body)
        const group = await updateModelGroup(scopedGroup.id, body)
        return presentGroupDetail(group)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "DELETE",
    `${wsPrefix}/:groupId`,
    { schema: noContentResponseSchema, options: { preHandler: wsPreHandler } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const workspaceAllowed = await requireWorkspacePermission(
          request as FastifyRequest<{ Params: { workspaceId: string } }>,
          reply,
          "manage_models",
          "Not allowed to manage model groups in this workspace"
        )
        if (!workspaceAllowed) return

        const scopedGroup = await requireWorkspaceVisibleGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!scopedGroup) return

        const workspaceMemberId = (request as any).workspaceMember?.id as string
        const groupAllowed = await requireModelGroupPermission(
          workspaceMemberId,
          scopedGroup.id,
          "delete",
          reply,
          "Not allowed to delete this model group",
          (request.params as any).workspaceId
        )
        if (!groupAllowed) return

        await deleteModelGroup(scopedGroup.id)
        return sendNoContent(reply)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "GET",
    `${wsPrefix}/:groupId/grants`,
    {
      schema: ModelGroupGrantListViewSchema,
      options: { preHandler: wsPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const workspaceAllowed = await requireWorkspacePermission(
          request as FastifyRequest<{ Params: { workspaceId: string } }>,
          reply,
          "manage_models",
          "Not allowed to manage model groups in this workspace"
        )
        if (!workspaceAllowed) return

        const group = await requireWorkspaceVisibleGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!group) return

        const workspaceMemberId = (request as any).workspaceMember?.id as string
        const groupAllowed = await requireModelGroupPermission(
          workspaceMemberId,
          group.id,
          "grant",
          reply,
          "Not allowed to manage grants for this model group",
          (request.params as any).workspaceId
        )
        if (!groupAllowed) return

        const grants = await listModelGroupGrants(group.id)
        return grants.map(presentGrantRow)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "POST",
    `${wsPrefix}/:groupId/grants`,
    {
      schema: ModelGroupGrantViewSchema,
      options: { preHandler: wsPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const workspaceAllowed = await requireWorkspacePermission(
          request as FastifyRequest<{ Params: { workspaceId: string } }>,
          reply,
          "manage_models",
          "Not allowed to manage model groups in this workspace"
        )
        if (!workspaceAllowed) return

        const group = await requireWorkspaceVisibleGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!group) return

        const workspaceMemberId = (request as any).workspaceMember?.id as string
        const groupAllowed = await requireModelGroupPermission(
          workspaceMemberId,
          group.id,
          "grant",
          reply,
          "Not allowed to manage grants for this model group",
          (request.params as any).workspaceId
        )
        if (!groupAllowed) return

        const body = issueGrantSchema.parse(request.body)
        const grant = await issueModelGroupGrant(group.id, {
          ...body,
          createdByWorkspaceMemberId: workspaceMemberId,
        })
        return created(reply, presentGrantRow(grant))
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "POST",
    `${wsPrefix}/:groupId/grants/:grantId/revoke`,
    { schema: noContentResponseSchema, options: { preHandler: wsPreHandler } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const workspaceAllowed = await requireWorkspacePermission(
          request as FastifyRequest<{ Params: { workspaceId: string } }>,
          reply,
          "manage_models",
          "Not allowed to manage model groups in this workspace"
        )
        if (!workspaceAllowed) return

        const group = await requireWorkspaceVisibleGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!group) return

        const workspaceMemberId = (request as any).workspaceMember?.id as string
        const groupAllowed = await requireModelGroupPermission(
          workspaceMemberId,
          group.id,
          "grant",
          reply,
          "Not allowed to manage grants for this model group",
          (request.params as any).workspaceId
        )
        if (!groupAllowed) return

        const { grantId } = request.params as { grantId: string }
        await revokeModelGroupGrant(group.id, grantId)
        return sendNoContent(reply)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "POST",
    `${wsPrefix}/:groupId/items`,
    {
      schema: ModelGroupItemViewSchema,
      options: { preHandler: wsPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const workspaceAllowed = await requireWorkspacePermission(
          request as FastifyRequest<{ Params: { workspaceId: string } }>,
          reply,
          "manage_models",
          "Not allowed to manage model groups in this workspace"
        )
        if (!workspaceAllowed) return

        const group = await requireWorkspaceVisibleGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!group) return

        const workspaceMemberId = (request as any).workspaceMember?.id as string
        const groupAllowed = await requireModelGroupPermission(
          workspaceMemberId,
          group.id,
          "edit",
          reply,
          "Not allowed to edit this model group",
          (request.params as any).workspaceId
        )
        if (!groupAllowed) return

        const body = addItemSchema.parse(request.body)
        const item = await addModelItem(group.id, {
          ...body,
          installedByWorkspaceMemberId: workspaceMemberId,
        })
        return created(reply, presentGroupItem(item))
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "PUT",
    `${wsPrefix}/:groupId/items/:itemId`,
    {
      schema: ModelGroupItemViewSchema,
      options: { preHandler: wsPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const workspaceAllowed = await requireWorkspacePermission(
          request as FastifyRequest<{ Params: { workspaceId: string } }>,
          reply,
          "manage_models",
          "Not allowed to manage model groups in this workspace"
        )
        if (!workspaceAllowed) return

        const group = await requireWorkspaceVisibleGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!group) return

        const workspaceMemberId = (request as any).workspaceMember?.id as string
        const groupAllowed = await requireModelGroupPermission(
          workspaceMemberId,
          group.id,
          "edit",
          reply,
          "Not allowed to edit this model group",
          (request.params as any).workspaceId
        )
        if (!groupAllowed) return

        const { itemId } = request.params as { itemId: string }
        const body = updateItemSchema.parse(request.body)
        const item = await updateModelItem(group.id, itemId, body)
        return presentGroupItem(item)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "DELETE",
    `${wsPrefix}/:groupId/items/:itemId`,
    { schema: noContentResponseSchema, options: { preHandler: wsPreHandler } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const workspaceAllowed = await requireWorkspacePermission(
          request as FastifyRequest<{ Params: { workspaceId: string } }>,
          reply,
          "manage_models",
          "Not allowed to manage model groups in this workspace"
        )
        if (!workspaceAllowed) return

        const group = await requireWorkspaceVisibleGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!group) return

        const workspaceMemberId = (request as any).workspaceMember?.id as string
        const groupAllowed = await requireModelGroupPermission(
          workspaceMemberId,
          group.id,
          "edit",
          reply,
          "Not allowed to edit this model group",
          (request.params as any).workspaceId
        )
        if (!groupAllowed) return

        const { itemId } = request.params as { itemId: string }
        await deleteModelItem(group.id, itemId)
        return sendNoContent(reply)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "GET",
    `${wsPrefix}/:groupId/items/:itemId/versions`,
    {
      schema: ModelGroupItemVersionListViewSchema,
      options: { preHandler: wsPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const workspaceAllowed = await requireWorkspacePermission(
          request as FastifyRequest<{ Params: { workspaceId: string } }>,
          reply,
          "manage_models",
          "Not allowed to manage model groups in this workspace"
        )
        if (!workspaceAllowed) return

        const group = await requireWorkspaceVisibleGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!group) return

        const workspaceMemberId = (request as any).workspaceMember?.id as string
        const groupAllowed = await requireModelGroupPermission(
          workspaceMemberId,
          group.id,
          "view",
          reply,
          "Not allowed to view this model group",
          (request.params as any).workspaceId
        )
        if (!groupAllowed) return

        const { itemId } = request.params as { itemId: string }
        const versions = await getItemVersions(itemId, group.id)
        return versions.map(presentItemVersion)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/actors/:actorId/model-groups",
    {
      schema: ActorModelGroupAssignmentListViewSchema,
      options: { preHandler: wsPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const workspaceAllowed = await requireWorkspacePermission(
          request as FastifyRequest<{ Params: { workspaceId: string } }>,
          reply,
          "manage_models",
          "Not allowed to manage model groups in this workspace"
        )
        if (!workspaceAllowed) return

        const actorAllowed = await requireActorPermission(
          request as FastifyRequest<{
            Params: { workspaceId: string; actorId: string }
          }>,
          reply,
          "view",
          "Not allowed to view this actor"
        )
        if (!actorAllowed) return

        const { actorId, workspaceId } = request.params as {
          actorId: string
          workspaceId: string
        }
        const groups = await getActorModelGroups(actorId, workspaceId)
        return groups.map(presentActorModelGroup)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/actors/:actorId/model-groups/visible",
    {
      schema: ModelGroupListViewSchema,
      options: { preHandler: wsPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const workspaceAllowed = await requireWorkspacePermission(
          request as FastifyRequest<{ Params: { workspaceId: string } }>,
          reply,
          "manage_models",
          "Not allowed to manage model groups in this workspace"
        )
        if (!workspaceAllowed) return

        const actorAllowed = await requireActorPermission(
          request as FastifyRequest<{
            Params: { workspaceId: string; actorId: string }
          }>,
          reply,
          "view",
          "Not allowed to view this actor"
        )
        if (!actorAllowed) return

        const { actorId, workspaceId } = request.params as {
          actorId: string
          workspaceId: string
        }
        const groups = await listVisibleActorModelGroups(actorId, workspaceId)
        return groups.map(presentGroupRow)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "PUT",
    "/api/v1/workspaces/:workspaceId/actors/:actorId/model-groups",
    {
      schema: ActorModelGroupAssignmentListViewSchema,
      options: { preHandler: wsPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const workspaceAllowed = await requireWorkspacePermission(
          request as FastifyRequest<{ Params: { workspaceId: string } }>,
          reply,
          "manage_models",
          "Not allowed to manage model groups in this workspace"
        )
        if (!workspaceAllowed) return

        const actorAllowed = await requireActorPermission(
          request as FastifyRequest<{
            Params: { workspaceId: string; actorId: string }
          }>,
          reply,
          "edit",
          "Not allowed to edit this actor"
        )
        if (!actorAllowed) return

        const { actorId, workspaceId } = request.params as {
          actorId: string
          workspaceId: string
        }
        const body = setActorGroupsSchema.parse(request.body)
        const groups = await setActorModelGroups(
          actorId,
          workspaceId,
          body.groups
        )
        return groups.map(presentActorModelGroup)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "GET",
    platformPrefix,
    {
      schema: ModelGroupListViewSchema,
      options: { preHandler: authPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requirePlatformPermission(
          request,
          reply,
          "manage_models",
          "Not allowed to manage platform model groups"
        )
        if (!allowed) return

        const groups = await listPlatformModelGroups()
        return groups.map(presentGroupRow)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "POST",
    platformPrefix,
    { schema: ModelGroupViewSchema, options: { preHandler: authPreHandler } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requirePlatformPermission(
          request,
          reply,
          "manage_models",
          "Not allowed to manage platform model groups"
        )
        if (!allowed) return

        const body = createGroupSchema.parse(request.body)
        const group = await createModelGroup({
          ...body,
          ownerType: "platform",
        })
        return created(reply, presentGroupRow(group))
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "GET",
    `${platformPrefix}/:groupId`,
    {
      schema: ModelGroupDetailViewSchema,
      options: { preHandler: authPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requirePlatformPermission(
          request,
          reply,
          "manage_models",
          "Not allowed to manage platform model groups"
        )
        if (!allowed) return

        const group = await requirePlatformGroup(
          request as FastifyRequest<{ Params: { groupId: string } }>,
          reply
        )
        if (!group) return

        return presentGroupDetail(group)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "PUT",
    `${platformPrefix}/:groupId`,
    {
      schema: ModelGroupDetailViewSchema,
      options: { preHandler: authPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requirePlatformPermission(
          request,
          reply,
          "manage_models",
          "Not allowed to manage platform model groups"
        )
        if (!allowed) return

        const group = await requirePlatformGroup(
          request as FastifyRequest<{ Params: { groupId: string } }>,
          reply
        )
        if (!group) return

        const userId = (request as any).user.userId
        const groupAllowed = await requireModelGroupPermission(
          userId,
          group.id,
          "edit",
          reply,
          "Not allowed to edit this model group"
        )
        if (!groupAllowed) return

        const body = updateGroupSchema.parse(request.body)
        const updated = await updateModelGroup(group.id, body)
        return presentGroupDetail(updated)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "DELETE",
    `${platformPrefix}/:groupId`,
    {
      schema: noContentResponseSchema,
      options: { preHandler: authPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requirePlatformPermission(
          request,
          reply,
          "manage_models",
          "Not allowed to manage platform model groups"
        )
        if (!allowed) return

        const group = await requirePlatformGroup(
          request as FastifyRequest<{ Params: { groupId: string } }>,
          reply
        )
        if (!group) return

        const userId = (request as any).user.userId
        const groupAllowed = await requireModelGroupPermission(
          userId,
          group.id,
          "delete",
          reply,
          "Not allowed to delete this model group"
        )
        if (!groupAllowed) return

        await deleteModelGroup(group.id)
        return sendNoContent(reply)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "GET",
    `${platformPrefix}/:groupId/grants`,
    {
      schema: ModelGroupGrantListViewSchema,
      options: { preHandler: authPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requirePlatformPermission(
          request,
          reply,
          "manage_models",
          "Not allowed to manage platform model groups"
        )
        if (!allowed) return

        const group = await requirePlatformGroup(
          request as FastifyRequest<{ Params: { groupId: string } }>,
          reply
        )
        if (!group) return

        const grants = await listModelGroupGrants(group.id)
        return grants.map(presentGrantRow)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "POST",
    `${platformPrefix}/:groupId/grants`,
    {
      schema: ModelGroupGrantViewSchema,
      options: { preHandler: authPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requirePlatformPermission(
          request,
          reply,
          "manage_models",
          "Not allowed to manage platform model groups"
        )
        if (!allowed) return

        const group = await requirePlatformGroup(
          request as FastifyRequest<{ Params: { groupId: string } }>,
          reply
        )
        if (!group) return

        const body = issueGrantSchema.parse(request.body)
        const grant = await issueModelGroupGrant(group.id, {
          ...body,
        })
        return created(reply, presentGrantRow(grant))
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "POST",
    `${platformPrefix}/:groupId/grants/:grantId/revoke`,
    {
      schema: noContentResponseSchema,
      options: { preHandler: authPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requirePlatformPermission(
          request,
          reply,
          "manage_models",
          "Not allowed to manage platform model groups"
        )
        if (!allowed) return

        const group = await requirePlatformGroup(
          request as FastifyRequest<{ Params: { groupId: string } }>,
          reply
        )
        if (!group) return

        const { grantId } = request.params as { grantId: string }
        await revokeModelGroupGrant(group.id, grantId)
        return sendNoContent(reply)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "POST",
    `${platformPrefix}/:groupId/items`,
    {
      schema: ModelGroupItemViewSchema,
      options: { preHandler: authPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requirePlatformPermission(
          request,
          reply,
          "manage_models",
          "Not allowed to manage platform model groups"
        )
        if (!allowed) return

        const group = await requirePlatformGroup(
          request as FastifyRequest<{ Params: { groupId: string } }>,
          reply
        )
        if (!group) return

        const userId = (request as any).user.userId
        const groupAllowed = await requireModelGroupPermission(
          userId,
          group.id,
          "edit",
          reply,
          "Not allowed to edit this model group"
        )
        if (!groupAllowed) return

        const body = addItemSchema.parse(request.body)
        const item = await addModelItem(group.id, {
          ...body,
        })
        return created(reply, presentGroupItem(item))
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "PUT",
    `${platformPrefix}/:groupId/items/:itemId`,
    {
      schema: ModelGroupItemViewSchema,
      options: { preHandler: authPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requirePlatformPermission(
          request,
          reply,
          "manage_models",
          "Not allowed to manage platform model groups"
        )
        if (!allowed) return

        const group = await requirePlatformGroup(
          request as FastifyRequest<{ Params: { groupId: string } }>,
          reply
        )
        if (!group) return

        const userId = (request as any).user.userId
        const groupAllowed = await requireModelGroupPermission(
          userId,
          group.id,
          "edit",
          reply,
          "Not allowed to edit this model group"
        )
        if (!groupAllowed) return

        const { itemId } = request.params as { itemId: string }
        const body = updateItemSchema.parse(request.body)
        const item = await updateModelItem(group.id, itemId, body)
        return presentGroupItem(item)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "DELETE",
    `${platformPrefix}/:groupId/items/:itemId`,
    {
      schema: noContentResponseSchema,
      options: { preHandler: authPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requirePlatformPermission(
          request,
          reply,
          "manage_models",
          "Not allowed to manage platform model groups"
        )
        if (!allowed) return

        const group = await requirePlatformGroup(
          request as FastifyRequest<{ Params: { groupId: string } }>,
          reply
        )
        if (!group) return

        const userId = (request as any).user.userId
        const groupAllowed = await requireModelGroupPermission(
          userId,
          group.id,
          "edit",
          reply,
          "Not allowed to edit this model group"
        )
        if (!groupAllowed) return

        const { itemId } = request.params as { itemId: string }
        await deleteModelItem(group.id, itemId)
        return sendNoContent(reply)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "GET",
    `${platformPrefix}/:groupId/items/:itemId/versions`,
    {
      schema: ModelGroupItemVersionListViewSchema,
      options: { preHandler: authPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const allowed = await requirePlatformPermission(
          request,
          reply,
          "manage_models",
          "Not allowed to manage platform model groups"
        )
        if (!allowed) return

        const group = await requirePlatformGroup(
          request as FastifyRequest<{ Params: { groupId: string } }>,
          reply
        )
        if (!group) return

        const { itemId } = request.params as { itemId: string }
        const versions = await getItemVersions(itemId, group.id)
        return versions.map(presentItemVersion)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "GET",
    workspaceMemberPrefix,
    {
      schema: ModelGroupListViewSchema,
      options: { preHandler: wsPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const workspaceMemberId = (request as any).workspaceMember?.id as string
        const groups =
          await listWorkspaceMemberOwnedModelGroups(workspaceMemberId)
        return groups.map(presentGroupRow)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "POST",
    workspaceMemberPrefix,
    { schema: ModelGroupViewSchema, options: { preHandler: wsPreHandler } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = createGroupSchema.parse(request.body)
        const workspaceMemberId = (request as any).workspaceMember?.id as string
        const group = await createModelGroup({
          ...body,
          ownerType: "workspace_member",
          ownerWorkspaceMemberId: workspaceMemberId,
          createdByWorkspaceMemberId: workspaceMemberId,
        })
        return created(reply, presentGroupRow(group))
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "GET",
    `${workspaceMemberPrefix}/:groupId`,
    {
      schema: ModelGroupDetailViewSchema,
      options: { preHandler: wsPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const group = await requireWorkspaceMemberOwnedGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!group) return
        return presentGroupDetail(group)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "PUT",
    `${workspaceMemberPrefix}/:groupId`,
    {
      schema: ModelGroupDetailViewSchema,
      options: { preHandler: wsPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const workspaceId = (request.params as any).workspaceId as string
        const group = await requireWorkspaceMemberOwnedGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!group) return

        const workspaceMemberId = (request as any).workspaceMember?.id as string
        const groupAllowed = await requireModelGroupPermission(
          workspaceMemberId,
          group.id,
          "edit",
          reply,
          "Not allowed to edit this model group",
          workspaceId
        )
        if (!groupAllowed) return

        const body = updateGroupSchema.parse(request.body)
        const updated = await updateModelGroup(group.id, body)
        return presentGroupDetail(updated)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "DELETE",
    `${workspaceMemberPrefix}/:groupId`,
    { schema: noContentResponseSchema, options: { preHandler: wsPreHandler } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const workspaceId = (request.params as any).workspaceId as string
        const group = await requireWorkspaceMemberOwnedGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!group) return

        const workspaceMemberId = (request as any).workspaceMember?.id as string
        const groupAllowed = await requireModelGroupPermission(
          workspaceMemberId,
          group.id,
          "delete",
          reply,
          "Not allowed to delete this model group",
          workspaceId
        )
        if (!groupAllowed) return

        await deleteModelGroup(group.id)
        return sendNoContent(reply)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "GET",
    `${workspaceMemberPrefix}/:groupId/grants`,
    {
      schema: ModelGroupGrantListViewSchema,
      options: { preHandler: wsPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const group = await requireWorkspaceMemberOwnedGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!group) return

        const grants = await listModelGroupGrants(group.id)
        return grants.map(presentGrantRow)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "POST",
    `${workspaceMemberPrefix}/:groupId/grants`,
    {
      schema: ModelGroupGrantViewSchema,
      options: { preHandler: wsPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const group = await requireWorkspaceMemberOwnedGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!group) return

        const body = issueGrantSchema.parse(request.body)
        const grant = await issueModelGroupGrant(group.id, {
          ...body,
          createdByWorkspaceMemberId: (request as any).workspaceMember
            ?.id as string,
        })
        return created(reply, presentGrantRow(grant))
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "POST",
    `${workspaceMemberPrefix}/:groupId/grants/:grantId/revoke`,
    { schema: noContentResponseSchema, options: { preHandler: wsPreHandler } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const group = await requireWorkspaceMemberOwnedGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!group) return

        const { grantId } = request.params as { grantId: string }
        await revokeModelGroupGrant(group.id, grantId)
        return sendNoContent(reply)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "POST",
    `${workspaceMemberPrefix}/:groupId/items`,
    {
      schema: ModelGroupItemViewSchema,
      options: { preHandler: wsPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const group = await requireWorkspaceMemberOwnedGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!group) return

        const body = addItemSchema.parse(request.body)
        const item = await addModelItem(group.id, {
          ...body,
          installedByWorkspaceMemberId: (request as any).workspaceMember
            ?.id as string,
        })
        return created(reply, presentGroupItem(item))
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "PUT",
    `${workspaceMemberPrefix}/:groupId/items/:itemId`,
    {
      schema: ModelGroupItemViewSchema,
      options: { preHandler: wsPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const group = await requireWorkspaceMemberOwnedGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!group) return

        const { itemId } = request.params as { itemId: string }
        const body = updateItemSchema.parse(request.body)
        const item = await updateModelItem(group.id, itemId, body)
        return presentGroupItem(item)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "DELETE",
    `${workspaceMemberPrefix}/:groupId/items/:itemId`,
    { schema: noContentResponseSchema, options: { preHandler: wsPreHandler } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const group = await requireWorkspaceMemberOwnedGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!group) return

        const { itemId } = request.params as { itemId: string }
        await deleteModelItem(group.id, itemId)
        return sendNoContent(reply)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )

  appRoute(
    app,
    "GET",
    `${workspaceMemberPrefix}/:groupId/items/:itemId/versions`,
    {
      schema: ModelGroupItemVersionListViewSchema,
      options: { preHandler: wsPreHandler },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const group = await requireWorkspaceMemberOwnedGroup(
          request as FastifyRequest<{
            Params: { workspaceId: string; groupId: string }
          }>,
          reply
        )
        if (!group) return

        const { itemId } = request.params as { itemId: string }
        const versions = await getItemVersions(itemId, group.id)
        return versions.map(presentItemVersion)
      } catch (error) {
        return handleError(error, reply)
      }
    }
  )
}
