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
import { SUBJECT_KIND, textBlock, type SubjectRef } from "@synapse/shared"
import type { RuntimeAuthorizationGrantSpec as RuntimeAuthorizationGrantWireSpec } from "@synapse/device-protocol"
// subject-scope-refactor: Renamed alias to disambiguate from the API-side
// SharedRuntimeAuthorizationGrantSpec; envelope payloads use the snake_case
// wire spec.
import type { McpExecutionContext } from "../mcp-plugins/instance-manager.js"
import {
  resolveMcpToolsForActor,
  resolveMcpToolsForRemoteAgent,
  type ResolvedMcpTools,
} from "../mcp-plugins/tool-resolver.js"
import { db } from "../../infrastructure/database/kysely.js"
import { buildRuntimePrincipalContext } from "../access/subject-resolution.js"
import { ensureConversationActorContext } from "../session/service.js"
import { dispatchSyncTool } from "../devices/dispatch.js"
import { signEnvelopeForDispatch } from "../devices/envelope-signer.js"
import { canonicalizeEnvelopePayload } from "@synapse/device-protocol"
import { createHash } from "node:crypto"
import {
  selectAndClaimRuntimeAuthorizationGrant,
  toRuntimeAuthorizationGrantWireSpec,
  type RuntimeAuthorizationGrantRecord,
  type PreparedDispatch,
  type PrepareFailure,
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
 * - `actor` with optional conversationId — chat runtime acting on behalf
 *   of an actor. When conversationId is provided AND the actor is an
 *   active participant of that conversation, projection ALSO reads
 *   conversation-scoped bindings (the 1:1 device-picker output) plus
 *   `subject=actor + scope=conversation` grants (the group-chat picker
 *   output). The active-participant guard is enforced by the canonical
 *   `buildRuntimePrincipalContext`; without it, a non-member actor's
 *   `conversationId` would silently pull in unrelated grants.
 * - `conversation` — transcript-side jobs with no actor in play. Per
 *   Decision 8, this principal does NOT inherit the workspace subject:
 *   `subject=workspace` device grants stay invisible to bridged
 *   conversation participants (IM bridges, virtual chats).
 * - `remote_agent` — reverse MCP caller bridged into a conversation.
 *   Same active-participant guard as `actor`.
 * - `workspace_member` — dashboard introspection; never used for
 *   executable dispatch.
 *
 * subject-scope-refactor: the legacy `actor_in_conversation` discriminator
 * is dropped. Its semantics ("this actor, narrowed to this conversation")
 * are now expressed as `actor` principal + `RuntimePrincipalContext.
 * activeConversationSubjectId`, with the conversation subject also pushed
 * into `runtimeScopeSubjectIds` so `(subject=actor, scope=conversation)`
 * grants match SQL-side rather than requiring an extra principal-kind
 * branch in every dispatcher. The legacy `conversation_actor_context`
 * subject kind is gone with the discriminator.
 */
export type DevicePrincipal =
  | { kind: "actor"; actorId: string; conversationId?: string }
  | { kind: "conversation"; conversationId: string }
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
 * Resolved subject ids for a principal. Mirrors
 * `RuntimePrincipalContext` from access/subject-resolution.ts — this is a
 * thin adapter that derives the canonical context once and surfaces the
 * fields capability-projection actually uses (allIds, scopeSubjectIds,
 * principalSubjectId, activeConversationSubjectId).
 *
 * Critical: the *canonical* builder enforces three rules this projection
 * MUST inherit (delegating here is the only way to keep them in sync):
 *   1. Decision 8 — pure-conversation principals do NOT inherit the
 *      workspace subject (otherwise `subject=workspace` device grants
 *      leak to bridged conversation participants).
 *   2. Active-participant guard — `actor`/`remote_agent` get the
 *      conversation subject in BOTH `allIds` and `scopeSubjectIds` ONLY
 *      when they are an active participant. Without this, a non-member
 *      actor can claim `subject=conversation` device bindings.
 *   3. Cross-workspace guard — `actor`/`remote_agent` must belong to the
 *      named workspace, else workspace-level grants leak across
 *      workspaces.
 *
 * Earlier merge-prep versions had a local helper that violated #1 and #2
 * (unconditionally pushed workspace + conversation subjects into allIds
 * irrespective of active participation), and skipped #3 entirely.
 */
export interface ResolvedPrincipalSubjects {
  principalSubjectId: string | null
  /** Every subject id that participates in binding visibility checks. */
  allIds: string[]
  /**
   * subject-scope-refactor: scope_subject_id values that may pin a binding /
   * grant. For `actor` + active conversation, this contains the conversation
   * subject. Empty when no active conversation scope applies. Wire this
   * through `loadDeviceCapabilityToolsForSubjects.runtimeScopeSubjectIds`
   * and `selectAndClaimRuntimeAuthorizationGrant.runtimeScopeSubjectIds`
   * so scoped grants are accepted only inside the matching scope.
   */
  scopeSubjectIds: string[]
  /**
   * Convenience: the single active conversation scope subject id (if any).
   * Mirrors RuntimePrincipalContext.activeConversationSubjectId.
   */
  activeConversationSubjectId?: string
}

function devicePrincipalToSubjectRef(
  principal: DevicePrincipal
): SubjectRef | null {
  switch (principal.kind) {
    case "actor":
      return { kind: SUBJECT_KIND.ACTOR, actorId: principal.actorId }
    case "conversation":
      return {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: principal.conversationId,
      }
    case "remote_agent":
      return {
        kind: SUBJECT_KIND.REMOTE_AGENT,
        remoteAgentId: principal.remoteAgentId,
      }
    case "workspace_member":
      // Filtered out by projectDeviceTools (dashboard introspection path
      // doesn't dispatch).
      return null
  }
}

/**
 * Resolve `ProjectToolsInput` into the subject set capability-projection
 * dispatches against. Exported for direct regression testing — the bug
 * patterns this helper has hit during the subject-scope-refactor merge
 * (Decision 8 violations, active-participant guard skips, cross-workspace
 * leakage) all live INSIDE this function, so tests must call it directly
 * rather than asserting against the canonical builder it delegates to.
 *
 * Tests may pass an injected Kysely instance (e.g. the ephemeral DB
 * returned by `withTestDb`) so the underlying
 * `buildRuntimePrincipalContext` runs against the test connection rather
 * than the production pool.
 */
export async function principalSubjectIds(
  input: ProjectToolsInput,
  options?: { db?: typeof db }
): Promise<ResolvedPrincipalSubjects> {
  const dbHandle = options?.db ?? db
  const subjectRef = devicePrincipalToSubjectRef(input.principal)
  if (!subjectRef) {
    return {
      principalSubjectId: null,
      allIds: [],
      scopeSubjectIds: [],
    }
  }
  // Resolve which conversation to consider for the active-participant
  // guard. `actor` principals get `principal.conversationId ??
  // input.conversationId` so callers that pass the conversation at the
  // input level (mirroring projectLegacyTools / requestAuthorizationOrDeny)
  // still activate the scope guard. `remote_agent` / `conversation` carry
  // a mandatory conversationId on the principal itself.
  const conversationId =
    input.principal.kind === "conversation"
      ? input.principal.conversationId
      : input.principal.kind === "actor"
        ? (input.principal.conversationId ?? input.conversationId)
        : input.principal.kind === "remote_agent"
          ? input.principal.conversationId
          : undefined
  const ctx = await buildRuntimePrincipalContext(dbHandle, {
    principal: subjectRef,
    workspaceId: input.workspaceId,
    conversationId: conversationId ?? null,
  })
  return {
    principalSubjectId: ctx.principalSubjectId,
    allIds: ctx.runtimeSubjectIds,
    scopeSubjectIds: ctx.runtimeScopeSubjectIds,
    activeConversationSubjectId: ctx.activeConversationSubjectId,
  }
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
        principalSubjectId: null,
        allIds: [],
        scopeSubjectIds: [],
      },
    }
  }
  const subjects = await principalSubjectIds(input)
  const rows = await loadDeviceCapabilityToolsForSubjects({
    workspaceId: input.workspaceId,
    subjectIds: subjects.allIds,
    runtimeScopeSubjectIds: subjects.scopeSubjectIds,
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
    const sanitizedInput: Record<string, unknown> = stripPlannerNonce(input)
    // canonicalized arguments — the device verifier rejects envelopes whose
    // input_hash doesn't match the actual `arguments` it received.
    const inputCanonical = canonicalizeEnvelopePayload(sanitizedInput)
    const inputHash =
      "sha256:" + createHash("sha256").update(inputCanonical).digest("hex")

    // subject-scope-refactor: dispatch goes through the canonical helper
    // selectAndClaimRuntimeAuthorizationGrant — it does (a) SQL-side filtering
    // by subject + scope (no more "list everything and filter in TS",
    // no more cross-actor leakage), (b) bounded retry for `consume_once` race,
    // (c) atomic claim in the same Kysely transaction that opens the
    // device_operations row (no more "dispatch first, consume later" window),
    // (d) prepareGrant signs the envelope BEFORE the claim so signing failures
    // don't burn a grant. The legacy list-then-filter path
    // (listActiveRuntimeAuthorizationGrantsForExposure + manual TS filter +
    // post-dispatch consume) is gone.
    const envelopeRetryNonce =
      typeof input["__synapse_retry_nonce"] === "string"
        ? (input["__synapse_retry_nonce"] as string)
        : undefined
    const requestedAction = buildRequestedAction({
      capability: row.builtin_kind,
      toolName,
      visibleToolName: row.visible_tool_name,
      args: sanitizedInput,
    })

    let claim
    try {
      claim = await selectAndClaimRuntimeAuthorizationGrant({
        workspaceId: projectInput.workspaceId,
        deviceId: row.device_id,
        deviceCapabilityId: row.device_capability_id,
        deviceExposureId: row.device_exposure_id,
        runtimeSubjectIds: device.subjects.allIds,
        runtimeScopeSubjectIds: device.subjects.scopeSubjectIds,
        retryNonce: envelopeRetryNonce,
        requestedAction,
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
              device_capability_id: row.device_capability_id,
              device_exposure_id: row.device_exposure_id,
              device_tool_id: row.device_tool_id,
              device_tool_revision_id: row.device_tool_revision_id,
              input_hash: inputHash,
              task_mode: "sync" as const,
              runtime_authorization: {
                grant_ids: [grant.id],
                grant_scope: grant.scopeLabel,
                grant_specs: [toRuntimeAuthorizationGrantWireSpec(grant)],
                retry_nonce: envelopeRetryNonce,
              },
              issued_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            })
            return {
              ok: true,
              prepared: {
                envelope,
                toolId: row.device_tool_id,
                toolRevisionId: row.device_tool_revision_id,
                beginInput: {
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
                  initiatedByWorkspaceMemberId:
                    projectInput.workspaceMemberId ?? null,
                  initiatedBySessionId: projectInput.sessionId ?? null,
                },
              },
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            if (/SYNAPSE_DEVICE_ENVELOPE_SIGNING_KEY/i.test(message)) {
              return {
                ok: false,
                failure: { kind: "operator_config_missing", cause: err },
              }
            }
            return {
              ok: false,
              failure: { kind: "signing_failed", cause: err },
            }
          }
        },
      })
    } catch (err) {
      return mcpErrorBlock(
        `grant claim failed for capability ${row.device_capability_id}: ${(err as Error).message}`
      )
    }

    if (claim.kind === "no_match") {
      return await requestAuthorizationOrDeny({
        projectInput,
        row,
        toolName,
        input,
        sanitizedInput,
        requestedAction,
        principalSubjectId: device.subjects.principalSubjectId ?? "",
        principalScopeSubjectId: device.subjects.activeConversationSubjectId,
      })
    }
    if (claim.kind === "race_lost") {
      return mcpErrorBlock(
        `runtime_constraint: grant race lost (${claim.reason}); please retry`
      )
    }
    if (claim.kind === "lock_timeout") {
      return mcpErrorBlock(
        `runtime_constraint: catalog lock timeout; please retry`
      )
    }
    if (claim.kind === "denied") {
      return mcpErrorBlock(
        `runtime_constraint: ${claim.reason}${claim.grantId ? ` (grant ${claim.grantId})` : ""}`
      )
    }

    const { prepared, operation } = claim
    const operationId = operation.operationId
    const attemptId = operation.attemptId
    const envelope = prepared.envelope

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
    // subject-scope-refactor: `consume_once` grants are now claimed atomically
    // inside selectAndClaimRuntimeAuthorizationGrant's transaction (before
    // the network dispatch). The legacy "best-effort consume on success" path
    // is gone — by the time dispatchSyncTool returns, the grant is already
    // marked consumed and no second window for concurrent reuse exists.
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

