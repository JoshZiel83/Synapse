// @synapse/api/src/modules/capability-projection
// Unified tool projection per docs/device-runtime-v3.md §11.
//
// Single canonical entry point used by chat runtime and reverse MCP. Delegates
// to mcp-plugins/tool-resolver.ts for plugin projections, then unions
// device_capability tools alongside so the planner sees device-side bash /
// list_dir / etc. alongside MCP plugins. Device dispatch goes through
// DeviceTunnelRegistry + the synchronous tools/call client in
// devices/dispatch.ts; every dispatch opens a device_operations + first
// device_operation_attempts row pair (see devices/operations.ts).

import { randomUUID } from "node:crypto"
import type {
  ToolDefinition,
  NormalizedMcpToolResult,
  RuntimeActorContext,
  ConversationBoundary,
  CanonicalContentBlock,
} from "@synapse/shared/types"
import { SUBJECT_KIND, textBlock } from "@synapse/shared"
// subject-scope-refactor: RUNTIME_AUTHORIZATION_GRANT_SCOPE now sourced from
// the runtime-authorizations service shim (deprecated; the wire-stable scope
// labels are derived from subject/scope SubjectRef pair via subjectScopeLabel).
import type { RuntimeAuthorizationGrantSpec as RuntimeAuthorizationGrantWireSpec } from "@synapse/device-protocol"
import type { McpExecutionContext } from "../mcp-plugins/instance-manager.js"
import {
  resolveMcpToolsForActor,
  resolveMcpToolsForRemoteAgent,
  type ResolvedMcpTools,
} from "../mcp-plugins/tool-resolver.js"
import { db } from "../../infrastructure/database/kysely.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { ensureConversationActorContext } from "../session/service.js"
import { dispatchSyncTool } from "../devices/dispatch.js"
import { signEnvelopeForDispatch } from "../devices/envelope-signer.js"
import { canonicalizeEnvelopePayload } from "@synapse/device-protocol"
import type { RuntimeAuthorizationGrantSpec } from "@synapse/device-protocol"
import { createHash } from "node:crypto"
import {
  listActiveRuntimeAuthorizationGrantsForExposure,
  consumeRuntimeAuthorizationGrant,
  runtimeAuthorizationGrantMatches,
  RUNTIME_AUTHORIZATION_GRANT_SCOPE,
  type RuntimeAuthorizationGrantRecord,
} from "../runtime-authorizations/service.js"
import { createRuntimeAuthorizationRequest } from "../runtime-authorizations/requests.js"
import type { RuntimeAuthorizationRequestedAction } from "@synapse/shared"
import {
  beginDeviceOperation,
  completeDeviceOperation,
  RevisionDriftError,
  type OperationPrincipalKind,
} from "../devices/operations.js"
import { getDeviceTunnelRegistry } from "../devices/tunnel-registry.js"
import {
  loadDeviceCapabilityToolsForSubjects,
  type DeviceCapabilityToolRow,
} from "./device-capabilities.js"
import { getWorkspaceCapabilityConversationTypePolicyMap } from "../capabilities/conversation-type-policies.js"
import {
  maskAllowsConversationType,
  resolveNarrowedConversationTypeMask,
} from "@synapse/shared"

/**
 * Discriminated union of principals that capability projection evaluates
 * tools for. See docs/device-runtime-v3.md §10.3.
 *
 * - `actor` with optional conversationId — chat runtime acting on behalf of
 *   an actor. When conversationId is provided, projection ALSO reads
 *   conversation-scoped bindings (the 1:1 device-picker output).
 * - `actor_in_conversation` — group-chat actor, anchored to a specific
 *   conversation_actor_context.
 * - `conversation` — transcript-side jobs with no actor in play.
 * - `remote_agent` — reverse MCP caller bridged into a conversation.
 * - `workspace_member` — dashboard introspection; never used for executable
 *   dispatch.
 */
export type DevicePrincipal =
  | { kind: "actor"; actorId: string; conversationId?: string }
  | { kind: "conversation"; conversationId: string }
  | {
      kind: "actor_in_conversation"
      conversationActorContextId: string
      actorId: string
      conversationId: string
    }
  | { kind: "remote_agent"; remoteAgentId: string; conversationId: string }
  | {
      kind: "workspace_member"
      workspaceId: string
      workspaceMemberId: string
    }

/**
 * Consumer kind controls permission semantics. See docs/device-runtime-v3.md §11:
 *
 * - `chat_runtime` / `reverse_mcp` — only count explicit `use` grants from
 *   resource_access_bindings; manageable resources are NOT auto-included so
 *   the active-device picker actually narrows chat surface.
 * - `dashboard` — also counts `view` / `manage`-derived permissions.
 */
