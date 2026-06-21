import { z } from "zod"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import {
  actorRef,
  conversationRef,
  remoteAgentRef,
  SUBJECT_KIND,
  workspaceMemberRef,
  workspaceRef,
  type CapabilityAccessTarget,
} from "@synapse/shared"
import {
  ImportMarketplaceSkillInputSchema,
  InstalledSkillItemViewSchema,
  InstalledSkillListQuerySchema,
  InstalledSkillListViewSchema,
  PublishMarketplaceSkillInputSchema,
  SkillMarketplaceItemQuerySchema,
  SkillMarketplaceItemViewSchema,
  SkillMarketplaceListQuerySchema,
  SkillMarketplaceListViewSchema,
} from "@synapse/shared/schemas"
import { appRoute } from "../../infrastructure/http/route.js"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { PLATFORM_RESOURCE_ID } from "../access/evaluator.js"
import {
  requireRequestAction,
  authorizeActionDefault,
  listAuthorizedResourceIdsDefault,
  resolveWorkspaceAccessSubjectDefault,
} from "../access/guards.js"
import { getRequestAccessSubject, getRequestUserId } from "../access/service.js"
import {
  createWorkspaceSkill,
  SkillError,
  getInstalledSkill,
  getMarketplaceSkill,
  importMarketplaceMirrorSkill,
  refreshMarketplaceSkill,
  installMarketplaceSkill,
  listInstalledSkills,
  listMarketplaceSkills,
  publishMarketplaceSkill,
  uninstallInstalledSkill,
  updateInstalledSkill,
  upgradeInstalledSkill,
} from "./service.js"
import { presentInstalledSkillRecord } from "./presenter.js"

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof SkillError) {
    return reply.status(error.statusCode).send({ error: error.message })
  }
  if (error instanceof z.ZodError) {
    return reply.status(400).send({
      error: "Validation failed",
      details: error.issues.map((item) => ({
        field: item.path.join("."),
        message: item.message,
      })),
    })
  }
  throw error
}

async function requirePlatformManage(
  request: FastifyRequest,
  reply: FastifyReply,
  errorMessage: string
) {
  return requireRequestAction(
    request,
    reply,
    "platform.manage",
    PLATFORM_RESOURCE_ID,
    errorMessage
  )
}

async function requireWorkspaceQueryView(
  request: FastifyRequest,
  reply: FastifyReply,
  workspaceId: string,
  errorMessage: string
) {
  const allowed = await authorizeActionDefault({
    subject: await resolveWorkspaceAccessSubjectDefault(
      workspaceId,
      getRequestUserId(request)
    ),
    action: "workspace.view",
    resourceId: workspaceId,
  })

  if (!allowed) {
    reply.status(403).send({ error: errorMessage })
    return false
  }

  return true
}