/**
 * subject-scope-refactor: extracted from the dispatch path so the canonical
 * helper (selectAndClaimRuntimeAuthorizationGrant) can return `no_match` and
 * let the caller decide whether to escalate to a user-facing approval
 * request. Mirrors the pre-cutover inline behavior — only the call site
 * moved.
 */
/**
 * Pure function — derives the full `createRuntimeAuthorizationRequest`
 * params object from the dispatch-time inputs.
 *
 * Exported for direct regression testing. Two contracts this helper
 * locks (both load-bearing for the cutover):
 *
 *   - `source.principalScopeSubjectId` MUST equal the caller-supplied
 *     `principalScopeSubjectId` (the active conversation scope subject
 *     when the principal is an active participant). If this drops to
 *     undefined / null, the locked column lands NULL while the approval
 *     flow rebuilds the same context and sees a non-NULL scope — the
 *     ScopeRebuildMismatchError gate then blocks every legitimate
 *     approval.
 *
 *   - `sourceRequestArgs` MUST equal the caller-supplied
 *     `sanitizedInput`, NOT the raw `input`. The dispatcher strips
 *     `__synapse_retry_nonce` from the args via `stripPlannerNonce`
 *     before computing input_hash; persisting the raw input would
 *     leak the stale planner-side nonce into the device-visible args
 *     and break the hash check on auto-retry.
 *
 * The unit test exercises this helper with `input ≠ sanitizedInput` and
 * a non-null scope, then asserts both fields round-trip correctly.
 */