export type CapabilityProjectionConsumer =
  | "chat_runtime"
  | "reverse_mcp"
  | "dashboard"

export interface ProjectToolsInput extends Omit<
  RuntimeActorContext,
  "actorId"
> {
  workspaceId: string
  principal: DevicePrincipal
  conversationId?: string
  conversationKind?: "private" | "group" | "virtual"
  conversationBoundary?: ConversationBoundary
  consumer: CapabilityProjectionConsumer
}

/**
 * Projection output preserves the existing ResolvedMcpTools surface so callers
 * can swap in without touching their dispatch loop. PR #7 will additionally
 * surface device-attributed bindings via the binding/origin discriminator
 * documented in docs/device-runtime-v3.md §11 outputs section.
 */
export type ProjectedToolList = ResolvedMcpTools

/**
 * Single canonical entry point. Routes to the legacy actor / remote_agent
 * resolver in v3.0 skeleton; PR #7 extends it to union device_capability
 * exposures.
 */
export async function projectToolsForPrincipal(
  input: ProjectToolsInput
): Promise<ProjectedToolList> {
  const legacy = await projectLegacyTools(input)
  const device = await projectDeviceTools(input)
  if (device.tools.length === 0) return legacy
  return unionWithDevice(input, legacy, device)
}

async function projectLegacyTools(
  input: ProjectToolsInput
): Promise<ProjectedToolList> {
  const { principal } = input
  switch (principal.kind) {
    case "actor":
    case "actor_in_conversation":
    case "conversation": {
      // chat-runtime / dashboard delegate to the actor resolver. For
      // `conversation` (no actor in play) we pass an empty actor identity;
      // the legacy resolver tolerates this for workspace-scoped bindings.
      const actorId = principal.kind === "conversation" ? "" : principal.actorId
      const conversationId =
        principal.kind === "conversation"
          ? principal.conversationId
          : (principal.conversationId ?? input.conversationId ?? "")
      if (!conversationId) {
        throw new Error(
          "capability-projection: conversationId is required for chat-runtime principals"
        )
      }
      if (!actorId) {
        // Pure-conversation: no actor identity in play. The legacy MCP plugin
        // resolver requires an actorId; for this principal we skip the legacy
        // resolver entirely and let the device-tool projection (which doesn't
        // require an actorId) carry the surface alone.
        return {
          tools: [],
          executor: async () =>
            mcpErrorBlock(
              "no executable plugin tools in pure-conversation principal"
            ),
          mcpVersion: 0,
          refresh: async () => ({ tools: [], mcpVersion: 0 }),
          setTurnId: () => {},
          shutdown: async () => {},
        }
      }
      return resolveMcpToolsForActor({
        ...input,
        actorId,
        conversationId,
      })
    }
    case "remote_agent": {
      return resolveMcpToolsForRemoteAgent({
        ...input,
        conversationId: principal.conversationId,
        remoteAgentId: principal.remoteAgentId,
      })
    }
    case "workspace_member": {
      // Dashboard introspection is not yet exposed through this module — its
      // current callers use the access evaluator directly. v3 reserves this
      // branch for the future projection-backed dashboard rendering.
      throw new Error(
        "capability-projection: workspace_member principal is dashboard-only and not yet wired"
      )
    }
  }
}

interface DeviceToolBundle {
  tools: ToolDefinition[]
  handlers: Map<string, DeviceCapabilityToolRow>
  subjects: ResolvedPrincipalSubjects
}

// Tools we project from device_capabilities are namespaced so they cannot
// collide with MCP-plugin tools that happen to share a bare name.
const DEVICE_TOOL_PREFIX = "device__"

function namespaceDeviceToolName(row: DeviceCapabilityToolRow): string {
  return `${DEVICE_TOOL_PREFIX}${row.device_capability_id}__${row.visible_tool_name}`
}

/**
 * Resolved subject ids for a principal. `workspaceSubjectId` is always
 * populated (every caller can see workspace-scoped bindings). The
 * principal-specific subject id (actor / conversation / context /
 * remote_agent) is the one used for audit + grant filtering — never use
 * `workspaceSubjectId` as the "principal" identity or the audit row will
 * mis-attribute the operation to the workspace bucket.
 */
export interface ResolvedPrincipalSubjects {
  workspaceSubjectId: string
  principalSubjectId: string | null
  actorSubjectId?: string
  conversationSubjectId?: string
  contextSubjectId?: string
  remoteAgentSubjectId?: string
  /** Every subject id that participates in binding visibility checks. */
  allIds: string[]
}

