// REST routes for the active-device picker (§9.1). Mounted by the devices
// module so the picker can call setActiveDeviceCapabilitiesForTarget without
// going through capability-projection's internal module boundary.
//
// subject-scope-refactor: the app shape is a shared-owned `ScopedSubjectTarget`
// (`{subject, scope?}`) nested in SetActiveDeviceCapabilitiesInputSchema. The
// SDK/web send this app contract; the route maps it to AccessTargetInput at the
// boundary via appTargetToInternalAccessTarget.

import { formatValidationDetails } from "../../infrastructure/validation-error.js"
import type { FastifyInstance } from "fastify"
import type { DeviceCapabilityAccessTargetInput } from "@synapse/shared"
import {
  SetActiveDeviceCapabilitiesInputSchema,
  ActiveDeviceCapabilitiesViewSchema,
  ActiveDeviceCapabilitiesListQuerySchema,
  type ActiveDeviceCapabilitiesListQuery,
} from "@synapse/shared/schemas"
import { appRoute } from "../../infrastructure/http/route.js"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { requireRequestAction } from "../access/guards.js"
import {
  findActorWorkspace,
  findConversationWorkspace,
  findRemoteAgentWorkspace,
  findOwnedDeviceCapabilityIds,
} from "./repo.js"
import {
  listActiveDeviceCapabilitiesForTarget,
  setActiveDeviceCapabilitiesForTarget,
  type AccessTargetInput,
} from "../capability-projection/device-capabilities.js"

// Exported for regression tests that pin the app-facing input contract — the
// bug pattern under guard is the route accepting a different shape than the
// SDK/web sends. Per §5.1.1/§8.3 this management write is app-facing camelCase
// (shared `SetActiveDeviceCapabilitiesInput`: `deviceCapabilityIds`), with a
// shared-owned target whitelist.
export const setActiveBodySchema = SetActiveDeviceCapabilitiesInputSchema

/**
 * Map the app `(subject, scope?)` shape onto `AccessTargetInput`.
 *
 * The shared app schema's `superRefine` already rejects every combination
 * outside the supported whitelist (unscoped any-of-4, or
 * actor/remote_agent + conversation), so we only need to handle those
 * shapes here. Anything else is unreachable.
 */
// Exported for regression tests that pin the app→internal mapping — without
// this lock, the shared app schema could keep accepting a shape that then throws
// at the mapper (which is what happened pre-Batch-19 with
// `(remote_agent, conversation)`).
export function appTargetToInternalAccessTarget(
  target: DeviceCapabilityAccessTargetInput
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
    // Unreachable — shared app target schema rejected everything else upstream.
    throw new Error(
      `appTargetToInternalAccessTarget: unsupported (${subject.kind}, ${scope.kind}) escaped the app target whitelist`
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
 * GET query params for listing active device-capability bindings. App-facing
 * query DTO → camelCase (§5.1.1: request body AND query DTOs are app contracts):
 *   subjectKind=workspace                    | (no extras; workspace id from URL)
 *   subjectKind=actor      + subjectActorId=<uuid>
 *   subjectKind=conversation + subjectConversationId=<uuid>
 *   subjectKind=remote_agent + subjectRemoteAgentId=<uuid>
 * optional scope (only the `conversation` scope is currently allowed):
 *   scopeKind=conversation + scopeConversationId=<uuid>
 *
 * `scopeKind=workspace` is explicitly rejected — the binding model only supports
 * `actor|remote_agent + conversation`.
 */
const listQuerySchema = ActiveDeviceCapabilitiesListQuerySchema

function listQueryToInternalAccessTarget(
  workspaceId: string,
  q: ActiveDeviceCapabilitiesListQuery
): AccessTargetInput | null {
  if (q.scopeKind === "conversation" && q.scopeConversationId) {
    if (q.subjectKind === "actor" && q.subjectActorId) {
      return {
        kind: "actor",
        actorId: q.subjectActorId,
        conversationId: q.scopeConversationId,
      }
    }
    if (q.subjectKind === "remote_agent" && q.subjectRemoteAgentId) {
      return {
        kind: "remote_agent",
        remoteAgentId: q.subjectRemoteAgentId,
        conversationId: q.scopeConversationId,
      }
    }
    return null
  }
  switch (q.subjectKind) {
    case "workspace":
      return { kind: "workspace", workspaceId }
    case "actor":
      return q.subjectActorId
        ? { kind: "actor", actorId: q.subjectActorId }
        : null
    case "conversation":
      return q.subjectConversationId
        ? {
            kind: "conversation",
            conversationId: q.subjectConversationId,
          }
        : null
    case "remote_agent":
      return q.subjectRemoteAgentId
        ? {
            kind: "remote_agent",
            remoteAgentId: q.subjectRemoteAgentId,
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
      const row = await findActorWorkspace(target.actorId)
      if (!row || row.workspaceId !== workspaceId) {
        return {
          ok: false,
          reason: "actor not found in this workspace",
        }
      }
      if (target.conversationId) {
        const conversation = await findConversationWorkspace(
          target.conversationId
        )
        if (!conversation || conversation.workspaceId !== workspaceId) {
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
      const row = await findConversationWorkspace(target.conversationId)
      if (!row || row.workspaceId !== workspaceId) {
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
      const row = await findRemoteAgentWorkspace(target.remoteAgentId)
      if (!row || row.workspaceId !== workspaceId) {
        return {
          ok: false,
          reason: "remote_agent not found in this workspace",
        }
      }
      if (target.conversationId) {
        const conversation = await findConversationWorkspace(
          target.conversationId
        )
        if (!conversation || conversation.workspaceId !== workspaceId) {
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
  const ownedIds = await findOwnedDeviceCapabilityIds(
    workspaceId,
    capabilityIds
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

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/devices/access-bindings",
    { schema: ActiveDeviceCapabilitiesViewSchema, options: workspaceHook },
    async (request, reply): Promise<undefined> => {
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

      // Require manage_devices on the workspace AND runtime_capability.grant
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

      for (const capId of parsed.data.deviceCapabilityIds) {
        if (
          !(await requireRequestAction(
            request,
            reply,
            "runtime_capability.grant",
            capId,
            "Cannot grant access to one of the listed device capabilities"
          ))
        )
          return
      }

      let internalTarget: AccessTargetInput
      try {
        internalTarget = appTargetToInternalAccessTarget(parsed.data.target)
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
        parsed.data.deviceCapabilityIds
      )
      if (!capabilitiesCheck.ok) {
        reply.status(400).send({
          code: "invalid_capability",
          message: "one or more deviceCapabilityIds not in this workspace",
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
          deviceCapabilityIds: parsed.data.deviceCapabilityIds,
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

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/devices/access-bindings",
    { schema: ActiveDeviceCapabilitiesViewSchema, options: workspaceHook },
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
        return { deviceCapabilityIds: ids }
      } catch (err) {
        reply
          .status(500)
          .send({ code: "internal_error", message: (err as Error).message })
      }
    }
  )
}