export function registerSkillRoutes(app: FastifyInstance) {
  const authHook = { preHandler: [authMiddleware] }
  const workspaceHook = { preHandler: [authMiddleware, workspaceMiddleware] }

  appRoute(
    app,
    "GET",
    "/api/v1/skills/marketplace",
    { schema: SkillMarketplaceListViewSchema, options: authHook },
    async (request, reply) => {
      try {
        const { search, tags, workspaceId } =
          SkillMarketplaceListQuerySchema.parse(request.query || {})
        if (workspaceId) {
          const allowed = await requireWorkspaceQueryView(
            request,
            reply,
            workspaceId,
            "Not allowed to view skills for this workspace"
          )
          if (!allowed) return
        }
        const skills = await listMarketplaceSkills({
          search,
          tags,
          workspaceId,
        })
        return { skills }
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/skills/marketplace/:skillId",
    { schema: SkillMarketplaceItemViewSchema, options: authHook },
    async (request, reply) => {
      try {
        const { skillId } = request.params as { skillId: string }
        const { workspaceId } = SkillMarketplaceItemQuerySchema.parse(
          request.query || {}
        )
        if (workspaceId) {
          const allowed = await requireWorkspaceQueryView(
            request,
            reply,
            workspaceId,
            "Not allowed to view skills for this workspace"
          )
          if (!allowed) return
        }
        const skill = await getMarketplaceSkill(skillId, workspaceId)
        return { skill }
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/skills/marketplace",
    { schema: SkillMarketplaceItemViewSchema, options: authHook },
    async (request, reply) => {
      try {
        const allowed = await requirePlatformManage(
          request,
          reply,
          "Not allowed to publish marketplace skills"
        )
        if (!allowed) return

        const body = PublishMarketplaceSkillInputSchema.parse(request.body)
        const user = (request as any).user
        const skill = await publishMarketplaceSkill({
          ...body,
          authorUserId: user?.id || user?.userId,
        })
        reply.status(201)
        return { skill }
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/skills/marketplace/import",
    { schema: SkillMarketplaceItemViewSchema, options: authHook },
    async (request, reply) => {
      try {
        const allowed = await requirePlatformManage(
          request,
          reply,
          "Not allowed to import marketplace skills"
        )
        if (!allowed) return

        const body = ImportMarketplaceSkillInputSchema.parse(request.body)
        const user = (request as any).user
        const skill = await importMarketplaceMirrorSkill({
          ...body,
          authorUserId: user?.id || user?.userId,
        } as any)
        reply.status(201)
        return { skill }
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/skills/marketplace/:skillId/refresh",
    { schema: SkillMarketplaceItemViewSchema, options: authHook },
    async (request, reply) => {
      try {
        const allowed = await requirePlatformManage(
          request,
          reply,
          "Not allowed to refresh marketplace skills"
        )
        if (!allowed) return

        const { skillId } = request.params as { skillId: string }
        const user = (request as any).user
        const skill = await refreshMarketplaceSkill({
          skillId,
          authorUserId: user?.id || user?.userId,
        })
        return { skill }
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/skills",
    { schema: InstalledSkillListViewSchema, options: workspaceHook },
    async (request, reply) => {
      try {
        const { workspaceId } = request.params as { workspaceId: string }
        const allowed = await requireRequestAction(
          request,
          reply,
          "workspace.view",
          workspaceId,
          "Not allowed to view installed skills in this workspace"
        )
        if (!allowed) return

        const authorizedSkillIds = await listAuthorizedResourceIdsDefault({
          subject: getRequestAccessSubject(request),
          action: "installed_skill.edit",
        })
        if (authorizedSkillIds.length === 0) {
          return { skills: [] }
        }
        const {
          accessTargetType,
          actorId,
          remoteAgentId,
          workspaceMemberId,
          conversationId,
          sourceSkillId,
        } = InstalledSkillListQuerySchema.parse(request.query || {}) as z.infer<
          typeof InstalledSkillListQuerySchema
        >

        const skillRecords = await listInstalledSkills(workspaceId, {
          skillIds: authorizedSkillIds,
          accessTargetType,
          actorId,
          remoteAgentId,
          workspaceMemberId,
          conversationId,
          sourceSkillId,
        })
        const skills = skillRecords.map(presentInstalledSkillRecord)
        return { skills }
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/skills/:installedSkillId",
    { schema: InstalledSkillItemViewSchema, options: workspaceHook },
    async (request, reply) => {
      try {
        const { workspaceId, installedSkillId } = request.params as {
          workspaceId: string
          installedSkillId: string
        }
        const allowed = await requireRequestAction(
          request,
          reply,
          "installed_skill.edit",
          installedSkillId,
          "Not allowed to view this installed skill"
        )
        if (!allowed) return

        const skill = presentInstalledSkillRecord(
          await getInstalledSkill(workspaceId, installedSkillId)
        )
        return { skill }
      } catch (error) {
        handleError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/skills/:installedSkillId/upgrade",
    { schema: InstalledSkillItemViewSchema, options: workspaceHook },
    async (request, reply) => {
      try {
        const { workspaceId, installedSkillId } = request.params as {
          workspaceId: string
          installedSkillId: string
        }
        const allowed = await requireRequestAction(
          request,
          reply,
          "installed_skill.edit",
          installedSkillId,
          "Not allowed to upgrade this installed skill"
        )
        if (!allowed) return

        const skill = presentInstalledSkillRecord(
          await upgradeInstalledSkill({
            workspaceId,
            installedSkillId,
          })
        )
        return { skill }
      } catch (error) {
        handleError(reply, error)
      }
    }
  )
}
