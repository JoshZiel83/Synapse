// Server-side auto-retry for runtime authorization approvals.
//
// Closes the loop the planner-vs-projection retry_nonce flow opened: when a
// runtime authorization request is approved, this helper re-dispatches the
// original tool call directly via the device dispatcher (skipping the
// chat-runtime planner) so the user doesn't have to wait for the model to
// "notice" the approval and "guess" to inject the magic retry_nonce arg.
// The actual envelope carries the retry_nonce on the wire as a structured
// field (envelope.runtime_authorization.retry_nonce) so the device can
// re-use the same `once` grant safely.
//
// The result of this dispatch is what populates the task notice payload —
// the model sees the actual tool output (success or failure) rather than
// a placeholder "an authorized user approved your request" string.

import { randomUUID, createHash } from "node:crypto"
import { canonicalizeEnvelopePayload } from "@synapse/device-protocol"
import { db } from "../../infrastructure/database/kysely.js"
import { dispatchSyncTool } from "../devices/dispatch.js"
import { signEnvelopeForDispatch } from "../devices/envelope-signer.js"
import { getDeviceTunnelRegistry } from "../devices/tunnel-registry.js"
import {
  beginDeviceOperation,
  completeDeviceOperation,
  RevisionDriftError,
  type OperationPrincipalKind,
} from "../devices/operations.js"
import {
  consumeRuntimeAuthorizationGrant,
  type RuntimeAuthorizationGrantRecord,
} from "./service.js"
import type { RuntimeAuthorizationGrantSpec } from "@synapse/device-protocol"

export interface AutoRetryDispatchResult {
  ok: boolean
  /** CallToolResult-shape content payload, ready to drop into a tool result. */
  result?: { content: unknown[]; isError?: boolean; metadata?: unknown }
  errorCode?: string
  errorMessage?: string
}

/**
 * Look up the device tool runtime target (service id, tool revision, etc.)
 * for a freshly approved runtime authorization. Returns null when any piece
 * is missing — caller must fall back to the static approval notice in that
 * case (e.g. the device went offline between request and approval).
 */
async function resolveAutoRetryTarget(args: {
  deviceCapabilityId: string
  visibleToolName: string
}): Promise<{
  deviceId: string
  deviceServiceId: string
  deviceExposureId: string
  deviceToolId: string
  deviceToolRevisionId: string
} | null> {
  const row = await db
    .selectFrom("device_capabilities as dc")
    .innerJoin("device_exposures as dx", "dx.id", "dc.exposure_id")
    .innerJoin("devices as d", "d.id", "dx.device_id")
    .innerJoin("device_tools as dt", "dt.exposure_id", "dx.id")
    .innerJoin(
      "device_tool_revisions as dtr",
      "dtr.id",
      "dt.latest_revision_id"
    )
    .select([
      "d.id as device_id",
      "dx.service_id as device_service_id",
      "dx.id as device_exposure_id",
      "dt.id as device_tool_id",
      "dtr.id as device_tool_revision_id",
    ])
    .where("dc.id", "=", args.deviceCapabilityId)
    .where("dt.current_name", "=", args.visibleToolName)
    .where("dt.status", "=", "active")
    .limit(1)
    .executeTakeFirst()
  if (!row) return null
  return {
    deviceId: row.device_id as string,
    deviceServiceId: row.device_service_id as string,
    deviceExposureId: row.device_exposure_id as string,
    deviceToolId: row.device_tool_id as string,
    deviceToolRevisionId: row.device_tool_revision_id as string,
  }
}

/**
 * Re-dispatch the original tool call with the freshly approved grant +
 * retry_nonce baked into the envelope. The caller hands us the EXACT args
 * the user originally tried (sourceRequestArgs persisted on the
 * interaction_runtime_authorization_requests row) — we do not let the
 * model re-author them.
 */
