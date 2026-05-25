// REST routes for the active-device picker (§9.1). Mounted by the devices
// module so the picker can call setActiveDeviceCapabilitiesForTarget without
// going through capability-projection's internal module boundary.

import { z } from "zod"
import type { FastifyInstance } from "fastify"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { requireRequestAction } from "../access/guards.js"
import { db } from "../../infrastructure/database/kysely.js"
import {
  listActiveDeviceCapabilitiesForTarget,
  setActiveDeviceCapabilitiesForTarget,
  type AccessTargetInput,
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

/**
 * Validate that an AccessTarget points at a row that lives in the same
 * workspace as the grant. Without this check a caller authorized in
 * workspace W1 could write a binding that targets an actor / conversation
 * / conversation_actor_context in workspace W2.
 */
async function assertTargetInWorkspace(
  workspaceId: string,
  target: AccessTargetInput
): Promise<{ ok: true } | { ok: false; reason: string }> {
  switch (target.kind) {
    case "workspace":
      if (target.workspaceId !== workspaceId) {
        return { ok: false, reason: "AccessTarget.workspaceId mismatch" }
      }
      return { ok: true }
    case "actor": {
      if (!target.actorId)
        return { ok: false, reason: "actorId required" }
      const row = await db
        .selectFrom("actors")
        .select("workspace_id")
        .where("id", "=", target.actorId)
        .executeTakeFirst()
      if (!row || row.workspace_id !== workspaceId) {
        return {
          ok: false,
          reason: "actor not found in this workspace",
        }
      }
      return { ok: true }
    }
    case "conversation": {
      if (!target.conversationId)
        return { ok: false, reason: "conversationId required" }
      const row = await db
        .selectFrom("conversations")
        .select("internal_workspace_id")
        .where("id", "=", target.conversationId)
        .executeTakeFirst()
      if (!row || row.internal_workspace_id !== workspaceId) {
        return {
          ok: false,
          reason: "conversation not found in this workspace",
        }
      }
      return { ok: true }
    }
    case "actor_in_conversation": {
      if (!target.actorId || !target.conversationId)
        return {
          ok: false,
          reason: "actorId and conversationId required",
        }
      const actor = await db
        .selectFrom("actors")
        .select("workspace_id")
        .where("id", "=", target.actorId)
        .executeTakeFirst()
      const conversation = await db
        .selectFrom("conversations")
        .select("internal_workspace_id")
        .where("id", "=", target.conversationId)
        .executeTakeFirst()
      if (!actor || actor.workspace_id !== workspaceId) {
        return { ok: false, reason: "actor not found in this workspace" }
      }
      if (
        !conversation ||
        conversation.internal_workspace_id !== workspaceId
      ) {
        return {
          ok: false,
          reason: "conversation not found in this workspace",
        }
      }
      return { ok: true }
    }
  }
}

async function assertCapabilitiesInWorkspace(
  workspaceId: string,
  capabilityIds: string[]
): Promise<{ ok: true } | { ok: false; missing: string[] }> {
  if (capabilityIds.length === 0) return { ok: true }
  const rows = await db
    .selectFrom("device_capabilities")
    .select(["id", "workspace_id"])
    .where("id", "in", capabilityIds)
    .execute()
  const ownedIds = new Set(
    rows
      .filter((r) => r.workspace_id === workspaceId)
      .map((r) => r.id as string)
  )
  const missing = capabilityIds.filter((id) => !ownedIds.has(id))
  if (missing.length > 0) return { ok: false, missing }
  return { ok: true }
}

export function registerDeviceAccessBindingRoutes(app: FastifyInstance): void {
  // workspaceMiddleware verifies the caller has workspace.view; the explicit
  // requireRequestAction call below enforces the manage-grant action so a
  // workspace member without grant rights can't write bindings.
  const workspaceHook = { preHandler: [authMiddleware, workspaceMiddleware] }

  app.post(
    "/api/v1/workspaces/:workspaceId/devices/access-bindings",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId: pathWorkspaceId } = request.params as {
        workspaceId: string
      }
      const parsed = setActiveBodySchema.safeParse(request.body)
      if (!parsed.success) {
        reply
          .status(400)
          .send({ code: "invalid_request", details: parsed.error.flatten() })
        return
      }
      if (parsed.data.workspaceId !== pathWorkspaceId) {
        reply.status(400).send({
          code: "workspace_id_mismatch",
          message: "body.workspaceId must match the URL workspaceId",
        })
        return
      }

      // Require manage_devices on the workspace AND device_capability.grant
      // on each capability being granted/revoked. Without the latter check
      // a workspace_member with manage_devices could write grants for a
      // capability they shouldn't see.
      if (
        !(await requireRequestAction(
          request,
          reply,
          "workspace.manage_devices",
          pathWorkspaceId,
          "Cannot write device access bindings in this workspace"
        ))
      )
        return

      for (const capId of parsed.data.device_capability_ids) {
        if (
          !(await requireRequestAction(
            request,
            reply,
            "device_capability.grant",
            capId,
            "Cannot grant access to one of the listed device capabilities"
          ))
        )
          return
      }

      const targetCheck = await assertTargetInWorkspace(
        pathWorkspaceId,
        parsed.data.target
      )
      if (!targetCheck.ok) {
        reply.status(400).send({
          code: "invalid_target",
          message: targetCheck.reason,
        })
        return
      }

      const capabilitiesCheck = await assertCapabilitiesInWorkspace(
        pathWorkspaceId,
        parsed.data.device_capability_ids
      )
      if (!capabilitiesCheck.ok) {
        reply.status(400).send({
          code: "invalid_capability",
          message: "one or more device_capability_ids not in this workspace",
          missing: capabilitiesCheck.missing,
        })
        return
      }

      const session = (request as { session?: { workspaceMemberId?: string } })
        .session
      try {
        await setActiveDeviceCapabilitiesForTarget({
          workspaceId: pathWorkspaceId,
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
    "/api/v1/workspaces/:workspaceId/devices/access-bindings",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string }
      const query = request.query as {
        target_kind?: string
        actor_id?: string
        conversation_id?: string
      }
      if (
        !(await requireRequestAction(
          request,
          reply,
          "workspace.view",
          workspaceId,
          "Cannot view device access bindings in this workspace"
        ))
      )
        return

      const target: AccessTargetInput | null = (() => {
        switch (query.target_kind) {
          case "workspace":
            return { kind: "workspace", workspaceId }
          case "actor":
            return query.actor_id
              ? { kind: "actor", actorId: query.actor_id }
              : null
          case "conversation":
            return query.conversation_id
              ? { kind: "conversation", conversationId: query.conversation_id }
              : null
          case "actor_in_conversation":
            return query.actor_id && query.conversation_id
              ? {
                  kind: "actor_in_conversation",
                  actorId: query.actor_id,
                  conversationId: query.conversation_id,
                }
              : null
          default:
            return null
        }
      })()
      if (!target) {
        reply.status(400).send({ code: "invalid_request" })
        return
      }
      const targetCheck = await assertTargetInWorkspace(workspaceId, target)
      if (!targetCheck.ok) {
        reply.status(400).send({
          code: "invalid_target",
          message: targetCheck.reason,
        })
        return
      }
      try {
        const ids = await listActiveDeviceCapabilitiesForTarget({
          workspaceId,
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
