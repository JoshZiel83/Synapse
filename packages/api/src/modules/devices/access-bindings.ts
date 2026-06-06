// REST routes for the active-device picker (§9.1). Mounted by the devices
// module so the picker can call setActiveDeviceCapabilitiesForTarget without
// going through capability-projection's internal module boundary.
//
// subject-scope-refactor: the wire shape is `ScopedSubjectTarget` from
// `@synapse/device-protocol` (`{subject: SubjectRefWire, scope?: SubjectRefWire}`).
// The SDK sends this shape; the route parses with the protocol schema
// directly so they cannot drift. The route maps
// `ScopedSubjectTarget → AccessTargetInput` at the boundary via
// `wireTargetToInternalAccessTarget`.

import { z } from "zod"
import { formatValidationDetails } from "../../infrastructure/validation-error.js"
import type { FastifyInstance } from "fastify"
import {
  ScopedSubjectTargetWireSchema,
  type DeviceCapabilityAccessTarget,
} from "@synapse/device-protocol"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { requireRequestAction } from "../access/guards.js"
import { db } from "../../infrastructure/database/kysely.js"
import {
  listActiveDeviceCapabilitiesForTarget,
  setActiveDeviceCapabilitiesForTarget,
  type AccessTargetInput,
} from "../capability-projection/device-capabilities.js"

// Exported for regression tests that pin the wire-vs-server schema
// contract — the bug pattern under guard is the route accepting a
// different shape than the SDK sends (which happened pre-Batch-18 when
// the route used a discriminated union while the SDK migrated to
// ScopedSubjectTarget).
export const setActiveBodySchema = z.object({
  workspaceId: z.uuid(),
  target: ScopedSubjectTargetWireSchema,
  device_capability_ids: z.array(z.uuid()),
  reason: z.string().max(2000).optional(),
})

/**
 * Map the wire `(subject, scope?)` shape onto `AccessTargetInput`.
 *
 * The wire schema's `superRefine` already rejects every combination
 * outside the supported whitelist (unscoped any-of-4, or
 * actor/remote_agent + conversation), so we only need to handle those
 * shapes here. Anything else is unreachable.
 */
// Exported for regression tests that pin the wire→internal mapping —
// without this lock, the wire schema could keep accepting a shape that
// then throws at the mapper (which is what happened pre-Batch-19 with
// `(remote_agent, conversation)`).
export function wireTargetToInternalAccessTarget(
  target: DeviceCapabilityAccessTarget
): AccessTargetInput {
  const { subject, scope } = target
  if (scope) {
    if (subject.kind === "actor" && scope.kind === "conversation") {
      return {
        kind: "actor",
        actorId: subject.actorId,
        conversationId: scope.conversationId,
      }
    }
    if (subject.kind === "remote_agent" && scope.kind === "conversation") {
      return {
        kind: "remote_agent",
        remoteAgentId: subject.remoteAgentId,
        conversationId: scope.conversationId,
      }
    }
    // Unreachable — wire schema rejected everything else upstream.
    throw new Error(
      `wireTargetToInternalAccessTarget: unsupported (${subject.kind}, ${scope.kind}) escaped the wire whitelist`
    )
  }
  switch (subject.kind) {
    case "workspace":
      return { kind: "workspace", workspaceId: subject.workspaceId }
    case "actor":
      return { kind: "actor", actorId: subject.actorId }
    case "conversation":
      return {
        kind: "conversation",
        conversationId: subject.conversationId,
      }
    case "remote_agent":
      return { kind: "remote_agent", remoteAgentId: subject.remoteAgentId }
  }
}

/**
 * GET query params for listing active device-capability bindings. Flat
 * snake_case (query strings prefer flat) but scope-aware:
 *   subject_kind=workspace                    | (no extras needed; workspace id from URL)
 *   subject_kind=actor      + subject_actor_id=<uuid>
 *   subject_kind=conversation + subject_conversation_id=<uuid>
 *   subject_kind=remote_agent + subject_remote_agent_id=<uuid>
 * optional scope (only the `conversation` scope is currently allowed):
 *   scope_kind=conversation + scope_conversation_id=<uuid>
 *
 * Wire schema `scope_kind=workspace` is explicitly rejected — the
 * binding model only supports `actor|remote_agent + conversation`.
 */