export async function autoDispatchRuntimeAuthorizationRetry(args: {
  deviceCapabilityId: string
  /** What the planner/projection called the tool when dispatching — the
   * device-side stable_key, same value passed as params.name. */
  visibleToolName: string
  sourceRequestArgs: Record<string, unknown>
  sourceRetryNonce: string
  approvedGrant: RuntimeAuthorizationGrantRecord
  /** Audit context — required to thread device_operations + attempts so
   * the dashboard still sees the auto-retry dispatch in its audit trail.
   * Without these the dispatch happens "outside" the audit log and any
   * downstream investigation has no operation row to anchor on. */
  audit: {
    workspaceId: string
    conversationId: string | null
    principalKind: OperationPrincipalKind
    principalSubjectId: string | null
    initiatedBySessionId: string | null
    initiatedByWorkspaceMemberId: string | null
  }
}): Promise<AutoRetryDispatchResult> {
  const target = await resolveAutoRetryTarget({
    deviceCapabilityId: args.deviceCapabilityId,
    visibleToolName: args.visibleToolName,
  })
  if (!target) {
    return {
      ok: false,
      errorCode: "runtime_constraint",
      errorMessage: `device tool ${args.visibleToolName} not currently in catalog`,
    }
  }
  // input_hash is computed over the same canonical JSON the device will
  // re-hash on receive — keep these in lock-step or the device's envelope
  // verifier will reject with "input_hash mismatch".
  const inputCanonical = canonicalizeEnvelopePayload(args.sourceRequestArgs)
  const inputHash =
    "sha256:" + createHash("sha256").update(inputCanonical).digest("hex")

  // Translate the approved GrantRecord (camelCase) into the wire-shape
  // GrantSpec the envelope expects. We carry exactly ONE grant_spec — the
  // grant the user just approved — so the device-side matcher has the
  // narrowest possible authorization to apply.
  const spec: RuntimeAuthorizationGrantSpec = {
    capability: args.approvedGrant.capability,
    filesystem: args.approvedGrant.filesystem
      ? {
          access: args.approvedGrant.filesystem.access,
          path_prefixes: args.approvedGrant.filesystem.pathPrefixes ?? [],
        }
      : undefined,
    cua: args.approvedGrant.cua
      ? { access: args.approvedGrant.cua.access }
      : undefined,
    browser: args.approvedGrant.browser
      ? {
          action: args.approvedGrant.browser.action,
          scope_type: args.approvedGrant.browser.scopeType,
          origin: args.approvedGrant.browser.origin,
          host: args.approvedGrant.browser.host,
          registrable_domain: args.approvedGrant.browser.registrableDomain,
          // v3.1: forward operations[] on the wire so the runtime matcher
          // can fail-closed on missing/wrong op. scopeSource is intentionally
          // not propagated — it's a request-only signal.
          operations:
            args.approvedGrant.browser.operations &&
            args.approvedGrant.browser.operations.length > 0
              ? args.approvedGrant.browser.operations
              : undefined,
        }
      : undefined,
    commandline: args.approvedGrant.commandline
      ? {
          executor: args.approvedGrant.commandline.executor,
          command_match_type: args.approvedGrant.commandline.commandMatchType,
          command_text: args.approvedGrant.commandline.commandText,
          working_directory: args.approvedGrant.commandline.workingDirectory,
        }
      : undefined,
  }

  let envelope
  try {
    envelope = signEnvelopeForDispatch({
      operation_id: randomUUID(),
      attempt_id: randomUUID(),
      device_runtime_session_id: randomUUID(),
      device_capability_id: args.deviceCapabilityId,
      device_exposure_id: target.deviceExposureId,
      device_tool_id: target.deviceToolId,
      device_tool_revision_id: target.deviceToolRevisionId,
      input_hash: inputHash,
      task_mode: "sync" as const,
      runtime_authorization: {
        grant_ids: [args.approvedGrant.id],
        grant_scope: args.approvedGrant.scope,
        grant_specs: [spec],
        retry_nonce: args.sourceRetryNonce,
      },
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    })
  } catch (err) {
    return {
      ok: false,
      errorCode: "runtime_constraint",
      errorMessage: `auto-retry envelope signing failed: ${(err as Error).message}`,
    }
  }

  // Open a device_operations + first device_operation_attempts row pair
  // BEFORE dispatch so the auto-retry shows up in the same audit trail the
  // normal projection executor produces. Without this the user-approved
  // re-dispatch has no operation row, and dashboards / downstream events
  // can't tie the resulting side-effect back to the interaction.
  let operationId: string
  let attemptId: string
  try {
    const begin = await beginDeviceOperation({
      workspaceId: args.audit.workspaceId,
      conversationId: args.audit.conversationId,
      envelope,
      args: args.sourceRequestArgs,
      toolName: args.visibleToolName,
      deviceId: target.deviceId,
      deviceServiceId: target.deviceServiceId,
      tunnelInternalUrl:
        getDeviceTunnelRegistry().resolve(target.deviceServiceId)
          ?.internalUrl ?? null,
      principalKind: args.audit.principalKind,
      principalSubjectId: args.audit.principalSubjectId,
      initiatedByWorkspaceMemberId: args.audit.initiatedByWorkspaceMemberId,
      initiatedBySessionId: args.audit.initiatedBySessionId,
    })
    operationId = begin.operationId
    attemptId = begin.attemptId
  } catch (err) {
    if (err instanceof RevisionDriftError) {
      return {
        ok: false,
        errorCode: "tool_definition_changed",
        errorMessage: err.message,
      }
    }
    return {
      ok: false,
      errorCode: "runtime_constraint",
      errorMessage: `device_operations insert failed: ${(err as Error).message}`,
    }
  }

  const dispatchResult = await dispatchSyncTool({
    deviceServiceId: target.deviceServiceId,
    envelope,
    args: args.sourceRequestArgs,
    toolName: args.visibleToolName,
  })
  await completeDeviceOperation({
    operationId,
    attemptId,
    ok: dispatchResult.ok,
    error: dispatchResult.error,
  }).catch(() => {
    /* operation-complete logging is best-effort */
  })

  // Consume `once` grants we used on success — without this, the auto-retry
  // path would leave them active so a subsequent dispatch by the planner
  // would reuse a single-shot grant.
  if (dispatchResult.ok && args.approvedGrant.scope === "once") {
    await consumeRuntimeAuthorizationGrant(args.approvedGrant.id).catch(
      () => undefined
    )
  }

  if (!dispatchResult.ok) {
    return {
      ok: false,
      errorCode: dispatchResult.error?.code,
      errorMessage: dispatchResult.error?.message,
    }
  }

  const callToolResult = (dispatchResult.result ?? {}) as {
    content?: unknown[]
    isError?: boolean
    _meta?: unknown
  }
  return {
    ok: true,
    result: {
      content: callToolResult.content ?? [],
      isError: callToolResult.isError,
      metadata: callToolResult._meta,
    },
  }
}
