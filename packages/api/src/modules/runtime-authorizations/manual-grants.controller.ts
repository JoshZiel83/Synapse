// Manual runtime-authorization grant endpoint (plan §Phase 3).
//
// MVP scope: workspace-scoped browser/cua/filesystem/commandline grants
// only. UI surface lives in dashboard → Settings → Runtime Authorizations
// and is the only path to seed a grant out-of-band of the chat approval
// flow — required so the active-page browser tools (current_page /
// page_id / all_pages) become usable on first run (those tools produce
// `grantOptions:[]` tasks, which can't be one-click approved).
//
// Non-workspace scopes (actor/conversation/scoped actor/
// remote_agent/once) are intentionally rejected: those scopes require a
// subject id that the API has no clean UX to collect from operators in
// MVP. The chat approval path remains for those.

import type { FastifyInstance } from "fastify"
import { formatValidationDetails } from "../../infrastructure/validation-error.js"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { requireRequestAction } from "../access/guards.js"
import { BrowserGrantPolicyError } from "@synapse/shared/access/policies"
import {
  browserOperationsForExposureStableKey,
  workspaceRef,
} from "@synapse/shared"
import {
  CreateManualRuntimeAuthorizationGrantInputSchema,
  RuntimeAuthorizationGrantRecordViewSchema,
} from "@synapse/shared/schemas"
import { appRoute } from "../../infrastructure/http/route.js"
import { createRuntimeAuthorizationGrant } from "./service.js"
import { findDeviceCapabilityGrantTarget } from "./repo.js"

export function registerManualRuntimeAuthorizationGrantRoutes(
  app: FastifyInstance
): void {
  const workspaceHook = { preHandler: [authMiddleware, workspaceMiddleware] }

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/runtime-authorization-grants",
    {
      schema: RuntimeAuthorizationGrantRecordViewSchema,
      options: workspaceHook,
    },
    async (request, reply) => {
      const { workspaceId: pathWorkspaceId } = request.params as {
        workspaceId: string
      }
      const parsed = CreateManualRuntimeAuthorizationGrantInputSchema.safeParse(
        request.body
      )
      if (!parsed.success) {
        reply.status(400).send({
          code: "invalid_request",
          details: formatValidationDetails(parsed.error),
        })
        return
      }

      // The shared app input schema validates the grant policy and strips
      // browser-only request fields such as scopeSource at the app boundary.
      const policy = parsed.data.policy

      // Permission: workspace.manage_devices + device_capability.grant on
      // the target capability. Mirrors access-bindings.ts.
      if (
        !(await requireRequestAction(
          request,
          reply,
          "workspace.manage_devices",
          pathWorkspaceId,
          "Cannot create runtime authorization grants in this workspace"
        ))
      )
        return
      if (
        !(await requireRequestAction(
          request,
          reply,
          "device_capability.grant",
          parsed.data.deviceCapabilityId,
          "Cannot grant runtime authorization on this device capability"
        ))
      )
        return

      // JOIN reverse-lookup: pull device_id / exposure_id / builtin_kind /
      // workspace_id / status. Verify they line up before the write.
      const row = await findDeviceCapabilityGrantTarget(
        parsed.data.deviceCapabilityId
      )
      if (!row) {
        reply.status(404).send({
          code: "device_capability_not_found",
          message: `device capability ${parsed.data.deviceCapabilityId} not found`,
        })
        return
      }
      if (row.workspaceId !== pathWorkspaceId) {
        reply.status(400).send({
          code: "workspace_id_mismatch",
          message: "device_capability does not belong to this workspace",
        })
        return
      }
      if (row.status !== "active") {
        reply.status(409).send({
          code: "device_capability_inactive",
          message: `device_capability status is ${row.status}`,
        })
        return
      }
      if (row.runtimeStatus === "offline") {
        reply.status(409).send({
          code: "device_exposure_offline",
          message: "underlying device exposure is offline",
        })
        return
      }
      if (policy.capability !== row.builtinKind) {
        reply.status(400).send({
          code: "capability_mismatch",
          message: `policy.capability=${policy.capability} but exposure.builtin_kind=${row.builtinKind}`,
        })
        return
      }

      // v3.1: for browser grants, restrict operations to those the exposure
      // actually serves. e.g. a `read` exposure must not be granted
      // `script.evaluate` — that would produce a dead grant that no real
      // tool call could ever use, and risks operators mis-understanding
      // the blast radius of their approval.
      if (
        policy.capability === "browser" &&
        policy.browser?.operations &&
        policy.browser.operations.length > 0
      ) {
        const allowedOps = new Set(
          browserOperationsForExposureStableKey(row.exposureStableKey)
        )
        const bad = policy.browser.operations.filter(
          (op) => !allowedOps.has(op)
        )
        if (bad.length > 0) {
          reply.status(400).send({
            code: "operations_not_allowed_for_exposure",
            message: `operations not served by exposure ${row.exposureStableKey}: ${bad.join(", ")}`,
            allowed: [...allowedOps],
          })
          return
        }
      }

      const session = (request as { session?: { workspaceMemberId?: string } })
        .session

      try {
        const grant = await createRuntimeAuthorizationGrant({
          // subject-scope-refactor: MVP manual path only writes workspace-
          // scoped grants (see file header). The legacy preset="workspace"
          // maps to subject=workspace + retention=until_revoked + the parsed
          // policy. No scope (workspace grants are unscoped).
          workspaceId: pathWorkspaceId,
          deviceId: row.deviceId,
          deviceCapabilityId: parsed.data.deviceCapabilityId,
          deviceExposureId: row.exposureId,
          subject: workspaceRef(pathWorkspaceId),
          retention: "until_revoked",
          policy,
          createdByWorkspaceMemberId: session?.workspaceMemberId ?? undefined,
        })
        reply.status(201)
        return grant
      } catch (err) {
        if (err instanceof BrowserGrantPolicyError) {
          reply.status(400).send({
            code: "invalid_browser_grant_policy",
            field: err.field,
            message: err.message,
          })
          return
        }
        reply.status(500).send({
          code: "internal_error",
          message: (err as Error).message,
        })
      }
    }
  )
}