export function buildRuntimeAuthorizationRequestParams(args: {
  projectInput: ProjectToolsInput
  row: DeviceCapabilityToolRow
  toolName: string
  /** The post-`stripPlannerNonce` payload — this is what the device sees and what input_hash is computed over. */
  sanitizedInput: Record<string, unknown>
  requestedAction: ReturnType<typeof buildRequestedAction>
  principalSubjectId: string
  /** Required-or-null: the active conversation scope subject id from RuntimePrincipalContext.activeConversationSubjectId. */
  principalScopeSubjectId?: string
  conversationId: string
}): Parameters<typeof createRuntimeAuthorizationRequest>[0] {
  const { projectInput, row, toolName, requestedAction } = args
  const principal = projectInput.principal as
    | { kind: "actor"; actorId: string; conversationId?: string }
    | {
        kind: "remote_agent"
        remoteAgentId: string
        conversationId: string
      }
  return {
    source: {
      workspaceId: projectInput.workspaceId,
      conversationId: args.conversationId,
      sessionId: projectInput.sessionId ?? "",
      principalSubjectId: args.principalSubjectId,
      principalScopeSubjectId: args.principalScopeSubjectId ?? null,
      actorId:
        principal.kind === "remote_agent" ? undefined : principal.actorId,
      remoteAgentId:
        principal.kind === "remote_agent" ? principal.remoteAgentId : undefined,
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
    authorizationPlan: {
      requestedAction,
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
    },
    requestMode: "background",
    availablePresets:
      principal.kind === "remote_agent"
        ? ["once", "remote_agent", "conversation", "workspace"]
        : ["once", "actor", "conversation", "workspace"],
    reason: `Tool ${toolName} requires authorization for device capability ${row.device_capability_id}`,
    sourceRequestArgs: args.sanitizedInput,
  }
}

/**
 * Pure helper — strips the planner-side retry nonce key from a tool's
 * input args. Used at exactly two places in the dispatch path: the
 * envelope's input_hash computation, and the persisted sourceRequestArgs
 * payload. Exported so tests can pin the contract independently.
 *
 * The bug pattern this guards against: the dispatcher accidentally
 * forwards `input` (raw, with nonce) instead of `sanitizedInput`
 * (stripped). The nonce then leaks into the device-visible args and
 * input_hash mismatches on auto-retry.
 */
export function stripPlannerNonce(
  input: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...input }
  delete out["__synapse_retry_nonce"]
  return out
}