async function principalSubjectIds(
  input: ProjectToolsInput
): Promise<ResolvedPrincipalSubjects> {
  const workspaceSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE,
    workspaceId: input.workspaceId,
  })
  const out: ResolvedPrincipalSubjects = {
    workspaceSubjectId,
    principalSubjectId: null,
    allIds: [workspaceSubjectId],
  }
  const principal = input.principal
  switch (principal.kind) {
    case "actor": {
      out.actorSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: principal.actorId,
      })
      out.allIds.push(out.actorSubjectId)
      out.principalSubjectId = out.actorSubjectId
      if (principal.conversationId) {
        out.conversationSubjectId = await upsertAccessSubject(db, {
          kind: SUBJECT_KIND.CONVERSATION,
          conversationId: principal.conversationId,
        })
        out.allIds.push(out.conversationSubjectId)
      }
      break
    }
    case "actor_in_conversation": {
      out.actorSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: principal.actorId,
      })
      out.conversationSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: principal.conversationId,
      })
      out.allIds.push(out.actorSubjectId, out.conversationSubjectId)
      // subject-scope-refactor: conversation_actor_context subject_kind dropped.
      // The "actor X in conversation Y" semantics is now expressed by
      // (subject=actor, scope=conversation) at the binding/grant layer (see
      // tg_runtime_authorization_grant_validate trigger whitelist). The
      // principalSubjectId for audit purposes is the actor subject id.
      out.principalSubjectId = out.actorSubjectId
      break
    }
    case "conversation": {
      out.conversationSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: principal.conversationId,
      })
      out.allIds.push(out.conversationSubjectId)
      out.principalSubjectId = out.conversationSubjectId
      break
    }
    case "remote_agent": {
      out.remoteAgentSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.REMOTE_AGENT,
        remoteAgentId: principal.remoteAgentId,
      })
      out.conversationSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: principal.conversationId,
      })
      out.allIds.push(out.remoteAgentSubjectId, out.conversationSubjectId)
      out.principalSubjectId = out.remoteAgentSubjectId
      break
    }
    case "workspace_member":
      // Already gated by the projectToolsForPrincipal switch above.
      break
  }
  return out
}

async function projectDeviceTools(
  input: ProjectToolsInput
): Promise<DeviceToolBundle> {
  // workspace_member never reaches here (throws above) and the chat-runtime
  // consumer is the only one currently wired for device dispatch.
  if (input.principal.kind === "workspace_member") {
    return {
      tools: [],
      handlers: new Map(),
      subjects: {
        workspaceSubjectId: "",
        principalSubjectId: null,
        allIds: [],
      },
    }
  }
  const subjects = await principalSubjectIds(input)
  const rows = await loadDeviceCapabilityToolsForSubjects({
    workspaceId: input.workspaceId,
    subjectIds: subjects.allIds,
  })

  // Conversation-type-mask filter: every device capability row gets
  // narrowed to (workspace default ∩ device override ∩ capability override).
  // A capability whose effective mask doesn't include the current
  // conversation's (kind, boundary) bit is dropped from the surface.
  const conversationKind = input.conversationKind ?? null
  const conversationBoundary = input.conversationBoundary ?? null
  const workspacePolicies =
    await getWorkspaceCapabilityConversationTypePolicyMap([input.workspaceId])
  const workspaceDefault =
    workspacePolicies.get(input.workspaceId)?.device_capability ?? null
  const filteredRows = rows.filter((row) => {
    if (!conversationKind) {
      // No conversation context (e.g. dashboard introspection) — surface
      // everything; the dispatch-side check still rejects per-call.
      return true
    }
    const effectiveMask = resolveNarrowedConversationTypeMask(
      resolveNarrowedConversationTypeMask(
        workspaceDefault,
        row.device_conversation_type_mask_override
      ),
      row.capability_conversation_type_mask_override
    )
    return maskAllowsConversationType(
      effectiveMask,
      conversationKind,
      conversationBoundary
    )
  })

  const handlers = new Map<string, DeviceCapabilityToolRow>()
  const tools: ToolDefinition[] = []
  for (const row of filteredRows) {
    const name = namespaceDeviceToolName(row)
    handlers.set(name, row)
    tools.push({
      name,
      description:
        row.visible_description ||
        `Device tool: ${row.visible_tool_name} on ${row.device_name}`,
      parameters: normalizeInputSchema(row.input_schema),
      // Origin metadata so reverse-MCP can stamp a "[device:Name]" attribution
      // on the tool description it forwards to remote agents. Without this
      // the badge falls back to "[device]" which loses the device name.
      source: {
        kind: "device_capability",
        displayName: row.visible_tool_name,
        deviceName: row.device_name,
      },
      sourceType: "mcp_device",
    })
  }
  return { tools, handlers, subjects }
}

