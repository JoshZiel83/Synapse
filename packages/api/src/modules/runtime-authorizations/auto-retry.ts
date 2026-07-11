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
import {
  dateToIsoInstant as dateToWireIsoInstant,
  nowIsoInstant as nowWireIsoInstant,
} from "@synapse/device-protocol/instant"
import type {
  RuntimeAuthorizationRequestedAction,
  RuntimeAuthorizationCommandlinePolicy,
} from "@synapse/shared"
import { dispatchSyncTool } from "../devices/dispatch.js"
import { dispatchBareRuntimeTool } from "../sandbox/bare-dispatch.js"
import { signEnvelopeForDispatch } from "../devices/envelope-signer.js"
import { getRuntimeEndpointRegistry } from "../devices/tunnel-registry.js"
import {
  completeRuntimeOperation,
  type OperationPrincipalKind,
} from "../devices/operations.js"
import {
  selectAndClaimRuntimeAuthorizationGrant,
  toRuntimeAuthorizationGrantWireSpec,
  type PrepareFailure,
  type PreparedDispatch,
  type RuntimeAuthorizationGrantRecord,
} from "./service.js"
import { findAutoRetryTarget } from "./repo.js"

export interface AutoRetryDispatchResult {
  ok: boolean
  /** CallToolResult-shape content payload, ready to drop into a tool result. */
  result?: { content: unknown[]; isError?: boolean; metadata?: unknown }
  errorCode?: string
  errorMessage?: string
}

/**
 * Map a GRANT-side commandline policy (camelCase, discriminated by executor —
 * may be shell / exec_file / sandbox) onto the narrower REQUESTED-ACTION-side
 * commandline shape the matcher consumes. The requested-action union has NO
 * sandbox branch (sandbox is a grant-level "any command in the jail" policy)
 * and its shell branch requires a `commandText`. Kept exhaustive so the
 * compiler enforces the app shape end-to-end.
 *
 * A sandbox grant has no per-command requested-action form → returns undefined.
 * That branch is defensive only: sandboxes are pre-authorized-only (no async
 * approval → no auto-retry), so a sandbox commandline grant never reaches here.
 */
function grantCommandlineToRequestedAction(
  cmd: NonNullable<RuntimeAuthorizationGrantRecord["commandline"]>
): RuntimeAuthorizationCommandlinePolicy | undefined {
  if (cmd.executor === "exec_file") {
    return {
      executor: "exec_file",
      commandMatchType: cmd.commandMatchType,
      program: cmd.program,
      argvPrefix: cmd.argvPrefix,
      workingDirectory: cmd.workingDirectory,
      allowBundledToolchain: cmd.allowBundledToolchain,
      allowedEnv: cmd.allowedEnv,
    }
  }
  if (cmd.executor === "sandbox") {
    return undefined
  }
  return {
    executor: cmd.executor,
    commandMatchType: cmd.commandMatchType,
    commandText: cmd.commandText ?? "",
    workingDirectory: cmd.workingDirectory,
    allowBundledToolchain: cmd.allowBundledToolchain,
    allowedEnv: cmd.allowedEnv,
  }
}

/**
 * Build the APP-shape RuntimeAuthorizationRequestedAction mirror of an approved
 * grant (camelCase throughout: pathPrefixes / scopeType / operations) so the
 * server-side matcher validates coverage without a wire↔app shape mismatch.
 * Exported so auto-retry.test.ts can lock the camelCase contract directly.
 */
