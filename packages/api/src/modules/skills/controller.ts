import { db } from "../../infrastructure/database/kysely.js"
import { z } from "zod"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import {
  actorRef,
  CAPABILITY_ACCESS_TARGET_TYPES,
  conversationRef,
  remoteAgentRef,
  SUBJECT_KIND,
  workspaceMemberRef,
  workspaceRef,
  type CapabilityAccessTarget,
  type SkillAccessTargetType,
} from "@synapse/shared"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { PLATFORM_RESOURCE_ID } from "../access/evaluator.js"
import { requireRequestAction } from "../access/guards.js"
import {
  authorizeAction,
  getRequestAccessSubject,
  getRequestUserId,
  listAuthorizedResourceIds,
  resolveWorkspaceAccessSubject,
} from "../access/service.js"
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

const accessTargetTypeSchema = z.enum([
  CAPABILITY_ACCESS_TARGET_TYPES[0],
  CAPABILITY_ACCESS_TARGET_TYPES[1],
  CAPABILITY_ACCESS_TARGET_TYPES[2],
  CAPABILITY_ACCESS_TARGET_TYPES[3],
  CAPABILITY_ACCESS_TARGET_TYPES[4],
] as const satisfies readonly SkillAccessTargetType[])
const conversationTypeMaskSchema = z.number().int().min(1).max(15)

const skillAttachmentSchema = z.object({
  path: z.string().min(1),
  contentBlocks: z.array(z.any()).default([]),
  mediaType: z.string().min(1).optional(),
})

const publishSkillSchema = z.object({
  skillId: z.uuid().optional(),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.any().optional(),
  iconFileId: z.uuid().nullable().optional(),
  tags: z.array(z.string()).optional(),
  version: z.string().min(1),
  changelog: z.string().optional(),
  isActive: z.boolean().optional(),
  defaultConversationTypeMask: conversationTypeMaskSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  attachmentFiles: z.array(skillAttachmentSchema).optional(),
})

const importMarketplaceSkillSchema = z.discriminatedUnion("sourceType", [
  z.object({
    sourceType: z.literal("github"),
    repoUrl: z.url(),
    path: z.string().min(1),
    ref: z.string().trim().min(1).optional(),
  }),
  z.object({
    sourceType: z.literal("clawhub"),
    ownerId: z.string().trim().min(1).optional(),
    slug: z.string().trim().min(1),
    version: z.string().trim().min(1).optional(),
  }),
])

const listInstalledSkillsQuerySchema = z.object({
  accessTargetType: accessTargetTypeSchema.optional(),
  actorId: z.uuid().optional(),
  // Round 12 review (P3): workspace_member filter mode needs the id
  // to resolve a SubjectRef. Without it,
  // scopedTargetFromSkillUseScope("workspace_member") in
  // findSkillIdsByBindingFilter throws on missing workspaceMemberId.
  workspaceMemberId: z.uuid().optional(),
  conversationId: z.uuid().optional(),
  sourceSkillId: z.uuid().optional(),
})

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
  const allowed = await authorizeAction(db, {
    subject: await resolveWorkspaceAccessSubject(
      db,
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

  app.get("/api/v1/skills/marketplace", authHook, async (request, reply) => {
    try {
      const { search, tags, workspaceId } = request.query as {
        search?: string
        tags?: string
        workspaceId?: string
      }
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
        tags: tags
          ? tags
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean)
          : undefined,
        workspaceId,
      })
      return reply.status(200).send({ skills })
    } catch (error) {
      return handleError(reply, error)
    }
  })

  app.get(
    "/api/v1/skills/marketplace/:skillId",
    authHook,
    async (request, reply) => {
      try {
        const { skillId } = request.params as { skillId: string }
        const { workspaceId } = request.query as { workspaceId?: string }
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
        return reply.status(200).send({ skill })
      } catch (error) {
        return handleError(reply, error)
      }
    }
  )

  app.post("/api/v1/skills/marketplace", authHook, async (request, reply) => {
    try {
      const allowed = await requirePlatformManage(
        request,
        reply,
        "Not allowed to publish marketplace skills"
      )
      if (!allowed) return

      const body = publishSkillSchema.parse(request.body)
      const user = (request as any).user
      const skill = await publishMarketplaceSkill({
        ...body,
        authorUserId: user?.id || user?.userId,
      })
      return reply.status(201).send({ skill })
    } catch (error) {
      return handleError(reply, error)
    }
  })

  app.post(
    "/api/v1/skills/marketplace/import",
    authHook,
    async (request, reply) => {
      try {
        const allowed = await requirePlatformManage(
          request,
          reply,
          "Not allowed to import marketplace skills"
        )
        if (!allowed) return

        const body = importMarketplaceSkillSchema.parse(request.body)
        const user = (request as any).user
        const skill = await importMarketplaceMirrorSkill({
          ...body,
          authorUserId: user?.id || user?.userId,
        } as any)
        return reply.status(201).send({ skill })
      } catch (error) {
        return handleError(reply, error)
      }
    }
  )

  app.post(
    "/api/v1/skills/marketplace/:skillId/refresh",
    authHook,
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
        return reply.status(200).send({ skill })
      } catch (error) {
        return handleError(reply, error)
      }
    }
  )

  app.get(
    "/api/v1/workspaces/:workspaceId/skills",
    workspaceHook,
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

        const authorizedSkillIds = await listAuthorizedResourceIds(db, {
          subject: getRequestAccessSubject(request),
          action: "installed_skill.edit",
        })
        if (authorizedSkillIds.length === 0) {
          return reply.status(200).send({ skills: [] })
        }
        const {
          accessTargetType,
          actorId,
          workspaceMemberId,
          conversationId,
          sourceSkillId,
        } = listInstalledSkillsQuerySchema.parse(
          request.query || {}
        ) as z.infer<typeof listInstalledSkillsQuerySchema>

        const skills = await listInstalledSkills(workspaceId, {
          skillIds: authorizedSkillIds,
          accessTargetType,
          actorId,
          workspaceMemberId,
          conversationId,
          sourceSkillId,
        })
        return reply.status(200).send({ skills })
      } catch (error) {
        return handleError(reply, error)
      }
    }
  )

  app.get(
    "/api/v1/workspaces/:workspaceId/skills/:installedSkillId",
    workspaceHook,
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

        const skill = await getInstalledSkill(workspaceId, installedSkillId)
        return reply.status(200).send({ skill })
      } catch (error) {
        return handleError(reply, error)
      }
    }
  )

  app.post(
    "/api/v1/workspaces/:workspaceId/skills/:installedSkillId/upgrade",
    workspaceHook,
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

        const skill = await upgradeInstalledSkill({
          workspaceId,
          installedSkillId,
        })
        return reply.status(200).send({ skill })
      } catch (error) {
        return handleError(reply, error)
      }
    }
  )
}
