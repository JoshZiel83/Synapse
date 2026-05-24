// REST routes for the active-device picker (§9.1). Mounted by the devices
// module so the picker can call setActiveDeviceCapabilitiesForTarget without
// going through capability-projection's internal module boundary.

import { z } from "zod"
import type { FastifyInstance } from "fastify"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import {
  listActiveDeviceCapabilitiesForTarget,
  setActiveDeviceCapabilitiesForTarget,
} from "../capability-projection/device-capabilities.js"

const accessTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workspace"),
    workspaceId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal("actor"),
    actorId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal("conversation"),
    conversationId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal("actor_in_conversation"),
    actorId: z.string().uuid(),
    conversationId: z.string().uuid(),
  }),
])

const setActiveBodySchema = z.object({
  workspaceId: z.string().uuid(),
  target: accessTargetSchema,
  device_capability_ids: z.array(z.string().uuid()),
  reason: z.string().max(2000).optional(),
})

export function registerDeviceAccessBindingRoutes(app: FastifyInstance): void {
  const authHook = { preHandler: [authMiddleware] }

  app.post(
    "/api/v1/devices/access-bindings",
    authHook,
    async (request, reply) => {
      const parsed = setActiveBodySchema.safeParse(request.body)
      if (!parsed.success) {
        reply.status(400).send({
          code: "invalid_request",
          details: parsed.error.flatten(),
        })
        return
      }
      const session = (request as { session?: { workspaceMemberId?: string } })
        .session
      try {
        await setActiveDeviceCapabilitiesForTarget({
          workspaceId: parsed.data.workspaceId,
          target: parsed.data.target,
          deviceCapabilityIds: parsed.data.device_capability_ids,
          createdByWorkspaceMemberId: session?.workspaceMemberId ?? null,
          reason: parsed.data.reason,
        })
        reply.status(204).send()
      } catch (err) {
        reply
          .status(500)
          .send({ code: "internal_error", message: (err as Error).message })
      }
    }
  )

  app.get(
    "/api/v1/devices/access-bindings",
    authHook,
    async (request, reply) => {
      const query = request.query as {
        workspaceId?: string
        target_kind?: string
        actor_id?: string
        conversation_id?: string
      }
      const target = (() => {
        switch (query.target_kind) {
          case "workspace":
            return {
              kind: "workspace" as const,
              workspaceId: query.workspaceId ?? "",
            }
          case "actor":
            return { kind: "actor" as const, actorId: query.actor_id ?? "" }
          case "conversation":
            return {
              kind: "conversation" as const,
              conversationId: query.conversation_id ?? "",
            }
          case "actor_in_conversation":
            return {
              kind: "actor_in_conversation" as const,
              actorId: query.actor_id ?? "",
              conversationId: query.conversation_id ?? "",
            }
          default:
            return null
        }
      })()
      if (!query.workspaceId || !target) {
        reply.status(400).send({ code: "invalid_request" })
        return
      }
      try {
        const ids = await listActiveDeviceCapabilitiesForTarget({
          workspaceId: query.workspaceId,
          target,
        })
        reply.send({ device_capability_ids: ids })
      } catch (err) {
        reply
          .status(500)
          .send({ code: "internal_error", message: (err as Error).message })
      }
    }
  )
}