const listQuerySchema = z
  .object({
    subject_kind: z.enum([
      "workspace",
      "actor",
      "conversation",
      "remote_agent",
    ]),
    subject_workspace_id: z.uuid().optional(),
    subject_actor_id: z.uuid().optional(),
    subject_conversation_id: z.uuid().optional(),
    subject_remote_agent_id: z.uuid().optional(),
    scope_kind: z.enum(["conversation"]).optional(),
    scope_conversation_id: z.uuid().optional(),
  })
  .superRefine((q, ctx) => {
    if (q.scope_kind === "conversation") {
      if (!q.scope_conversation_id) {
        ctx.addIssue({
          code: "custom",
          message:
            "scope_conversation_id required when scope_kind=conversation",
          path: ["scope_conversation_id"],
        })
      }
      if (q.subject_kind !== "actor" && q.subject_kind !== "remote_agent") {
        ctx.addIssue({
          code: "custom",
          message: `scope_kind=conversation only allowed with subject_kind=actor|remote_agent (got ${q.subject_kind})`,
          path: ["scope_kind"],
        })
      }
    }
  })

function listQueryToInternalAccessTarget(
  workspaceId: string,
  q: z.infer<typeof listQuerySchema>
): AccessTargetInput | null {
  if (q.scope_kind === "conversation" && q.scope_conversation_id) {
    if (q.subject_kind === "actor" && q.subject_actor_id) {
      return {
        kind: "actor",
        actorId: q.subject_actor_id,
        conversationId: q.scope_conversation_id,
      }
    }
    if (q.subject_kind === "remote_agent" && q.subject_remote_agent_id) {
      return {
        kind: "remote_agent",
        remoteAgentId: q.subject_remote_agent_id,
        conversationId: q.scope_conversation_id,
      }
    }
    return null
  }
  switch (q.subject_kind) {
    case "workspace":
      return { kind: "workspace", workspaceId }
    case "actor":
      return q.subject_actor_id
        ? { kind: "actor", actorId: q.subject_actor_id }
        : null
    case "conversation":
      return q.subject_conversation_id
        ? {
            kind: "conversation",
            conversationId: q.subject_conversation_id,
          }
        : null
    case "remote_agent":
      return q.subject_remote_agent_id
        ? {
            kind: "remote_agent",
            remoteAgentId: q.subject_remote_agent_id,
          }
        : null
  }
}

/**
 * Validate that an AccessTarget points at a row that lives in the same
 * workspace as the grant. Without this check a caller authorized in
 * workspace W1 could write a binding that targets an actor / conversation
 * / scoped actor in workspace W2.
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
      if (!target.actorId) return { ok: false, reason: "actorId required" }
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
      if (target.conversationId) {
        const conversation = await db
          .selectFrom("conversations")
          .select("workspace_id")
          .where("id", "=", target.conversationId)
          .executeTakeFirst()
        if (!conversation || conversation.workspace_id !== workspaceId) {
          return {
            ok: false,
            reason: "conversation not found in this workspace",
          }
        }
      }
      return { ok: true }
    }
    case "conversation": {
      if (!target.conversationId)
        return { ok: false, reason: "conversationId required" }
      const row = await db
        .selectFrom("conversations")
        .select("workspace_id")
        .where("id", "=", target.conversationId)
        .executeTakeFirst()
      if (!row || row.workspace_id !== workspaceId) {
        return {
          ok: false,
          reason: "conversation not found in this workspace",
        }
      }
      return { ok: true }
    }
    case "remote_agent": {
      if (!target.remoteAgentId)
        return { ok: false, reason: "remoteAgentId required" }
      const row = await db
        .selectFrom("remote_agents")
        .select("workspace_id")
        .where("id", "=", target.remoteAgentId)
        .executeTakeFirst()
      if (!row || row.workspace_id !== workspaceId) {
        return {
          ok: false,
          reason: "remote_agent not found in this workspace",
        }
      }
      if (target.conversationId) {
        const conversation = await db
          .selectFrom("conversations")
          .select("workspace_id")
          .where("id", "=", target.conversationId)
          .executeTakeFirst()
        if (!conversation || conversation.workspace_id !== workspaceId) {
          return {
            ok: false,
            reason: "conversation not found in this workspace",
          }
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
        reply.status(400).send({
          code: "invalid_request",
          details: formatValidationDetails(parsed.error),
        })
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

      let internalTarget: AccessTargetInput
      try {
        internalTarget = wireTargetToInternalAccessTarget(parsed.data.target)
      } catch (err) {
        reply.status(400).send({
          code: "unsupported_target",
          message: (err as Error).message,
        })
        return
      }

      const targetCheck = await assertTargetInWorkspace(
        pathWorkspaceId,
        internalTarget
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
          target: internalTarget,
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
      const queryParsed = listQuerySchema.safeParse(request.query)
      if (!queryParsed.success) {
        reply.status(400).send({
          code: "invalid_request",
          details: formatValidationDetails(queryParsed.error),
        })
        return
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

      const target = listQueryToInternalAccessTarget(
        workspaceId,
        queryParsed.data
      )
      if (!target) {
        reply.status(400).send({
          code: "invalid_request",
          message:
            "query did not resolve to a supported (subject, scope?) target",
        })
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
