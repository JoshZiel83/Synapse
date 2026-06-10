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
import { z } from "zod"
import { formatValidationDetails } from "../../infrastructure/validation-error.js"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { requireRequestAction } from "../access/guards.js"
import { db } from "../../infrastructure/database/kysely.js"
import {
  BrowserGrantPolicyError,
  GrantPolicySchema,
} from "@synapse/shared/access/policies"
import { workspaceRef } from "@synapse/shared"
import {
  BROWSER_EXPOSURE_TOOLS,
  BROWSER_TOOL_MAP,
} from "@synapse/device-protocol/browser-tools"
import { createRuntimeAuthorizationGrant } from "./service.js"

const manualGrantBodySchema = z.object({
  device_capability_id: z.uuid(),
  policy: z.unknown(), // validated below via GrantPolicySchema
})

/**
 * For a given exposure stable_key (e.g. `builtin/browser/navigation`),
 * return the set of BrowserOperation values that any tool in the exposure
 * would ever request. Used to prevent operators from granting operations
 * the exposure can't actually trigger.
 *
 * Returns `null` for exposures that aren't from the chrome-devtools-mcp
 * provider (legacy `builtin/browser`, custom builtins, etc.) — those
 * fall through to capability-level matching only.
 */
function allowedBrowserOperationsForExposureStableKey(
  stableKey: string
): Set<string> | null {
  // Stable keys defined by BROWSER_EXPOSURE_STABLE_KEYS:
  //   builtin/browser/{navigation,read,input,network,performance,script,extensions,webmcp}
  const suffix = stableKey.startsWith("builtin/browser/")
    ? stableKey.slice("builtin/browser/".length)
    : null
  if (!suffix) return null
  const tools = (BROWSER_EXPOSURE_TOOLS as Record<string, string[]>)[suffix]
  if (!tools) return null
  const ops = new Set<string>()
  for (const t of tools) {
    const desc = BROWSER_TOOL_MAP[t]
    if (desc) ops.add(desc.operation)
  }
  return ops
}

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
        reply.status(400).send({
          code: "invalid_request",
          details: formatValidationDetails(parsed.error),
        })
        return
      }

      // Validate GrantPolicy shape (BrowserPolicy.strip() drops any stray
      // scopeSource on the way in — see plan §clarification #10).
      const policyParse = GrantPolicySchema.safeParse(parsed.data.policy)
      if (!policyParse.success) {
        reply.status(400).send({
          code: "invalid_request",
          message: "policy did not match GrantPolicySchema",
          details: formatValidationDetails(policyParse.error),
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
        .selectFrom("deviceCapabilities as dc")
        .innerJoin("workspaceApps as app", "app.id", "dc.id")
        .innerJoin("deviceExposures as dx", "dx.id", "dc.exposureId")
        .innerJoin("devices as d", "d.id", "dx.deviceId")
        .select([
          "d.id as deviceId",
          "app.workspaceId as workspaceId",
          "dx.id as exposureId",
          "dx.stableKey as exposureStableKey",
          "dx.builtinKind as builtinKind",
          "dx.runtimeStatus as runtimeStatus",
          "app.status as status",
        ])
        .where("dc.id", "=", parsed.data.device_capability_id)
        .where("app.deletedAt", "is", null)
        .executeTakeFirst()
      if (!row) {
        reply.status(404).send({
          code: "device_capability_not_found",
          message: `device_capability ${parsed.data.device_capability_id} not found`,
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
        const allowedOps = allowedBrowserOperationsForExposureStableKey(
          row.exposureStableKey as string
        )
        if (allowedOps) {
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
          deviceCapabilityId: parsed.data.device_capability_id,
          deviceExposureId: row.exposureId,
          subject: workspaceRef(pathWorkspaceId),
          retention: "until_revoked",
          policy,
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
