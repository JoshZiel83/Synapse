import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import { formatValidationDetails } from "../../infrastructure/validation-error.js"
import { PLATFORM_ACCESS_KEYS } from "@synapse/shared/constants"
import {
  PlatformAccessBindingListViewSchema,
  PlatformAccessBindingViewSchema,
  PlatformAccessGrantInputSchema,
  PlatformNavigationViewSchema,
  PlatformNoContentSchema,
} from "@synapse/shared/schemas"
import { appRoute } from "../../infrastructure/http/route.js"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { PLATFORM_RESOURCE_ID } from "../access/evaluator.js"
import {
  grantPlatformAccess,
  listPlatformAccessBindings,
  revokePlatformAccess,
  type PlatformAccessKey,
} from "./admin-service.js"
import {
  requireRequestAction,
  authorizeActionDefault,
} from "../access/guards.js"
import { userSubject } from "../access/service.js"
import {
  presentPlatformAccessBinding,
  presentPlatformNavigation,
} from "./presenter.js"

const platformAccessParamsSchema = z.object({
  userId: z.uuid(),
  accessKey: z.enum(PLATFORM_ACCESS_KEYS),
})

async function requirePlatformManagePermission(
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

async function canPlatformPermission(userId: string) {
  return authorizeActionDefault({
    subject: userSubject(userId),
    action: "platform.manage",
    resourceId: PLATFORM_RESOURCE_ID,
  })
}

export function registerPlatformRoutes(app: FastifyInstance) {
  const authHook = { preHandler: [authMiddleware] }

  appRoute(
    app,
    "GET",
    "/api/v1/platform/navigation",
    {
      schema: PlatformNavigationViewSchema,
      options: authHook,
    },
    async (request) => {
      const userId = (request as any).user!.userId
      const canManagePlatform = await canPlatformPermission(userId)

      return presentPlatformNavigation({ canManagePlatform })
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/platform/access",
    {
      schema: PlatformAccessBindingListViewSchema,
      options: authHook,
    },
    async (request, reply) => {
      const allowed = await requirePlatformManagePermission(
        request,
        reply,
        "Not allowed to manage platform access"
      )
      if (!allowed) return

      const accessBindings = await listPlatformAccessBindings()
      return accessBindings.map(presentPlatformAccessBinding)
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/platform/access",
    {
      schema: PlatformAccessBindingViewSchema,
      options: authHook,
    },
    async (request, reply) => {
      const allowed = await requirePlatformManagePermission(
        request,
        reply,
        "Not allowed to manage platform access"
      )
      if (!allowed) return

      const parsed = PlatformAccessGrantInputSchema.safeParse(request.body)
      if (!parsed.success) {
        reply.status(400).send({
          error: "Validation failed",
          details: formatValidationDetails(parsed.error),
        })
        return
      }

      try {
        const accessBinding = await grantPlatformAccess({
          userId: parsed.data.userId,
          accessKey: parsed.data.accessKey as PlatformAccessKey,
          assignedByUserId: (request as any).user!.userId,
        })
        reply.status(201)
        return presentPlatformAccessBinding(accessBinding)
      } catch (err: any) {
        const msg = err.message || "Failed to grant platform access"
        if (msg === "User not found") {
          reply.status(404).send({ error: msg })
          return
        }
        if (msg === "Access already granted") {
          reply.status(409).send({ error: msg })
          return
        }
        throw err
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/platform/access/:accessKey/users/:userId/revoke",
    {
      schema: PlatformNoContentSchema,
      options: authHook,
    },
    async (request, reply) => {
      const allowed = await requirePlatformManagePermission(
        request,
        reply,
        "Not allowed to manage platform access"
      )
      if (!allowed) return

      const params = platformAccessParamsSchema.parse(request.params)
      try {
        await revokePlatformAccess(params.userId, params.accessKey)
        return reply.status(204).send()
      } catch (err: any) {
        const msg = err.message || "Failed to revoke platform access"
        if (msg === "Access grant not found") {
          reply.status(404).send({ error: msg })
          return
        }
        if (msg === "Config-managed access cannot be revoked manually") {
          reply.status(409).send({ error: msg })
          return
        }
        throw err
      }
    }
  )
}