function normalizeInputSchema(raw: unknown): ToolDefinition["parameters"] {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>
    const props =
      obj["properties"] && typeof obj["properties"] === "object"
        ? (obj["properties"] as ToolDefinition["parameters"]["properties"])
        : {}
    const required = Array.isArray(obj["required"])
      ? (obj["required"] as string[])
      : []
    return { type: "object", properties: props, required }
  }
  return { type: "object", properties: {}, required: [] }
}

function unionWithDevice(
  projectInput: ProjectToolsInput,
  legacy: ProjectedToolList,
  device: DeviceToolBundle
): ProjectedToolList {
  const dispatchDeviceTool = async (
    toolName: string,
    input: Record<string, unknown>
  ): Promise<NormalizedMcpToolResult> => {
    const row = device.handlers.get(toolName)
    if (!row) {
      return mcpErrorBlock(`device tool ${toolName} not found in projection`)
    }
    // Build the unsigned payload first so we can compute input_hash from the
    // Strip the planner-injected retry-nonce hint before everything that
    // operates on tool args, so the device never sees it and the input_hash
    // is computed over the user-facing schema.
    const sanitizedInput: Record<string, unknown> = { ...input }
    delete sanitizedInput["__synapse_retry_nonce"]
    // canonicalized arguments — the device verifier rejects envelopes whose
    // input_hash doesn't match the actual `arguments` it received.
    const inputCanonical = canonicalizeEnvelopePayload(sanitizedInput)
    const inputHash =
      "sha256:" + createHash("sha256").update(inputCanonical).digest("hex")

    // Look up runtime_authorization_grants that apply to this capability so
    // the device-side bash/cua enforcement has matching grant_specs to
    // consult. Without this, the device runtime would reject every call.
    // Pull active grants for this capability and filter strictly to ones the
    // current principal actually owns: scope IN (workspace, once) → applies
    // to everyone; otherwise grant.subject_id MUST be in the principal's
    // subject set. Without this filter, every actor in the workspace
    // inherits every other actor's actor/conversation grants on the same
    // capability — a critical security hole.
    let grantSpecs: RuntimeAuthorizationGrantSpec[] = []
    const grantIds: string[] = []
    let onceGrantIdsForConsume: string[] = []
    // subject-scope-refactor: grant_scope envelope field is now a free-form
    // derived label string (z.string().min(1).max(64)) — see
    // device-protocol/src/schemas.ts. Loose `string` typing here lets us
    // assign subjectScopeLabel output directly without enum gymnastics.
    let grantScope: string = "workspace"
    // The planner injects __synapse_retry_nonce into the tool args when
    // re-issuing a call after a user approved an authorization request.
    // The projection extracts it, uses it for the filter + envelope, and
    // strips it from the args the device sees so it doesn't pollute the
    // tool's schema.
    const envelopeRetryNonce =
      typeof input["__synapse_retry_nonce"] === "string"
        ? (input["__synapse_retry_nonce"] as string)
        : undefined
    try {
      const allGrants = await listActiveRuntimeAuthorizationGrantsForExposure(
        row.device_capability_id
      )
      const subjectSet = new Set(device.subjects.allIds)
      // Retry-nonce gating: `once` grants are NOT global — they must be
      // matched explicitly by an envelope-side retry_nonce that equals the
      // grant's source_retry_nonce. Without this, a `once` grant created
      // for one tool call would silently leak into every subsequent
      // dispatch of the same capability.
      //
      // The planner injects __synapse_retry_nonce into the tool args when
      // re-issuing a call after a user approved an authorization request.
      // The projection extracts it, uses it for the filter + envelope, and
      // strips it from the args the device sees so it doesn't pollute the
      // tool's schema.
      const subjectScoped = allGrants.filter(
        (g: RuntimeAuthorizationGrantRecord) => {
          // subject-scope-refactor: legacy scope enum replaced by subject/scope
          // SubjectRef pair. workspace subject (unscoped) = previous "workspace"
          // scope; consume_once retention = previous "once" scope. The rest
          // (actor / remote_agent / conversation / actor_in_conversation) are
          // gated by subjectSet membership and the active-conversation guard
          // already encoded in device.subjects.allIds.
          if (g.subject.kind === SUBJECT_KIND.WORKSPACE) return true
          if (g.retention === "consume_once") {
            return !!(
              envelopeRetryNonce &&
              g.sourceRetryNonce &&
              g.sourceRetryNonce === envelopeRetryNonce
            )
          }
          // actor / conversation / remote_agent: must be subject-bound. After
          // subject-scope-refactor the subject is on every row (NOT NULL); we
          // gate on whether the subject_id is in the principal's runtime set.
          // The candidate's access_subjects.id is exposed via g.subject — we
          // look it up by reconstructing.
          // Note: this deprecated list path doesn't carry the subject_id at
          // the row level (only the SubjectRef shape); fall back to comparing
          // subject identity by re-resolving.
          return subjectScoped_matchesPrincipalSubject(g, device.subjects)
        }
      )
      // Second pass: per-call action coverage. A grant that's scoped to the
      // principal but doesn't COVER the specific filesystem path / browser
      // origin / commandline command must not satisfy this dispatch. Build
      // the requestedAction up-front (same shape used by the authorization
      // request flow below) so server and UI agree on what's being asked.
      const requestedActionForCheck = buildRequestedAction({
        capability: row.builtin_kind,
        toolName,
        visibleToolName: row.visible_tool_name,
        args: sanitizedInput,
      })
      const applicable = subjectScoped.filter((g) =>
        runtimeAuthorizationGrantMatches(g, requestedActionForCheck)
      )
      for (const grant of applicable) {
        const spec: RuntimeAuthorizationGrantSpec = {
          capability: grant.capability,
          // Translate camelCase shared GrantPolicy fields into the snake_case
          // wire shape the envelope schema requires.
          filesystem: grant.filesystem
            ? {
                access: grant.filesystem.access,
                path_prefixes: grant.filesystem.pathPrefixes ?? [],
              }
            : undefined,
          cua: grant.cua ? { access: grant.cua.access } : undefined,
          browser: grant.browser
            ? {
                action: grant.browser.action,
                scope_type: grant.browser.scopeType,
                origin: grant.browser.origin,
                host: grant.browser.host,
                registrable_domain: grant.browser.registrableDomain,
              }
            : undefined,
          commandline: grant.commandline
            ? {
                executor: grant.commandline.executor,
                command_match_type: grant.commandline.commandMatchType,
                command_text: grant.commandline.commandText,
                working_directory: grant.commandline.workingDirectory,
              }
            : undefined,
        }
        grantSpecs.push(spec)
        grantIds.push(grant.id)
        if (grant.retention === "consume_once") {
          onceGrantIdsForConsume.push(grant.id)
        }
      }
      if (applicable.length > 0) {
        grantScope = applicable[0]!.scopeLabel
      }
    } catch (err) {
      return mcpErrorBlock(
        `grant lookup failed for capability ${row.device_capability_id}: ${(err as Error).message}`
      )
    }

    // Hard gate: if no grants apply, refuse to dispatch. Without this check
    // the server would ship an envelope with empty grant_specs and the
    // device-side filesystem / browser / cua-read builtins would silently
    // allow the call (since their authz check is "no policies present? skip
    // gating"). The planner / UI is expected to call
    // createRuntimeAuthorizationRequest separately and re-issue once the
    // user resolves.
    if (grantSpecs.length === 0) {
      // Auto-fire an interaction_runtime_authorization_requests row so the
      // dashboard shows the prompt and the user can approve. Supported
      // principal kinds:
      //  - actor              → grant subject = actor
      //  - actor_in_conversation → grant subject = conversation_actor_context
      //  - remote_agent       → grant subject = remote_agent; no
      //                          tool_call_task is created (the bridged
      //                          agent retries the call itself rather than
      //                          waking a chat session)
      const supportsAuthRequest =
        projectInput.principal.kind === "actor" ||
        projectInput.principal.kind === "actor_in_conversation" ||
        projectInput.principal.kind === "remote_agent"
      if (!supportsAuthRequest) {
        return mcpErrorBlock(
          `permission_denied: no active grant covers device capability ${row.device_capability_id} for this ${projectInput.principal.kind} principal`
        )
      }
      const principal = projectInput.principal as
        | { kind: "actor"; actorId: string; conversationId?: string }
        | {
            kind: "actor_in_conversation"
            actorId: string
            conversationId: string
            conversationActorContextId: string
          }
        | {
            kind: "remote_agent"
            remoteAgentId: string
            conversationId: string
          }
      const conversationId =
        ("conversationId" in principal
          ? principal.conversationId
          : undefined) ?? projectInput.conversationId
      if (!conversationId) {
        return mcpErrorBlock(
          `permission_denied: cannot create authorization request without a conversation context`
        )
      }
      try {
        const result = await createRuntimeAuthorizationRequest({
          source: {
            workspaceId: projectInput.workspaceId,
            conversationId,
            sessionId: projectInput.sessionId ?? "",
            actorId:
              principal.kind === "remote_agent" ? undefined : principal.actorId,
            remoteAgentId:
              principal.kind === "remote_agent"
                ? principal.remoteAgentId
                : undefined,
            conversationActorContextId:
              principal.kind === "actor_in_conversation"
                ? principal.conversationActorContextId
                : undefined,
            sourceToolName: toolName,
            conversationKind: projectInput.conversationKind,
            conversationBoundary: projectInput.conversationBoundary,
            workspaceMemberId: projectInput.workspaceMemberId,
          },
          runtimeTarget: {
            deviceCapabilityId: row.device_capability_id,
            deviceId: row.device_id,
            deviceExposureId: row.device_exposure_id,
            requestedToolName: toolName,
            deviceToolStableKey: row.visible_tool_name,
            runtimeSessionId: "",
            deviceDisplayName: row.device_name,
          },
          authorizationPlan: (() => {
            const requestedAction = buildRequestedAction({
              capability: row.builtin_kind,
              toolName,
              visibleToolName: row.visible_tool_name,
              args: sanitizedInput,
            })
            return {
              requestedAction,
              // Surface at least one default grantOption so the UI has
              // something the user can approve. The default mirrors the
              // requested action verbatim — UI may render more granular
              // options on top.
              grantOptions: [
                {
                  id: "default",
                  summary: requestedAction.summary,
                  detail: requestedAction.detail,
                  grantSpec: {
                    capability: requestedAction.capability,
                    filesystem: requestedAction.filesystem,
                    cua: requestedAction.cua,
                    browser: requestedAction.browser,
                    commandline: requestedAction.commandline,
                  },
                },
              ],
            }
          })(),
          requestMode: "background",
          // Surface principal-appropriate scope presets so the approver
          // can write a grant narrowed to the principal that triggered
          // the dispatch. The list always includes the universally-safe
          // once / conversation / workspace presets.
          // subject-scope-refactor: 'actor_in_conversation' preset removed at
          // cutover; an actor principal in a conversation gets the same
          // preset menu as a free-standing actor (UI derives the scoped
          // label from subject+scope via subjectScopeLabel).
          availablePresets:
            principal.kind === "remote_agent"
              ? ["once", "remote_agent", "conversation", "workspace"]
              : principal.kind === "actor_in_conversation"
                ? ["once", "actor", "conversation", "workspace"]
                : ["once", "actor", "conversation", "workspace"],
          reason: `Tool ${toolName} requires authorization for device capability ${row.device_capability_id}`,
          sourceRequestArgs: input,
        })
        return {
          content: [
            textBlock(
              `runtime_authorization_requested: created interaction ${result.interaction.id}. Approve the request to retry with retry_nonce=${result.retryNonce}.`
            ) as CanonicalContentBlock,
          ],
          isError: true,
          metadata: {
            synapse_error: {
              code: "runtime_authorization_requested",
              message: "user approval required",
              authorization_task_id: result.task?.id,
              retry_nonce: result.retryNonce,
            },
          },
        }
      } catch (err) {
        return mcpErrorBlock(
          `authorization request failed: ${(err as Error).message}`
        )
      }
    }

    let envelope
    try {
      envelope = signEnvelopeForDispatch({
        operation_id: randomUUID(),
        attempt_id: randomUUID(),
        device_runtime_session_id: randomUUID(),
        device_capability_id: row.device_capability_id,
        device_exposure_id: row.device_exposure_id,
        device_tool_id: row.device_tool_id,
        device_tool_revision_id: row.device_tool_revision_id,
        input_hash: inputHash,
        task_mode: "sync" as const,
        runtime_authorization: {
          grant_ids: grantIds,
          grant_scope: grantScope,
          grant_specs: grantSpecs,
          retry_nonce: envelopeRetryNonce,
        },
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
    } catch (err) {
      return mcpErrorBlock(
        `envelope signing failed (operator must set SYNAPSE_DEVICE_ENVELOPE_SIGNING_KEY): ${(err as Error).message}`
      )
    }
    // Open a device_operations + first device_operation_attempts row pair
    // BEFORE dispatch so the audit trail captures partial failures (e.g.
    // tunnel unreachable). Also performs the revision-drift check: if the
    // device re-synced its catalog between projection and this call, the
    // envelope's tool_revision_id is stale and we must signal replan.
    let operationId: string
    let attemptId: string
    try {
      const begin = await beginDeviceOperation({
        workspaceId: projectInput.workspaceId,
        conversationId: projectInput.conversationId ?? null,
        envelope,
        args: sanitizedInput,
        toolName: row.visible_tool_name,
        deviceId: row.device_id,
        deviceServiceId: row.device_service_id,
        tunnelInternalUrl:
          getDeviceTunnelRegistry().resolve(row.device_service_id)
            ?.internalUrl ?? null,
        principalKind: principalKindFor(projectInput.principal),
        principalSubjectId: device.subjects.principalSubjectId ?? "",
        initiatedByWorkspaceMemberId: projectInput.workspaceMemberId ?? null,
        initiatedBySessionId: projectInput.sessionId ?? null,
      })
      operationId = begin.operationId
      attemptId = begin.attemptId
    } catch (err) {
      if (err instanceof RevisionDriftError) {
        return mcpErrorBlock(
          `tool definition changed since planning: ${err.message}`
        )
      }
      return mcpErrorBlock(
        `device_operations insert failed: ${(err as Error).message}`
      )
    }

    // dispatchSyncTool resolves the tunnel endpoint by deviceServiceId, which
    // is the device_services row id (what the runtime registered its tunnel
    // under). We use row.device_service_id from the catalog projection — NOT
    // device_exposure_id, which would never match a registered endpoint.
    const result = await dispatchSyncTool({
      deviceServiceId: row.device_service_id,
      envelope,
      args: sanitizedInput,
      toolName: row.visible_tool_name,
    })
    await completeDeviceOperation({
      operationId,
      attemptId,
      ok: result.ok,
      error: result.error,
    }).catch(() => {
      /* operation-complete logging is best-effort; the dispatch result is
       * already in hand and shouldn't be hidden behind audit-write errors */
    })
    // Consume `once` grants we used on success — without this, the same
    // once grant could be reused indefinitely after the first dispatch.
    // Failure path leaves them active so the planner can retry with the
    // same retry_nonce.
    if (result.ok && onceGrantIdsForConsume.length > 0) {
      await Promise.all(
        onceGrantIdsForConsume.map((id) =>
          consumeRuntimeAuthorizationGrant(id).catch(() => undefined)
        )
      )
    }
    if (!result.ok) {
      return mcpErrorBlock(
        `device dispatch failed (${result.error?.code}): ${result.error?.message}`
      )
    }
    const tool = result.result as
      | { content?: CanonicalContentBlock[]; isError?: boolean }
      | undefined
    return {
      content: tool?.content ?? [],
      isError: tool?.isError,
    }
  }

  const executor = async (
    toolName: string,
    input: Record<string, unknown>,
    executionContext?: McpExecutionContext
  ): Promise<NormalizedMcpToolResult> => {
    if (device.handlers.has(toolName)) {
      return dispatchDeviceTool(toolName, input)
    }
    return legacy.executor(toolName, input, executionContext)
  }

  const refresh = async () => {
    const refreshed = await legacy.refresh()
    // Re-query device tools on each refresh so newly granted bindings show
    // up without restarting the session. Use the captured input so the
    // principal + subject set stays consistent across refreshes.
    const freshDevice = await projectDeviceTools(projectInput)
    // Replace the stale device-bundle handlers/subjectIds in place so the
    // dispatchDeviceTool closure (which closes over `device`) sees the
    // refreshed handlers on the next tool call.
    device.tools = freshDevice.tools
    device.handlers = freshDevice.handlers
    device.subjects = freshDevice.subjects
    return {
      tools: [...refreshed.tools, ...device.tools],
      mcpVersion: refreshed.mcpVersion,
    }
  }

  return {
    tools: [...legacy.tools, ...device.tools],
    executor,
    mcpVersion: legacy.mcpVersion,
    refresh,
    setTurnId: legacy.setTurnId,
    shutdown: legacy.shutdown,
  }
}

function mcpErrorBlock(message: string): NormalizedMcpToolResult {
  return {
    content: [textBlock(message) as CanonicalContentBlock],
    isError: true,
  }
}

function principalKindFor(principal: DevicePrincipal): OperationPrincipalKind {
  switch (principal.kind) {
    case "actor":
    case "actor_in_conversation":
      return "actor" // subject-scope-refactor: actor_in_conversation collapses to actor for audit
    case "conversation":
    case "remote_agent":
    case "workspace_member":
      return principal.kind
  }
}

/**
 * Build a minimal RuntimeAuthorizationRequestedAction from the tool args +
 * declared capability + visible tool name. Used both to evaluate whether
 * an existing grant covers the call (KK) and to populate an authorization
 * request when no grant matches (FF). The matcher contract:
 *   - commandline: commandMatchType='exact' + commandText=full command,
 *     so the grant matcher compares exact text and the device-side prefix
 *     can still be widened by the user when approving.
 *   - browser_navigate: action='write' (navigate changes URL).
 *   - browser_read_text: action='read'.
 *   - cua_click / cua_type_text: access='write'.
 *   - cua_capture_display / cua_list_displays: access='read'.
 *   - filesystem list_dir: access='read'.
 */
function buildRequestedAction(args: {
  capability: "filesystem" | "commandline" | "browser" | "cua" | null
  toolName: string
  /** The unnamespaced tool name as the device exposes it (e.g. "bash",
   *  "cua_click"). Used to distinguish read vs write at the tool level. */
  visibleToolName?: string
  args: Record<string, unknown>
}): RuntimeAuthorizationRequestedAction {
  const summary = `Tool ${args.toolName} requires authorization`
  const detail = `args: ${JSON.stringify(args.args).slice(0, 200)}`
  const tool = (args.visibleToolName ?? args.toolName).toLowerCase()
  switch (args.capability) {
    case "filesystem": {
      const path =
        typeof args.args["path"] === "string"
          ? (args.args["path"] as string)
          : "/"
      // VFS paths are virtual-absolute (rooted at "/"); normalizePathPrefix
      // on both sides will canonicalize them.
      return {
        capability: "filesystem",
        toolName: args.toolName,
        summary,
        detail,
        filesystem: { access: "read", pathPrefixes: [path] },
      }
    }
    case "commandline": {
      const command =
        typeof args.args["command"] === "string"
          ? (args.args["command"] as string)
          : ""
      const workingDirectory =
        typeof args.args["working_directory"] === "string"
          ? (args.args["working_directory"] as string)
          : undefined
      return {
        capability: "commandline",
        toolName: args.toolName,
        summary,
        detail,
        commandline: {
          executor: "bash",
          // exact match: the requested action carries the full command so
          // the matcher can verify a grant of (exact, command) covers it.
          // The UI can offer the user a "tool" or "prefix" grant on top.
          commandMatchType: "exact",
          commandText: command,
          workingDirectory,
        },
      }
    }
    case "browser": {
      const url =
        typeof args.args["url"] === "string" ? (args.args["url"] as string) : ""
      const action: "read" | "write" =
        tool === "browser_navigate" ? "write" : "read"
      return {
        capability: "browser",
        toolName: args.toolName,
        summary,
        detail,
        browser: {
          action,
          scopeType: "origin",
          origin: safeOrigin(url),
        },
      }
    }
    case "cua":
    default: {
      const writeTools = new Set(["cua_click", "cua_type_text"])
      return {
        capability: "cua",
        toolName: args.toolName,
        summary,
        detail,
        cua: { access: writeTools.has(tool) ? "write" : "read" },
      }
    }
  }
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

/** Re-export shared executor/dispatch shapes so callers depend on this module only. */
export type {
  ToolDefinition,
  NormalizedMcpToolResult,
  McpExecutionContext,
  ResolvedMcpTools,
}

/**
 * subject-scope-refactor: helper used in the deprecated capability-projection
 * filter path (kept as merge-prep stabilization). Compares a grant's subject
 * against the principal's resolved subject ids by kind+identity. The full
 * canonical-helper dispatch (selectAndClaimRuntimeAuthorizationGrant) uses
 * subject_id IN runtimeSubjectIds at the SQL level — that's the strictly
 * correct path; this helper exists only to keep the legacy filter compiling.
 */
function subjectScoped_matchesPrincipalSubject(
  grant: RuntimeAuthorizationGrantRecord,
  subjects: ResolvedPrincipalSubjects
): boolean {
  switch (grant.subject.kind) {
    case "workspace":
      return true // unscoped workspace grants apply to anyone in workspace
    case "actor":
      return Boolean(
        subjects.actorSubjectId &&
        subjects.allIds.includes(subjects.actorSubjectId)
      )
    case "remote_agent":
      return Boolean(
        subjects.remoteAgentSubjectId &&
        subjects.allIds.includes(subjects.remoteAgentSubjectId)
      )
    case "conversation":
      return Boolean(
        subjects.conversationSubjectId &&
        subjects.allIds.includes(subjects.conversationSubjectId)
      )
    default:
      return false
  }
}
