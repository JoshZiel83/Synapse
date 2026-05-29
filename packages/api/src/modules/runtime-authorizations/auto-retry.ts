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
import { serializeCommandlinePolicyToWire } from "@synapse/shared/access/policies"
import { db } from "../../infrastructure/database/kysely.js"
import { dispatchSyncTool } from "../devices/dispatch.js"
import { signEnvelopeForDispatch } from "../devices/envelope-signer.js"
import { getDeviceTunnelRegistry } from "../devices/tunnel-registry.js"
import {
  completeDeviceOperation,
  type OperationPrincipalKind,
} from "../devices/operations.js"
import {
  selectAndClaimRuntimeAuthorizationGrant,
  toRuntimeAuthorizationGrantWireSpec,
  type PrepareFailure,
  type PreparedDispatch,
  type RuntimeAuthorizationGrantRecord,
} from "./service.js"

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
  sourceTaskId: string
  approvedGrant: RuntimeAuthorizationGrantRecord
  /**
   * subject-scope-refactor: the principal-side runtime subject set built
   * from the post-commit RuntimePrincipalContext. Passed verbatim to
   * selectAndClaimRuntimeAuthorizationGrant so the same SQL-side subject +
   * scope filtering that protects normal dispatch also protects auto-retry
   * (e.g. an actor who left the conversation between approval and retry
   * must NOT be able to claim a `actor + scope=conversation` grant).
   */
  runtimeSubjectIds: string[]
  runtimeScopeSubjectIds: string[]
  audit: {
    workspaceId: string
    conversationId: string | null
    principalKind: OperationPrincipalKind
    principalSubjectId: string
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

  // Build the requested action mirror of the approved grant so the canonical
  // helper's matcher still validates "this grant covers this action". The
  // approved grant already passed the action match (otherwise the approval
  // wouldn't have been issued), so this is defensive coverage rather than a
  // gate, but it keeps the canonical helper invariants honest.
  const requestedAction = {
    capability: args.approvedGrant.capability,
    summary: `Auto-retry approved grant ${args.approvedGrant.id}`,
    detail: undefined,
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
      ? serializeCommandlinePolicyToWire(args.approvedGrant.commandline)
      : undefined,
  } as const

  const claim = await selectAndClaimRuntimeAuthorizationGrant({
    workspaceId: args.audit.workspaceId,
    deviceId: target.deviceId,
    deviceCapabilityId: args.deviceCapabilityId,
    deviceExposureId: target.deviceExposureId,
    runtimeSubjectIds: args.runtimeSubjectIds,
    runtimeScopeSubjectIds: args.runtimeScopeSubjectIds,
    retryNonce: args.sourceRetryNonce,
    sourceTaskId: args.sourceTaskId,
    requestedAction:
      requestedAction as unknown as import("@synapse/shared").RuntimeAuthorizationRequestedAction,
    preferredGrantId: args.approvedGrant.id,
    prepareGrant: async (
      grant: RuntimeAuthorizationGrantRecord
    ): Promise<
      | { ok: true; prepared: PreparedDispatch }
      | { ok: false; failure: PrepareFailure }
    > => {
      try {
        const envelope = signEnvelopeForDispatch({
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
            grant_ids: [grant.id],
            grant_scope: grant.scopeLabel,
            grant_specs: [toRuntimeAuthorizationGrantWireSpec(grant)],
            retry_nonce: args.sourceRetryNonce,
          },
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        })
        return {
          ok: true,
          prepared: {
            envelope,
            toolId: target.deviceToolId,
            toolRevisionId: target.deviceToolRevisionId,
            beginInput: {
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
              initiatedByWorkspaceMemberId:
                args.audit.initiatedByWorkspaceMemberId,
              initiatedBySessionId: args.audit.initiatedBySessionId,
            },
          },
        }
      } catch (err) {
        return { ok: false, failure: { kind: "signing_failed", cause: err } }
      }
    },
  })

  if (claim.kind === "no_match") {
    return {
      ok: false,
      errorCode: "runtime_constraint",
      errorMessage: "approved grant no longer matches the requested action",
    }
  }
  if (claim.kind === "race_lost") {
    return {
      ok: false,
      errorCode: "runtime_constraint",
      errorMessage: `auto-retry race lost (${claim.reason})`,
    }
  }
  if (claim.kind === "lock_timeout") {
    return {
      ok: false,
      errorCode: "runtime_constraint",
      errorMessage: "catalog lock_timeout during auto-retry",
    }
  }
  if (claim.kind === "denied") {
    return {
      ok: false,
      errorCode: "runtime_constraint",
      errorMessage: claim.reason,
    }
  }

  const { prepared, operation } = claim
  const operationId = operation.operationId
  const attemptId = operation.attemptId

  const dispatchResult = await dispatchSyncTool({
    deviceServiceId: target.deviceServiceId,
    envelope: prepared.envelope,
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
