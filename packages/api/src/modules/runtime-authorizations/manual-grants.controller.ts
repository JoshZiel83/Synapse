// Manual runtime-authorization grant endpoint (plan §Phase 3).
//
// MVP scope: workspace-scoped browser/cua/filesystem/commandline grants
// only. UI surface lives in dashboard → Settings → Runtime Authorizations
// and is the only path to seed a grant out-of-band of the chat approval
// flow — required so the active-page browser tools (current_page /
// page_id / all_pages) become usable on first run (those tools produce
// `grantOptions:[]` interactions, which can't be one-click approved).
//
// Non-workspace scopes (actor/conversation/actor_in_conversation/
// remote_agent/once) are intentionally rejected: those scopes require a
// subject id that the API has no clean UX to collect from operators in
// MVP. The chat approval path remains for those.

import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { requireRequestAction } from "../access/guards.js"
import { db } from "../../infrastructure/database/kysely.js"
import {
  BrowserGrantPolicyError,
  GrantPolicySchema,
} from "@synapse/shared/access/policies"
import { createRuntimeAuthorizationGrant } from "./service.js"

const manualGrantBodySchema = z.object({
  device_capability_id: z.string().uuid(),
  policy: z.unknown(), // validated below via GrantPolicySchema
})

export function registerManualRuntimeAuthorizationGrantRoutes(
  app: FastifyInstance
): void {
  const workspaceHook = { preHandler: [authMiddleware, workspaceMiddleware] }

  app.post(
    "/api/v1/workspaces/:workspaceId/runtime-authorization-grants",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId: pathWorkspaceId } = request.params as {
        workspaceId: string
      }
      const parsed = manualGrantBodySchema.safeParse(request.body)
      if (!parsed.success) {
        reply
          .status(400)
          .send({ code: "invalid_request", details: parsed.error.flatten() })
        return
      }

      // Validate GrantPolicy shape (BrowserPolicy.strip() drops any stray
      // scopeSource on the way in — see plan §clarification #10).
      const policyParse = GrantPolicySchema.safeParse(parsed.data.policy)
      if (!policyParse.success) {
        reply.status(400).send({
          code: "invalid_request",
          message: "policy did not match GrantPolicySchema",
          details: policyParse.error.flatten(),
        })
        return
      }
      const policy = policyParse.data

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
          parsed.data.device_capability_id,
          "Cannot grant runtime authorization on this device capability"
        ))
      )
        return

      // JOIN reverse-lookup: pull device_id / exposure_id / builtin_kind /
      // workspace_id / status. Verify they line up before the write.
      const row = await db
        .selectFrom("device_capabilities as dc")
        .innerJoin("device_exposures as dx", "dx.id", "dc.exposure_id")
        .innerJoin("devices as d", "d.id", "dx.device_id")
        .select([
          "d.id as device_id",
          "d.workspace_id as workspace_id",
          "dx.id as exposure_id",
          "dx.builtin_kind as builtin_kind",
          "dx.runtime_status as runtime_status",
          "dc.status as status",
        ])
        .where("dc.id", "=", parsed.data.device_capability_id)
        .executeTakeFirst()
      if (!row) {
        reply.status(404).send({
          code: "device_capability_not_found",
          message: `device_capability ${parsed.data.device_capability_id} not found`,
        })
        return
      }
      if (row.workspace_id !== pathWorkspaceId) {
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
      if (row.runtime_status === "offline") {
        reply.status(409).send({
          code: "device_exposure_offline",
          message: "underlying device exposure is offline",
        })
        return
      }
      if (policy.capability !== row.builtin_kind) {
        reply.status(400).send({
          code: "capability_mismatch",
          message: `policy.capability=${policy.capability} but exposure.builtin_kind=${row.builtin_kind}`,
        })
        return
      }

      const session = (request as { session?: { workspaceMemberId?: string } })
        .session

      try {
        const grant = await createRuntimeAuthorizationGrant({
          // Preset fixed to "workspace" — MVP doesn't expose subject-bound
          // grants through this manual path (see file header).
          preset: "workspace",
          workspaceId: pathWorkspaceId,
          deviceId: row.device_id,
          deviceCapabilityId: parsed.data.device_capability_id,
          deviceExposureId: row.exposure_id,
          grantSpec: policy,
          createdByWorkspaceMemberId: session?.workspaceMemberId ?? undefined,
        })
        reply.status(201).send({ grant })
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