export function buildAutoRetryRequestedAction(
  approvedGrant: RuntimeAuthorizationGrantRecord,
  visibleToolName: string
): RuntimeAuthorizationRequestedAction {
  return {
    capability: approvedGrant.capability,
    toolName: visibleToolName,
    summary: `Auto-retry approved grant ${approvedGrant.id}`,
    filesystem: approvedGrant.filesystem
      ? {
          access: approvedGrant.filesystem.access,
          pathPrefixes: approvedGrant.filesystem.pathPrefixes ?? [],
        }
      : undefined,
    cua: approvedGrant.cua ? { access: approvedGrant.cua.access } : undefined,
    browser: approvedGrant.browser
      ? {
          action: approvedGrant.browser.action,
          scopeType: approvedGrant.browser.scopeType,
          origin: approvedGrant.browser.origin,
          host: approvedGrant.browser.host,
          registrableDomain: approvedGrant.browser.registrableDomain,
          // Forward operations[] so the matcher can fail-closed on missing/wrong
          // op. scopeSource is intentionally not propagated — it's request-only.
          operations:
            approvedGrant.browser.operations &&
            approvedGrant.browser.operations.length > 0
              ? approvedGrant.browser.operations
              : undefined,
        }
      : undefined,
    commandline: approvedGrant.commandline
      ? grantCommandlineToRequestedAction(approvedGrant.commandline)
      : undefined,
  }
}

/**
 * Compute the cua_focus_scope_id to stamp into an auto-retry envelope. The
 * device cua builtin keys per-Agent focus state on this string and fails
 * closed when an envelope arrives without it (see
 * device-runtime/src/builtins/cua.ts), so a CUA approval whose retry omits
 * the field would always dispatch a doomed envelope and surface as a stale
 * "approved" notice in the UI.
 *
 * Auto-retry only has `initiatedBySessionId` from the audit context, not the
 * full RuntimePrincipal — so we use the same `session:<id>` primary key
 * deriveCuaFocusScopeId would have produced for the original projection
 * dispatch. The principal-derived fallback table is intentionally NOT
 * reproduced here: when sessionId is missing we return undefined and let
 * the device-side fail-closed check fire, rather than silently bucketing the
 * call under a default focus key (which could let concurrent Agents stomp
 * on each other's CUA focus). Non-cua grants always return undefined so
 * non-cua tool envelopes stay byte-identical to v2.
 */
export function cuaFocusScopeForAutoRetry(args: {
  capability: string
  initiatedBySessionId: string | null
}): string | undefined {
  if (args.capability !== "cua") return undefined
  if (!args.initiatedBySessionId) return undefined
  return `session:${args.initiatedBySessionId}`
}

/**
 * Re-dispatch the original tool call with the freshly approved grant +
 * retry_nonce baked into the envelope. The caller hands us the EXACT args
 * the user originally tried (sourceRequestArgs persisted on the
 * tool_call_task_runtime_authorization row) — we do not let the
 * model re-author them.
 */