async function requestAuthorizationOrDeny(args: {
  projectInput: ProjectToolsInput
  row: DeviceCapabilityToolRow
  toolName: string
  input: Record<string, unknown>
  sanitizedInput: Record<string, unknown>
  requestedAction: ReturnType<typeof buildRequestedAction>
  principalSubjectId: string
  /**
   * subject-scope-refactor: when the principal is an active participant of
   * the conversation, propagate the conversation subject_id as the locked
   * scope. The approval flow rebuilds the principal's runtime context in
   * the same pg transaction and compares the rebuilt active scope against
   * this locked value — if we omit it here, the approval gate sees
   * `locked = NULL` vs `rebuilt = <conversation subject>` and throws
   * ScopeRebuildMismatchError, blocking every legitimate actor/remote_agent
   * approval in the common case.
   */
  principalScopeSubjectId?: string
}): Promise<NormalizedMcpToolResult> {
  const { projectInput, row, toolName } = args
  const supportsAuthRequest =
    projectInput.principal.kind === "actor" ||
    projectInput.principal.kind === "remote_agent"
  if (!supportsAuthRequest) {
    return mcpErrorBlock(
      `permission_denied: no active grant covers device capability ${row.device_capability_id} for this ${projectInput.principal.kind} principal`
    )
  }
  const principal = projectInput.principal as
    | { kind: "actor"; actorId: string; conversationId?: string }
    | {
        kind: "remote_agent"
        remoteAgentId: string
        conversationId: string
      }
  const conversationId =
    ("conversationId" in principal ? principal.conversationId : undefined) ??
    projectInput.conversationId
  if (!conversationId) {
    return mcpErrorBlock(
      `permission_denied: cannot create authorization request without a conversation context`
    )
  }
  try {
    const result = await createRuntimeAuthorizationRequest(
      buildRuntimeAuthorizationRequestParams({
        projectInput,
        row,
        toolName,
        sanitizedInput: args.sanitizedInput,
        requestedAction: args.requestedAction,
        principalSubjectId: args.principalSubjectId,
        principalScopeSubjectId: args.principalScopeSubjectId,
        conversationId,
      })
    )
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

function principalKindFor(principal: DevicePrincipal): OperationPrincipalKind {
  switch (principal.kind) {
    case "actor":
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
 *
 * @deprecated REMOVED — dispatch now routes through
 * selectAndClaimRuntimeAuthorizationGrant. The previous implementation only
 * checked "principal has SOME actor subject" without comparing the specific
 * actor_id, which let actor A reuse actor B's grants. Do NOT reintroduce.
 */
