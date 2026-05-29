// Device-side commandline runtime authorization gate.
//
// Single entry point for the commandline builtin (bash / powershell /
// exec_file tools): take the signed envelope's grant_specs, narrow to the
// commandline policies, attempt to find one that matches the request, and
// return the normalized policy on hit (so the caller can read
// allowBundledToolchain / allowedEnv to drive resolver + executor) or
// build a structured tool error on miss.

import {
  commandlinePolicyAllows,
  parseCommandlinePolicyFromWire,
  type CommandlineMatchRequest,
  type NormalizedCommandlinePolicy,
} from "@synapse/shared/access/policies"
import { normalizeDevicePlatform } from "@synapse/shared"
import type {
  OperationEnvelope,
  RuntimeCommandlinePolicy,
} from "@synapse/device-protocol"

import type { CatalogToolInvocationResult } from "../types.js"
import { toolErrorResult } from "../mcp-host.js"

export interface CommandlineAuthorizationDecision {
  ok: true
  policy: NormalizedCommandlinePolicy
}

export interface CommandlineAuthorizationDenial {
  ok: false
  tool: CatalogToolInvocationResult
}

export type CommandlineAuthorizationResult =
  | CommandlineAuthorizationDecision
  | CommandlineAuthorizationDenial

export interface CheckCommandlineAccessInput {
  /** Envelope from MCP _meta.synapse_operation (mcp-host already verified the signature). */
  envelope: OperationEnvelope | undefined
  /** Discriminated request describing the tool invocation. */
  request: CommandlineMatchRequest
  /** Diagnostic context for permission_denied messages. */
  toolName: string
}

/**
 * Returns the matched + normalized commandline policy or a ready-to-return
 * tool error. Caller still needs to apply Windows / args validation guards
 * BEFORE calling here (those produce invalid_request, which is a stronger
 * signal than permission_denied).
 */
export function checkCommandlineAccess(
  input: CheckCommandlineAccessInput
): CommandlineAuthorizationResult {
  // When no envelope is present, the mcp-host's fail-closed dispatch gate
  // already rejected the call (or the host is running in test mode without
  // an envelope verifier). Either way, this builtin's job is to enforce
  // the grant policy when one was attached; with no envelope we have
  // nothing to match against, and refusing here would break the loopback
  // smoke tests that bypass envelope signing. Return a permissive open
  // pass-through that still carries a normalized empty policy so the
  // executor sees allowedEnv: [] / allowBundledToolchain: undefined.
  if (!input.envelope) {
    return {
      ok: true,
      policy:
        input.request.kind === "shell"
          ? {
              executor: input.request.executor,
              commandMatchType: "exact",
              commandText: input.request.command,
            }
          : {
              executor: "exec_file",
              commandMatchType: "argv_exact",
              program: input.request.program,
              argvPrefix: [...input.request.argv],
            },
    }
  }
  const grantSpecs = input.envelope.runtime_authorization?.grant_specs ?? []
  const wirePolicies = grantSpecs
    .filter((g) => g.capability === "commandline" && g.commandline)
    .map((g) => g.commandline as RuntimeCommandlinePolicy)

  if (wirePolicies.length === 0) {
    return {
      ok: false,
      tool: toolErrorResult({
        code: "permission_denied",
        message: `no runtime_authorization grant covers capability='commandline' for tool ${input.toolName}`,
      }),
    }
  }
  for (const wire of wirePolicies) {
    let normalized: NormalizedCommandlinePolicy
    try {
      // The shared serializer is the canonical translator; this guarantees
      // device and server read every field with the same mapping.
      normalized = parseCommandlinePolicyFromWire(wire)
    } catch {
      // A malformed wire policy is treated as "no match" rather than a
      // hard error — there may be other grants on the envelope that do
      // match.
      continue
    }
    const hit = commandlinePolicyAllows(normalized, input.request)
    if (hit) {
      return { ok: true, policy: hit }
    }
  }
  return {
    ok: false,
    tool: toolErrorResult({
      code: "permission_denied",
      message:
        input.request.kind === "shell"
          ? `${input.request.executor} command not covered by any commandline grant policy: ${input.request.command.slice(0, 80)}`
          : `exec_file ${input.request.program} ${input.request.argv.join(" ").slice(0, 80)} not covered by any commandline grant policy`,
    }),
  }
}

/** Re-export so the builtin only needs one import. */
export { normalizeDevicePlatform }