export async function autoDispatchRuntimeAuthorizationRetry(args: {
  runtimeCapabilityId: string
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
  const target = await findAutoRetryTarget({
    runtimeCapabilityId: args.runtimeCapabilityId,
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
  const inputHash = `sha256:${createHash("sha256").update(inputCanonical).digest("hex")}`

  // Build the requested action mirror of the approved grant so the canonical
  // helper's matcher still validates "this grant covers this action". The
  // approved grant already passed the action match (otherwise the approval
  // wouldn't have been issued), so this is defensive coverage rather than a
  // gate, but it keeps the canonical helper invariants honest.
  //
  // CRITICAL: the mirror is the APP-shape RuntimeAuthorizationRequestedAction
  // (camelCase pathPrefixes / scopeType / …) — the exact shape the matcher
  // (filesystemPolicyMatches / commandlinePolicyMatches / browserPolicyMatches)
  // reads. It is NOT the snake_case wire spec. Emitting the wire spec here
  // (path_prefixes / scope_type / serializeCommandlinePolicyToWire) left the
  // matcher reading `undefined.length` (filesystem TypeError) and silently
  // no-matching commandline/browser. buildAutoRetryRequestedAction returns the
  // typed app shape so the compiler enforces it — no `as unknown as` cast.
  const requestedAction = buildAutoRetryRequestedAction(
    args.approvedGrant,
    args.visibleToolName
  )

  const claim = await selectAndClaimRuntimeAuthorizationGrant({
    workspaceId: args.audit.workspaceId,
    runtimeId: target.runtimeId,
    runtimeCapabilityId: args.runtimeCapabilityId,
    runtimeExposureId: target.runtimeExposureId,
    runtimeSubjectIds: args.runtimeSubjectIds,
    runtimeScopeSubjectIds: args.runtimeScopeSubjectIds,
    retryNonce: args.sourceRetryNonce,
    sourceTaskId: args.sourceTaskId,
    requestedAction,
    preferredGrantId: args.approvedGrant.id,
    prepareGrant: async (
      grant: RuntimeAuthorizationGrantRecord
    ): Promise<
      | { ok: true; prepared: PreparedDispatch }
      | { ok: false; failure: PrepareFailure }
    > => {
      try {
        // For CUA tools: stamp cua_focus_scope_id with the same
        // `session:<id>` value the projection dispatcher would have computed
        // for the original request. The device cua builtin fails closed on
        // cua envelopes that omit this field (see
        // device-runtime/src/builtins/cua.ts), so without injection the
        // user-approved auto-retry would always dispatch a doomed envelope
        // and surface as a stale "approved" notice.
        //
        // Derivation lives in cuaFocusScopeForAutoRetry so it's directly
        // testable — see auto-retry.test.ts.
        const cuaFocusScopeId = cuaFocusScopeForAutoRetry({
          capability: args.approvedGrant.capability,
          initiatedBySessionId: args.audit.initiatedBySessionId,
        })
        const envelope = signEnvelopeForDispatch({
          operation_id: randomUUID(),
          attempt_id: randomUUID(),
          runtime_session_id: randomUUID(),
          runtime_capability_id: args.runtimeCapabilityId,
          runtime_exposure_id: target.runtimeExposureId,
          runtime_tool_id: target.runtimeToolId,
          runtime_tool_revision_id: target.runtimeToolRevisionId,
          input_hash: inputHash,
          task_mode: "sync" as const,
          runtime_authorization: {
            grant_ids: [grant.id],
            grant_scope: grant.scopeLabel,
            grant_specs: [toRuntimeAuthorizationGrantWireSpec(grant)],
            retry_nonce: args.sourceRetryNonce,
          },
          ...(cuaFocusScopeId ? { cua_focus_scope_id: cuaFocusScopeId } : {}),
          issued_at: nowWireIsoInstant(),
          expires_at: dateToWireIsoInstant(new Date(Date.now() + 60_000)),
        })
        return {
          ok: true,
          prepared: {
            envelope,
            toolId: target.runtimeToolId,
            toolRevisionId: target.runtimeToolRevisionId,
            beginInput: {
              workspaceId: args.audit.workspaceId,
              conversationId: args.audit.conversationId,
              envelope,
              args: args.sourceRequestArgs,
              toolName: args.visibleToolName,
              runtimeId: target.runtimeId,
              runtimeServiceId: target.runtimeServiceId,
              // Bare (Mode-B) auto-retry writes transport='data_plane' + NULL
              // tunnel_internal_url; resident is unchanged (defaults mcp_http).
              transport:
                target.serviceKind === "bare_dataplane"
                  ? "data_plane"
                  : undefined,
              tunnelInternalUrl:
                target.serviceKind === "bare_dataplane"
                  ? null
                  : (getRuntimeEndpointRegistry().resolve(
                      target.runtimeServiceId
                    )?.internalUrl ?? null),
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

  const { prepared, operation, grant } = claim
  const operationId = operation.operationId
  const attemptId = operation.attemptId

  // Mode-B fork (F-B): a bare_dataplane target routes to the in-process/remote
  // data plane; device/resident targets ALWAYS resolve 'device_runtime' and take
  // the unchanged dispatchSyncTool (A3). Same McpDispatchResult shape.
  const dispatchResult =
    target.serviceKind === "bare_dataplane"
      ? await dispatchBareRuntimeTool({
          runtimeId: target.runtimeId,
          runtimeServiceId: target.runtimeServiceId,
          envelope: prepared.envelope,
          args: args.sourceRequestArgs,
          builtinKind: args.approvedGrant.capability,
          toolName: args.visibleToolName,
          grant,
        })
      : await dispatchSyncTool({
          runtimeServiceId: target.runtimeServiceId,
          envelope: prepared.envelope,
          args: args.sourceRequestArgs,
          toolName: args.visibleToolName,
        })
  await completeRuntimeOperation({
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
