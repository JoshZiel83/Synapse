// @synapse/api/src/modules/capability-projection
// Unified tool projection per docs/device-runtime-v3.md §11.
//
// Single canonical entry point used by chat runtime and reverse MCP. Delegates
// to mcp-plugins/tool-resolver.ts for plugin projections, then unions
// runtime_capability tools alongside so the planner sees device-side bash /
// list_dir / etc. alongside MCP plugins. Device dispatch goes through
// RuntimeEndpointRegistry + the synchronous tools/call client in
// devices/dispatch.ts; every dispatch opens a runtime_operations + first
// runtime_operation_attempts row pair (see devices/operations.ts).

import { randomUUID } from "node:crypto"
import {
  dateToIsoInstant as dateToWireIsoInstant,
  nowIsoInstant as nowWireIsoInstant,
} from "@synapse/device-protocol/instant"
import type {
  ToolDefinition,
  NormalizedMcpToolResult,
  RuntimeActorContext,
  CanonicalContentBlock,
  ToolResultOrigin,
} from "@synapse/shared/types"
import {
  SUBJECT_KIND,
  textBlock,
  runtimeToolId as makeDeviceToolId,
  type SubjectRef,
  type ProjectedToolDefinition,
  type ToolRef,
} from "@synapse/shared"
import type { RuntimeAuthorizationGrantWireSpec } from "@synapse/device-protocol"
// subject-scope-refactor: Renamed alias to disambiguate from the API-side
// SharedRuntimeAuthorizationGrantSpec; envelope payloads use the snake_case
// wire spec.
import type { McpExecutionContext } from "../mcp-plugins/instance-manager.js"
import {
  resolveMcpToolsForActor,
  resolveMcpToolsForRemoteAgent,
  type ResolvedMcpTools,
} from "../mcp-plugins/tool-resolver.js"
import { dispatchSyncTool } from "../devices/dispatch.js"
import { dispatchBareRuntimeTool } from "../sandbox/bare-dispatch.js"
import { signEnvelopeForDispatch } from "../devices/envelope-signer.js"
import {
  canonicalizeEnvelopePayload,
  CUA_WRITE_TOOLS,
} from "@synapse/device-protocol"
import type { SynapseError } from "@synapse/device-protocol"
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
  isBareCommandName,
  isBundleAvailableForPlatform,
  isBundleEligibleProgram,
  normalizeDevicePlatform,
} from "@synapse/shared"
import { serializeCommandlinePolicyToWire } from "@synapse/shared/access/policies"
import {
  beginRuntimeOperation,
  completeRuntimeOperation,
  RevisionDriftError,
  type OperationPrincipalKind,
} from "../devices/operations.js"
import { getRuntimeEndpointRegistry } from "../devices/tunnel-registry.js"
import { deriveCuaFocusScopeId, type PrincipalForScope } from "./cua-scope.js"
import {
  loadRuntimeCapabilityToolsForSubjects,
  type RuntimeCapabilityToolRow,
} from "./device-capabilities.js"
import {
  loadRuntimePrincipalContextForCapabilityProjection,
  type CapabilityProjectionRuntimeContextDb,
} from "./repo.js"
import { getWorkspaceCapabilityConversationTypePolicyMap } from "../capabilities/conversation-type-policies.js"
import {
  maskAllowsConversationTypeKey,
  resolveConversationTypeKey,
  resolveNarrowedConversationTypeMask,
} from "@synapse/shared"
import { resolveUrlScope } from "@synapse/shared/access/policies"
import {
  BROWSER_TOOL_MAP,
  resolveEffectiveTarget,
} from "@synapse/device-protocol/browser-tools"

const CAPABILITY_PROJECTION_ORIGIN: ToolResultOrigin = {
  kind: "system",
  registryKey: "capability_projection",
}

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
 *   conversation participants (IM bridges, IM-bridged chats).
 * - `remote_agent` — reverse MCP caller bridged into a conversation.
 *   Same active-participant guard as `actor`.
 * - `workspace_member` — dashboard introspection; never used for
 *   executable dispatch.
 *
 * subject-scope-refactor: the scoped actor discriminator
 * is dropped. Its semantics ("this actor, narrowed to this conversation")
 * are now expressed as `actor` principal + `RuntimePrincipalContext.
 * activeConversationSubjectId`, with the conversation subject also pushed
 * into `runtimeScopeSubjectIds` so `(subject=actor, scope=conversation)`
 * grants match SQL-side rather than requiring an extra principal-kind
 * branch in every dispatcher.
 */
export type RuntimePrincipal =
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
 *   workspace_resource_grants; manageable resources are NOT auto-included so the
 *   active-device picker actually narrows chat surface.
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
  principal: RuntimePrincipal
  conversationId?: string
  conversationKind?: "direct" | "group"
  isImConversation?: boolean
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
 * resolver in v3.0 skeleton; PR #7 extends it to union runtime_capability
 * exposures.
 */
export async function projectToolsForPrincipal(
  input: ProjectToolsInput
): Promise<ProjectedToolList> {
  const legacy = await projectLegacyTools(input)
  const device = await projectRuntimeTools(input)
  if (device.tools.length === 0) return legacy
  return unionWithRuntime(input, legacy, device)
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

interface RuntimeToolBundle {
  tools: ProjectedToolDefinition[]
  /** Keyed by deterministic runtime toolId (`runtime:<runtime_tool_id>`). */
  handlers: Map<string, RuntimeCapabilityToolRow>
  subjects: ResolvedPrincipalSubjects
}

/** Build a device ToolRef from a projected capability row. */
function buildRuntimeToolRef(row: RuntimeCapabilityToolRow): ToolRef {
  return {
    toolId: makeDeviceToolId(row.runtimeToolId),
    source: {
      kind: "runtime",
      runtimeToolId: row.runtimeToolId,
      exposureStableKey: row.exposureStableKey,
      runtimeName: row.runtimeName,
      visibleToolName: row.visibleToolName,
    },
    binding: {
      transport: "runtime_tunnel",
      runtimeId: row.runtimeId,
      runtimeServiceId: row.runtimeServiceId,
      runtimeCapabilityId: row.runtimeCapabilityId,
      runtimeExposureId: row.runtimeExposureId,
      runtimeToolRevisionId: row.runtimeToolRevisionId,
    },
    identity: {
      stableKey: `${row.exposureStableKey}/${row.visibleToolName}`,
      revisionId: row.runtimeToolRevisionId,
    },
  }
}

function runtimeToolOrigin(row: RuntimeCapabilityToolRow): ToolResultOrigin {
  return {
    kind: "runtime",
    runtimeToolId: row.runtimeToolId,
    runtimeName: row.runtimeName,
    exposureStableKey: row.exposureStableKey,
    visibleToolName: row.visibleToolName,
  }
}

function withRuntimeToolOrigin(
  result: Omit<NormalizedMcpToolResult, "origin">,
  origin: ToolResultOrigin
): NormalizedMcpToolResult {
  return { ...result, origin }
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
   * through `loadRuntimeCapabilityToolsForSubjects.runtimeScopeSubjectIds`
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

function runtimePrincipalToSubjectRef(
  principal: RuntimePrincipal
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
      // Filtered out by projectRuntimeTools (dashboard introspection path
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
  options?: { db?: CapabilityProjectionRuntimeContextDb }
): Promise<ResolvedPrincipalSubjects> {
  const subjectRef = runtimePrincipalToSubjectRef(input.principal)
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
  let conversationId: string | undefined
  switch (input.principal.kind) {
    case "conversation":
      conversationId = input.principal.conversationId
      break
    case "actor":
      conversationId = input.principal.conversationId ?? input.conversationId
      break
    case "remote_agent":
      conversationId = input.principal.conversationId
      break
    default:
      conversationId = undefined
  }
  const ctx = await loadRuntimePrincipalContextForCapabilityProjection({
    db: options?.db,
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

async function projectRuntimeTools(
  input: ProjectToolsInput
): Promise<RuntimeToolBundle> {
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
  const rows = await loadRuntimeCapabilityToolsForSubjects({
    workspaceId: input.workspaceId,
    subjectIds: subjects.allIds,
    runtimeScopeSubjectIds: subjects.scopeSubjectIds,
  })

  // Conversation-type-mask filter: every device capability row gets
  // narrowed to (workspace default ∩ device override ∩ capability override).
  // A capability whose effective mask doesn't include the current
  // conversation's type-key bit is dropped from the surface. The type-key is
  // loop-invariant (a property of the conversation, not the capability row), so
  // resolve it once here and use the pure key check inside the filter.
  const conversationKind = input.conversationKind ?? null
  const conversationTypeKey = conversationKind
    ? resolveConversationTypeKey(
        conversationKind,
        input.isImConversation ?? false
      )
    : null
  const workspacePolicies =
    await getWorkspaceCapabilityConversationTypePolicyMap([input.workspaceId])
  const workspaceDefault =
    workspacePolicies.get(input.workspaceId)?.runtime_capability ?? null
  const filteredRows = rows.filter((row) => {
    if (!conversationTypeKey) {
      // No conversation context (e.g. dashboard introspection) — surface
      // everything; the dispatch-side check still rejects per-call.
      return true
    }
    const effectiveMask = resolveNarrowedConversationTypeMask(
      resolveNarrowedConversationTypeMask(
        workspaceDefault,
        row.deviceConversationTypeMaskOverride
      ),
      row.capabilityConversationTypeMaskOverride
    )
    return maskAllowsConversationTypeKey(effectiveMask, conversationTypeKey)
  })

  const handlers = new Map<string, RuntimeCapabilityToolRow>()
  const tools: ProjectedToolDefinition[] = []
  for (const row of filteredRows) {
    const ref = buildRuntimeToolRef(row)
    // Keyed by the deterministic device toolId — the wire name is assigned
    // later by the surface's NameRegistry (NamePolicy), not here.
    handlers.set(ref.toolId, row)
    tools.push({
      // `name` carries the visible (leaf) tool name; the surface rewrites it
      // to the collision-safe wire name. Routing keys on ref.toolId.
      name: row.visibleToolName,
      description:
        row.visibleDescription ||
        `Device tool: ${row.visibleToolName} on ${row.runtimeName}`,
      parameters: normalizeInputSchema(row.inputSchema),
      ref,
    })
  }
  return { tools, handlers, subjects }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function normalizeInputSchema(raw: unknown): ToolDefinition["parameters"] {
  if (isObjectRecord(raw)) {
    const props = isObjectRecord(raw["properties"])
      ? (raw["properties"] as ToolDefinition["parameters"]["properties"])
      : {}
    const required = Array.isArray(raw["required"])
      ? (raw["required"] as string[])
      : []
    return { type: "object", properties: props, required }
  }
  return { type: "object", properties: {}, required: [] }
}

function unionWithRuntime(
  projectInput: ProjectToolsInput,
  legacy: ProjectedToolList,
  device: RuntimeToolBundle
): ProjectedToolList {
  const dispatchDeviceTool = async (
    toolId: string,
    input: Record<string, unknown>
  ): Promise<NormalizedMcpToolResult> => {
    const row = device.handlers.get(toolId)
    if (!row) {
      return mcpErrorBlock(`device tool ${toolId} not found in projection`)
    }
    const origin = runtimeToolOrigin(row)
    // Normalize device platform ONCE per dispatch so both the
    // grant-coverage try block AND the authorization-request try block
    // read the same value. Each try has its own lexical scope, so
    // declaring this inside one of them would make it invisible to the
    // other. Both fields hoisted together since they're always used as
    // a pair.
    const devicePlatform = normalizeDevicePlatform(row.devicePlatform)
    const deviceArch = row.deviceArch
    // Build the unsigned payload first so we can compute input_hash from the
    // Strip the planner-injected retry-nonce hint before everything that
    // operates on tool args, so the device never sees it and the input_hash
    // is computed over the user-facing schema.
    const sanitizedInput: Record<string, unknown> = stripPlannerNonce(input)

    // v3.1 browser preflight (plan §#3, #14, #18) — runs BEFORE grant lookup
    // so disabled exposures / unknown tools / scheme violations / args type
    // mismatches never spawn an empty authorization request. The structured
    // (code, details) is surfaced via synapseErrorBlock so the downstream UI /
    // model can distinguish capability-disabled from invalid-request from
    // scheme-violation without parsing bracketed text.
    if (row.builtinKind === "browser") {
      const denial = browserPreflightDeny(
        row,
        row.visibleToolName,
        sanitizedInput
      )
      if (denial) {
        return withRuntimeToolOrigin(
          synapseErrorBlock({
            code: denial.code,
            message: denial.message,
            details: denial.details,
          }),
          origin
        )
      }
    }
    // canonicalized arguments — the device verifier rejects envelopes whose
    // input_hash doesn't match the actual `arguments` it received.
    const inputCanonical = canonicalizeEnvelopePayload(sanitizedInput)
    const inputHash = `sha256:${createHash("sha256").update(inputCanonical).digest("hex")}`

    // subject-scope-refactor: dispatch goes through the canonical helper
    // selectAndClaimRuntimeAuthorizationGrant — it does (a) SQL-side filtering
    // by subject + scope (no more "list everything and filter in TS",
    // no more cross-actor leakage), (b) bounded retry for `consume_once` race,
    // (c) atomic claim in the same Kysely transaction that opens the
    // runtime_operations row (no more "dispatch first, consume later" window),
    // (d) prepareGrant signs the envelope BEFORE the claim so signing failures
    // don't burn a grant. The legacy list-then-filter path
    // (listActiveRuntimeAuthorizationGrantsForExposure + manual TS filter +
    // post-dispatch consume) is gone.
    const envelopeRetryNonce =
      typeof input["__synapse_retry_nonce"] === "string"
        ? (input["__synapse_retry_nonce"] as string)
        : undefined
    let requestedAction
    try {
      // P4a S8: pass builtin_kind STRAIGHT THROUGH to the classifier registry.
      // pty is now in RUNTIME_AUTHORIZATION_CAPABILITIES and has its own
      // projector (capability:"pty", gated by ptyPolicyAllows on cwd/isolation),
      // so the old `pty→null` special-case (which mis-routed pty into the cua
      // generic shape) is DROPPED. A NULL builtin_kind (device-proxied
      // non-builtin exposure) is handled by an explicit `case null` projector.
      requestedAction = buildRequestedAction({
        capability: row.builtinKind,
        toolName: row.visibleToolName,
        visibleToolName: row.visibleToolName,
        args: sanitizedInput,
        devicePlatform,
        deviceArch,
      })
    } catch (err) {
      if (err instanceof InvalidExecFileArgsError) {
        return withRuntimeToolOrigin(
          synapseErrorBlock({
            code: err.synapseCode,
            message: err.message,
            details: err.details,
          }),
          origin
        )
      }
      // Fail-closed: a genuinely-unknown non-null builtin_kind → permission_denied
      // (never mis-routed to a wrong capability's grant matcher).
      if (err instanceof UnregisteredBuiltinKindError) {
        return withRuntimeToolOrigin(
          synapseErrorBlock({
            code: err.synapseCode,
            message: err.message,
            details: err.details,
          }),
          origin
        )
      }
      throw err
    }
    // Short-circuit Windows + commandline + working_directory at projection
    // time. The matcher would reject any such grant anyway (commandline v1
    // has no Windows path normalization), but returning a structured
    // permission_denied here prevents the dispatch flow from ALSO generating
    // an authorization request that's guaranteed to be denied — saves the
    // user a wasted approval click.
    if (
      devicePlatform === "win32" &&
      requestedAction.commandline?.workingDirectory
    ) {
      return withRuntimeToolOrigin(
        synapseErrorBlock({
          code: "permission_denied",
          message:
            "Windows commandline policy v1 does not support working_directory",
          details: { reason: "windows_workdir_unsupported" },
        }),
        origin
      )
    }

    let claim
    try {
      claim = await selectAndClaimRuntimeAuthorizationGrant({
        workspaceId: projectInput.workspaceId,
        runtimeId: row.runtimeId,
        runtimeCapabilityId: row.runtimeCapabilityId,
        runtimeExposureId: row.runtimeExposureId,
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
            // For cua builtins we sign a stable focus-scope id into the
            // envelope so the device sidecar can key per-Agent-session focus
            // state. Other tool kinds don't need it — leaving the field
            // undefined keeps non-cua envelopes byte-identical to v2.
            const cuaFocusScopeId =
              row.builtinKind === "cua"
                ? deriveCuaFocusScopeId({
                    sessionId: projectInput.sessionId,
                    workspaceId: projectInput.workspaceId,
                    principal: projectInput.principal as PrincipalForScope,
                  })
                : undefined
            const envelope = signEnvelopeForDispatch({
              operation_id: randomUUID(),
              attempt_id: randomUUID(),
              runtime_session_id: randomUUID(),
              runtime_capability_id: row.runtimeCapabilityId,
              runtime_exposure_id: row.runtimeExposureId,
              runtime_tool_id: row.runtimeToolId,
              runtime_tool_revision_id: row.runtimeToolRevisionId,
              input_hash: inputHash,
              task_mode: "sync" as const,
              runtime_authorization: {
                grant_ids: [grant.id],
                grant_scope: grant.scopeLabel,
                grant_specs: [toRuntimeAuthorizationGrantWireSpec(grant)],
                retry_nonce: envelopeRetryNonce,
              },
              ...(cuaFocusScopeId
                ? { cua_focus_scope_id: cuaFocusScopeId }
                : {}),
              issued_at: nowWireIsoInstant(),
              expires_at: serializeGrantEnvelopeExpiresAt(),
            })
            return {
              ok: true,
              prepared: {
                envelope,
                toolId: row.runtimeToolId,
                toolRevisionId: row.runtimeToolRevisionId,
                beginInput: {
                  workspaceId: projectInput.workspaceId,
                  conversationId: projectInput.conversationId ?? null,
                  envelope,
                  args: sanitizedInput,
                  toolName: row.visibleToolName,
                  runtimeId: row.runtimeId,
                  runtimeServiceId: row.runtimeServiceId,
                  // Bare (Mode-B) forks write transport='data_plane' with a NULL
                  // tunnel_internal_url — there is no tunnel endpoint. The
                  // resident path is unchanged (transport defaults to mcp_http).
                  transport:
                    row.serviceKind === "bare_dataplane"
                      ? "data_plane"
                      : undefined,
                  tunnelInternalUrl:
                    row.serviceKind === "bare_dataplane"
                      ? null
                      : (getRuntimeEndpointRegistry().resolve(
                          row.runtimeServiceId
                        )?.internalUrl ?? null),
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
      return withRuntimeToolOrigin(
        mcpErrorBlock(
          `grant claim failed for capability ${row.runtimeCapabilityId}: ${(err as Error).message}`
        ),
        origin
      )
    }

    if (claim.kind === "no_match") {
      return withRuntimeToolOrigin(
        await requestAuthorizationOrDeny({
          projectInput,
          row,
          toolName: row.visibleToolName,
          input,
          sanitizedInput,
          requestedAction,
          principalSubjectId: device.subjects.principalSubjectId ?? "",
          principalScopeSubjectId: device.subjects.activeConversationSubjectId,
        }),
        origin
      )
    }
    if (claim.kind === "race_lost") {
      return withRuntimeToolOrigin(
        mcpErrorBlock(
          `runtime_constraint: grant race lost (${claim.reason}); please retry`
        ),
        origin
      )
    }
    if (claim.kind === "lock_timeout") {
      return withRuntimeToolOrigin(
        mcpErrorBlock(`runtime_constraint: catalog lock timeout; please retry`),
        origin
      )
    }
    if (claim.kind === "denied") {
      return withRuntimeToolOrigin(
        mcpErrorBlock(
          `runtime_constraint: ${claim.reason}${claim.grantId ? ` (grant ${claim.grantId})` : ""}`
        ),
        origin
      )
    }

    const { prepared, operation, grant } = claim
    const operationId = operation.operationId
    const attemptId = operation.attemptId
    const envelope = prepared.envelope

    // The Mode-B fork (F-B, closed over absence): only a bare adapter's create()
    // mints service_kind='bare_dataplane' and links exposures to it, so a
    // device/resident exposure ALWAYS projects serviceKind='device_runtime' and
    // takes the UNCHANGED dispatchSyncTool below. dispatchBareRuntimeTool returns
    // the SAME McpDispatchResult shape, so completeRuntimeOperation is unchanged.
    //
    // dispatchSyncTool resolves the tunnel endpoint by runtimeServiceId, which
    // is the runtime_services row id (what the runtime registered its tunnel
    // under). We use row.runtimeServiceId from the catalog projection — NOT
    // runtime_exposure_id, which would never match a registered endpoint.
    const result =
      row.serviceKind === "bare_dataplane"
        ? await dispatchBareRuntimeTool({
            runtimeId: row.runtimeId,
            runtimeServiceId: row.runtimeServiceId,
            envelope,
            args: sanitizedInput,
            builtinKind: row.builtinKind,
            toolName: row.visibleToolName,
            grant,
          })
        : await dispatchSyncTool({
            runtimeServiceId: row.runtimeServiceId,
            envelope,
            args: sanitizedInput,
            toolName: row.visibleToolName,
          })
    await completeRuntimeOperation({
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
      const err = result.error
      // v3.1 — drift-fix: preserve the runtime's structured synapse_error
      // so the chat UI can detect `details.scopeSource` / currentUrl etc.
      // and surface the "Manual grant required" widget for the active-page
      // UX (plan §clarification #33). Without this passthrough the
      // `_meta.synapse_error.details` block emitted by the chrome-devtools-mcp
      // provider's permission_denied path gets collapsed to plain text
      // before chat ever sees it.
      return withRuntimeToolOrigin(
        {
          content: [
            textBlock(
              `device dispatch failed (${err?.code}): ${err?.message}`
            ) as CanonicalContentBlock,
          ],
          isError: true,
          metadata: { synapse_error: err },
        },
        origin
      )
    }
    const tool = result.result as
      | {
          content?: CanonicalContentBlock[]
          isError?: boolean
          _meta?: Record<string, unknown>
        }
      | undefined
    // Forward non-error _meta back to the planner too — runtime providers
    // attach contextual data (e.g. synapse_list_pages) that the chat-side
    // renderer may want to read.
    return withRuntimeToolOrigin(
      {
        content: tool?.content ?? [],
        isError: tool?.isError,
        metadata: tool?._meta,
      },
      origin
    )
  }

  const executor = async (
    toolId: string,
    input: Record<string, unknown>,
    executionContext?: McpExecutionContext
  ): Promise<NormalizedMcpToolResult> => {
    if (device.handlers.has(toolId)) {
      return dispatchDeviceTool(toolId, input)
    }
    return legacy.executor(toolId, input, executionContext)
  }

  const refresh = async () => {
    const refreshed = await legacy.refresh()
    // Re-query device tools on each refresh so newly granted bindings show
    // up without restarting the session. Use the captured input so the
    // principal + subject set stays consistent across refreshes.
    const freshDevice = await projectRuntimeTools(projectInput)
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

function serializeGrantEnvelopeExpiresAt() {
  return dateToWireIsoInstant(new Date(Date.now() + 60_000))
}

function mcpErrorBlock(
  message: string,
  synapseError?: SynapseError,
  origin: ToolResultOrigin = CAPABILITY_PROJECTION_ORIGIN
): NormalizedMcpToolResult {
  return {
    content: [textBlock(message) as CanonicalContentBlock],
    isError: true,
    origin,
    // Forward the full SynapseError (code / message / details / task_id /
    // retry_nonce / authorization_task_id) when available so the dashboard and
    // downstream observers see the same shape the runtime exposes via
    // _meta.synapse_error. Keeping the bare-message overload preserves
    // backward compatibility for all the existing call sites that don't have
    // a structured error in hand.
    ...(synapseError ? { metadata: { synapse_error: synapseError } } : {}),
  }
}

// v3.1 browser preflight (plan §#3, #13, #14, #17, #18). Runs in
// dispatchDeviceTool BEFORE grant lookup so disabled exposures, unknown tools,
// scheme violations, and navigate_page arg-shape mismatches never spawn an
// empty authorization request. Returns a structured denial — caller wraps
// it into NormalizedMcpToolResult.metadata.synapse_error so the upstream
// SynapseError code/details survive the API edge instead of being
// flattened to a bracketed text string.
interface BrowserPreflightDenial {
  code: "runtime_constraint" | "invalid_request"
  message: string
  details?: Record<string, unknown>
}

function browserPreflightDeny(
  row: RuntimeCapabilityToolRow,
  visibleToolName: string,
  args: Record<string, unknown>
): BrowserPreflightDenial | null {
  const metadata = row.exposureMetadata
  if (
    metadata &&
    typeof metadata === "object" &&
    (metadata as { enabled?: unknown }).enabled === false
  ) {
    const disabledReason =
      typeof (metadata as { disabledReason?: unknown }).disabledReason ===
      "string"
        ? (metadata as { disabledReason: string }).disabledReason
        : undefined
    return {
      code: "runtime_constraint",
      message: `capability disabled${disabledReason ? ` (${disabledReason})` : ""}: ${row.exposureStableKey}`,
      details: {
        exposureStableKey: row.exposureStableKey,
        ...(disabledReason ? { disabledReason } : {}),
      },
    }
  }
  const lookup = visibleToolName.toLowerCase()
  const descriptor = BROWSER_TOOL_MAP[lookup]
  if (!descriptor) {
    return {
      code: "invalid_request",
      message: `unknown browser tool: ${visibleToolName}`,
      details: { visibleToolName },
    }
  }
  const effective = resolveEffectiveTarget(descriptor, args)
  if (!effective.ok) {
    return {
      code: "invalid_request",
      message: effective.detail,
      details: { reason: effective.code },
    }
  }
  if (effective.target.kind === "argument_url") {
    let parsed: URL | null = null
    try {
      parsed = new URL(effective.target.url)
    } catch {
      // fall through; parsed === null below triggers deny
    }
    if (!parsed) {
      return {
        code: "invalid_request",
        message: `url is not parseable: ${effective.target.url}`,
        details: { url: effective.target.url },
      }
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        code: "invalid_request",
        message: `url scheme not allowed: ${parsed.protocol}`,
        details: { url: effective.target.url, scheme: parsed.protocol },
      }
    }
  }
  return null
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
  row: RuntimeCapabilityToolRow
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
      isImConversation: projectInput.isImConversation,
      workspaceMemberId: projectInput.workspaceMemberId,
    },
    runtimeTarget: {
      runtimeCapabilityId: row.runtimeCapabilityId,
      runtimeId: row.runtimeId,
      runtimeExposureId: row.runtimeExposureId,
      requestedToolName: toolName,
      runtimeToolStableKey: row.visibleToolName,
      // Persist the source Agent session id so the post-approval auto-retry
      // path can stamp the same cua_focus_scope_id this dispatch would have
      // used (session:<sessionId>). Without it the device cua builtin
      // fail-closes on the retry envelope and the user-approved tool call
      // silently fails. Backs
      // tool_call_task_runtime_authorization.source_runtime_session_id (TEXT)
      // — the chat-runtime session.id.
      sourceRuntimeSessionId: projectInput.sessionId ?? "",
      deviceDisplayName: row.runtimeName,
    },
    authorizationPlan: {
      requestedAction,
      // Default option mirrors requestedAction verbatim; for exec_file with
      // >= 2 argv we also surface an argv_prefix alternative so the user can
      // authorize a broader pattern (e.g. all `git log ...`) without
      // re-prompting. See buildGrantOptions.
      grantOptions: buildGrantOptions(requestedAction),
    },
    requestMode: "background",
    availablePresets:
      principal.kind === "remote_agent"
        ? ["once", "remote_agent", "conversation", "workspace"]
        : ["once", "actor", "conversation", "workspace"],
    reason: `Tool ${toolName} requires authorization for device capability ${row.runtimeCapabilityId}`,
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
  row: RuntimeCapabilityToolRow
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
  const origin = runtimeToolOrigin(row)
  const supportsAuthRequest =
    projectInput.principal.kind === "actor" ||
    projectInput.principal.kind === "remote_agent"
  if (!supportsAuthRequest) {
    return mcpErrorBlock(
      `permission_denied: no active grant covers device capability ${row.runtimeCapabilityId} for this ${projectInput.principal.kind} principal`,
      undefined,
      origin
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
      `permission_denied: cannot create authorization request without a conversation context`,
      undefined,
      origin
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
          `runtime_authorization_requested: created task ${result.task.id}. Approve the request to retry with retry_nonce=${result.retryNonce}.`
        ) as CanonicalContentBlock,
      ],
      isError: true,
      origin,
      metadata: {
        synapse_error: {
          code: "runtime_authorization_requested",
          message: "user approval required",
          authorization_task_id: result.taskRecord.id,
          retry_nonce: result.retryNonce,
        },
      },
    }
  } catch (err) {
    return mcpErrorBlock(
      `authorization request failed: ${(err as Error).message}`,
      undefined,
      origin
    )
  }
}

/**
 * Structured Synapse error wrapped as a NormalizedMcpToolResult. Carries
 * the typed `code` (+ optional `details`) in metadata.synapse_error so the
 * front end can render specific UX (e.g. "this device doesn't support
 * Windows working_directory") instead of just a plain text message.
 *
 * Use this for any case where the failure has a known structured code
 * (invalid_request, permission_denied, runtime_constraint, etc).
 * mcpErrorBlock above stays for the unstructured "internal projection
 * failure" path that should never be hit in a happy day.
 */
function synapseErrorBlock(
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
  },
  origin: ToolResultOrigin = CAPABILITY_PROJECTION_ORIGIN
): NormalizedMcpToolResult {
  return {
    content: [textBlock(error.message) as CanonicalContentBlock],
    isError: true,
    origin,
    metadata: {
      synapse_error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    },
  }
}

/**
 * Raised by buildRequestedAction when an exec_file tool call carries
 * malformed args (program not a bare command name, args not string[]).
 * Caught by the dispatch path's broad try/catch (see L548 / L697) and
 * surfaced as a structured invalid_request tool result.
 */
class InvalidExecFileArgsError extends Error {
  readonly synapseCode = "invalid_request"
  readonly details: Record<string, unknown>
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = "InvalidExecFileArgsError"
    this.details = details
  }
}

/**
 * Raised by buildRequestedAction's classifier registry when a dispatched tool
 * carries a builtin_kind that has NO registered requested-action projector — a
 * genuinely-unknown NON-NULL kind (e.g. a future runtime_exposures_builtin_kind
 * enum value not yet taught to this classifier). Fail-closed: the call site maps
 * it to permission_denied rather than silently mis-routing the call to a wrong
 * capability's grant matcher.
 *
 * NOTE (P4a S8 null-reachability analysis): a NULL builtin_kind (a device-proxied
 * non-builtin/stdio exposure) is NOT unregistered — it has an EXPLICIT `case null`
 * projector that preserves its historical cua-shaped behavior, so it never
 * reaches this error. Only non-null unknowns fail closed here.
 */
class UnregisteredBuiltinKindError extends Error {
  readonly synapseCode = "permission_denied"
  readonly details: Record<string, unknown>
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = "UnregisteredBuiltinKindError"
    this.details = details
  }
}

function principalKindFor(principal: RuntimePrincipal): OperationPrincipalKind {
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
// Exported for tests; not part of the module's stable surface (no consumers
// outside this file at runtime).
export function buildRequestedAction(args: {
  /**
   * The dispatched exposure's `builtin_kind` (a builtin_kind-keyed classifier
   * registry, P4a S8). The four device builtins project identically to before;
   * `pty` gets its own projector (was previously mis-routed pty→null→cua); a
   * NULL kind (device-proxied non-builtin/stdio exposure) has an explicit
   * cua-preserving projector; a genuinely-unknown non-null kind fail-closes via
   * UnregisteredBuiltinKindError.
   */
  capability: "filesystem" | "commandline" | "browser" | "cua" | "pty" | null
  toolName: string
  /** The unnamespaced tool name as the device exposes it (e.g. "bash",
   *  "cua_click"). Used to distinguish read vs write at the tool level. */
  visibleToolName?: string
  args: Record<string, unknown>
  /**
   * Normalized device platform (from normalizeDevicePlatform(devices.
   * platform)). Used together with `isBundleAvailableForPlatform` to
   * decide whether to set `allowBundledToolchain: true` on an exec_file
   * grant — Windows devices with no win32 manifest entry should NOT get
   * a bundled-fallback grant they can't actually use, so the consent UI
   * doesn't mislead the user into approving an unrunnable invocation.
   */
  devicePlatform?: "win32" | "linux" | "darwin"
  /** Raw devices.arch ("x64", "arm64", ...). Required to gate the
   *  bundled-fallback grant strictly — the runtime manifest matches on
   *  `<platform>-<arch>` exactly. NULL/undefined → no bundled grant. */
  deviceArch?: string | null
}): RuntimeAuthorizationRequestedAction {
  const summary = `Tool ${args.toolName} requires authorization`
  const detail = `args: ${JSON.stringify(args.args).slice(0, 200)}`
  const tool = (args.visibleToolName ?? args.toolName).toLowerCase()
  switch (args.capability) {
    case "filesystem": {
      // v3.1 — per-tool action/path projection.
      // Old code returned `access:"read"` + `pathPrefixes:["/"]` for every
      // filesystem tool. That's wrong on two axes:
      //   1. Writers (fs_write/fs_edit/fs_delete/fs_history_restore) need a
      //      `write` grant; treating them as read produced a request that the
      //      device runtime then denied — silent dead-loop for the operator.
      //   2. Subtree-scoped tools (fs_index_status/fs_index_rebuild) live
      //      under `args.subtree`, not `args.path`. Asking for "/" forced the
      //      caller to widen their grant or fall through to no match.
      //   3. Pushdown tools (fs_search, fs_history_list-without-path,
      //      fs_index_task_status) operate over the caller's *existing*
      //      read prefixes — they have no scope of their own. Requesting
      //      "/" would force a scoped (/repo) user to widen; the matcher
      //      flags such requests with `scopeIsPushdown:true` so any
      //      compatible read grant satisfies them.
      const writeTools = new Set([
        "fs_write",
        "fs_edit",
        "fs_delete",
        "fs_history_restore",
        // Layer-2 dir/move tools (S3). All are writers; the grant must cover
        // their path(s). fs_move constrains BOTH endpoints (see below).
        "fs_mkdir",
        "fs_move",
        "fs_remove",
      ])
      // Tools that take their scope from `subtree` (index status/rebuild).
      const subtreeTools = new Set(["fs_index_status", "fs_index_rebuild"])
      // Tools that have no path/subtree of their own and run over the
      // caller's existing read grants. The runtime evaluates them against
      // envelope.runtime_authorization.grant_specs read prefixes; the
      // projection's pathPrefixes is purely a request hint for the
      // first-time-grant UX (the matcher ignores it via scopeIsPushdown).
      //
      // fs_history_list belongs here ONLY when args.path is absent —
      // with a path it acts like a normal read tool. See
      // handleHistoryList in filesystem.ts.
      // fs_index_task_status has no path/subtree at all (just task_id).
      const noScopeReadTools = new Set(["fs_search", "fs_index_task_status"])
      const isPushdownHistoryList =
        tool === "fs_history_list" && typeof args.args["path"] !== "string"
      const isPushdown = noScopeReadTools.has(tool) || isPushdownHistoryList
      const access: "read" | "write" = writeTools.has(tool) ? "write" : "read"
      let pathPrefixes: string[]
      if (isPushdown) {
        // "/"" is the only honest answer when there's no scoping info;
        // first-time callers without any fs grant still need an
        // approveable request, and "/" is what UI can render.
        pathPrefixes = ["/"]
      } else if (subtreeTools.has(tool)) {
        const sub =
          typeof args.args["subtree"] === "string"
            ? (args.args["subtree"] as string)
            : "/"
        pathPrefixes = [sub]
      } else if (tool === "fs_move") {
        // fs_move constrains BOTH endpoints — the grant must cover source AND
        // destination (F-C). Project both `source` and `destination` so the
        // matcher rejects a grant that covers only one side.
        const source =
          typeof args.args["source"] === "string"
            ? (args.args["source"] as string)
            : "/"
        const destination =
          typeof args.args["destination"] === "string"
            ? (args.args["destination"] as string)
            : "/"
        pathPrefixes = [source, destination]
      } else {
        const path =
          typeof args.args["path"] === "string"
            ? (args.args["path"] as string)
            : "/"
        pathPrefixes = [path]
      }
      // VFS paths are virtual-absolute (rooted at "/"); normalizePathPrefix
      // on both sides will canonicalize them.
      return {
        capability: "filesystem",
        toolName: args.toolName,
        summary,
        detail,
        filesystem: {
          access,
          pathPrefixes,
          ...(isPushdown ? { scopeIsPushdown: true } : {}),
        },
      }
    }
    case "commandline": {
      const workingDirectory =
        typeof args.args["working_directory"] === "string"
          ? (args.args["working_directory"] as string)
          : undefined
      if (tool === "exec_file") {
        const program = args.args["program"]
        if (typeof program !== "string" || program.length === 0) {
          throw new InvalidExecFileArgsError(
            "exec_file: program (non-empty string) is required"
          )
        }
        if (!isBareCommandName(program)) {
          throw new InvalidExecFileArgsError(
            "exec_file: program must be a bare command name (no /, \\, .., absolute path, ~)",
            { reason: "program_must_be_bare" }
          )
        }
        const rawArgv = args.args["args"]
        let argv: string[] = []
        if (rawArgv !== undefined) {
          if (
            !Array.isArray(rawArgv) ||
            rawArgv.some((v) => typeof v !== "string")
          ) {
            throw new InvalidExecFileArgsError(
              "exec_file: args must be string[] if provided"
            )
          }
          argv = rawArgv as string[]
        }
        // Bundle eligibility list is shared with the device-runtime
        // commandline builtin via @synapse/shared/access/policies/
        // commandline-normalize.ts — never hardcode the list here, or
        // the API will claim a program is bundle-fallback-able when the
        // device runtime can't actually deliver it (the original
        // "approved but unrunnable" bug).
        //
        // Also gate by exact device platformKey (platform + arch): a
        // Windows or linux-arm-only device with no matching manifest
        // entry must NOT receive an allowBundledToolchain=true grant —
        // the matcher would otherwise approve a call that fails at
        // execution time with "no manifest entry for platformKey". The
        // gate is strict — NULL platform or NULL arch → false (devices
        // that pre-date pairing-platform-reporting fall here and don't
        // get bundled grants until they re-pair).
        const isBundleEligible =
          isBundleEligibleProgram(program) &&
          isBundleAvailableForPlatform(
            program,
            args.devicePlatform,
            args.deviceArch ?? null
          )
        return {
          capability: "commandline",
          toolName: args.toolName,
          summary,
          detail,
          commandline: {
            executor: "exec_file",
            // Default approval is strict argv_exact. The runtime-
            // authorizations grant-options layer surfaces an
            // alternate argv_prefix option when argv.length >= 2.
            commandMatchType: "argv_exact",
            program,
            argvPrefix: argv,
            workingDirectory,
            allowBundledToolchain: isBundleEligible,
          },
        }
      }
      const command =
        typeof args.args["command"] === "string"
          ? (args.args["command"] as string)
          : ""
      const executor: "bash" | "powershell" =
        tool === "powershell" ? "powershell" : "bash"
      return {
        capability: "commandline",
        toolName: args.toolName,
        summary,
        detail,
        commandline: {
          executor,
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
      // v3.1: look up the descriptor in BROWSER_TOOL_MAP (single source of
      // truth — see @synapse/device-protocol/browser-tools). Unknown tools
      // should never reach this point because dispatchDeviceTool's
      // browserPreflightDeny rejects them first; return a fail-closed
      // shape just in case (empty operations → matcher always false).
      const descriptor = BROWSER_TOOL_MAP[tool]
      if (!descriptor) {
        return {
          capability: "browser",
          toolName: args.toolName,
          summary: `unknown browser tool: ${args.toolName}`,
          detail,
          browser: {
            action: "read",
            scopeType: undefined,
            origin: undefined,
            operations: [],
            scopeSource: "unknown_tool",
          },
        }
      }
      const effective = resolveEffectiveTarget(descriptor, args.args)
      if (effective.ok && effective.target.kind === "argument_url") {
        const scope = resolveUrlScope(effective.target.url)
        return {
          capability: "browser",
          toolName: args.toolName,
          summary,
          detail,
          browser: {
            action: descriptor.action,
            scopeType: "origin",
            origin: scope.origin,
            host: scope.host,
            registrableDomain: scope.registrableDomain,
            operations: [descriptor.operation],
            scopeSource: "args",
          },
        }
      }
      // current_page / page_id / all_pages — server cannot know the URL;
      // origin/host/registrableDomain stay undefined. Runtime resolves the
      // active page after envelope verification and runs the URL check
      // there (see chrome-devtools-mcp.ts step 6). scopeSource tells the
      // UI / chat card that this denial needs a manual grant.
      let scopeSource:
        | "runtime_page_id"
        | "runtime_all_pages"
        | "runtime_active_page"
      if (effective.ok && effective.target.kind === "page_id") {
        scopeSource = "runtime_page_id"
      } else if (effective.ok && effective.target.kind === "all_pages") {
        scopeSource = "runtime_all_pages"
      } else {
        scopeSource = "runtime_active_page"
      }
      return {
        capability: "browser",
        toolName: args.toolName,
        summary,
        detail,
        browser: {
          action: descriptor.action,
          scopeType: undefined,
          origin: undefined,
          operations: [descriptor.operation],
          scopeSource,
        },
      }
    }
    case "cua":
      return cuaProjector(tool, args.toolName, summary, detail)
    case null:
      // P4a S8 null-reachability analysis (explicit `case null` — preserves the
      // pre-P4a `case "cua": default:` behavior for a NULL builtin_kind).
      //
      // A device-proxied NON-builtin exposure (transport='stdio'|'http'|'sse'|
      // 'custom') projects builtin_kind=NULL (schema CHECK chk_runtime_exposures_
      // builtin_kind). Such an exposure is dispatchable: device.catalog.sync
      // persists whatever the authenticated device publishes with NO transport
      // restriction, the projection SELECT + handler assembly have no transport
      // filter, and dispatchDeviceTool routes it through here. No first-party
      // device-runtime builtin emits a non-builtin transport today, but the wire
      // contract fully supports it — so NULL is STRUCTURALLY REACHABLE for a real
      // dispatched tool. Its historical behavior (the collapsed `default`) was a
      // cua-shaped generic action; PRESERVED EXACTLY here to avoid a Mode-A
      // regression. Only genuinely-unknown NON-NULL kinds fail closed (default).
      return cuaProjector(tool, args.toolName, summary, detail)
    case "pty":
      // NEW pty projector (P4a S8). A pty builtin_kind produces a capability:
      // "pty" action gated by ptyPolicyAllows on cwd/isolation ONLY — command/
      // byte content is NEVER routed into a command-text matcher (that would be
      // fail-OPEN: a narrow command grant would become a full interactive
      // shell). The capability-equality guard makes a commandline/sandbox grant
      // structurally unable to cover pty.open. This REPLACES the prior pty→null→
      // cua mis-routing (the `row.builtinKind === "pty" ? null` call-site special
      // case is dropped). pty is TEST-ONLY in P4a (no production pty exposure).
      return {
        capability: "pty",
        toolName: args.toolName,
        summary,
        detail,
        pty: {
          workingDirectory:
            typeof args.args["working_directory"] === "string"
              ? (args.args["working_directory"] as string)
              : "/conversation",
        },
      }
    default:
      // Genuinely-unknown NON-NULL builtin_kind (a future
      // runtime_exposures_builtin_kind enum value this classifier hasn't been
      // taught) → fail-closed deny. NULL is handled explicitly above, so for the
      // current DeviceBuiltinKind union this branch is unreachable at the type
      // level; it exists as a runtime backstop against enum drift.
      throw new UnregisteredBuiltinKindError(
        `no requested-action projector for builtin_kind '${String(args.capability)}'`,
        { reason: "unregistered_builtin_kind" }
      )
  }
}

/**
 * cua requested-action projector. CUA_WRITE_TOOLS is the single source of truth
 * for which cua tool names require access='write' — imported from
 * @synapse/device-protocol so this classifier and the device-side enforcement in
 * device-runtime/src/builtins/cua.ts stay in lockstep. Also serves the NULL
 * (device-proxied non-builtin) projector (P4a S8 — preserves historical
 * behavior).
 */
function cuaProjector(
  tool: string,
  toolName: string,
  summary: string,
  detail: string
): RuntimeAuthorizationRequestedAction {
  const writeTools = new Set<string>(CUA_WRITE_TOOLS)
  return {
    capability: "cua",
    toolName,
    summary,
    detail,
    cua: { access: writeTools.has(tool) ? "write" : "read" },
  }
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

/**
 * Produce the grant options for an authorization request. Default is
 * always the exact / narrow form (matches setattr §8). For exec_file we
 * surface an additional argv_prefix alternative when there are >= 2 args
 * so the user can authorize the leading verb pattern (e.g. all `git log
 * ...`). Empty / single-arg invocations get only the default option
 * because an empty argvPrefix would authorize any args (matcher fails
 * closed on that, so the option would be useless).
 */
function buildGrantOptions(
  requestedAction: RuntimeAuthorizationRequestedAction
): {
  id: string
  summary: string
  detail?: string
  grantSpec: {
    capability: typeof requestedAction.capability
    filesystem?: typeof requestedAction.filesystem
    cua?: typeof requestedAction.cua
    browser?: typeof requestedAction.browser
    commandline?: typeof requestedAction.commandline
  }
}[] {
  // v3.1 §clarification G: for active_page / page_id / all_pages browser
  // tools, origin/host/registrableDomain are undefined. A default grant
  // option built from this would persist a scope-less browser grant —
  // normalizeBrowserGrantPolicy rejects it AND a one-click "Approve" UX
  // would silently fail. Suppress the default option entirely; the chat
  // card renders "Manual grant required" instead and the operator goes to
  // Settings. (Only the runtime-resolved browser targets hit this; args-URL
  // browser tools carry a concrete origin and keep their default option.)
  const suppressDefaultBrowserGrant =
    requestedAction.capability === "browser" &&
    requestedAction.browser !== undefined &&
    requestedAction.browser.scopeSource !== undefined &&
    requestedAction.browser.scopeSource !== "args"
  if (suppressDefaultBrowserGrant) {
    return []
  }
  const baseOption = {
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
  }
  const options = [baseOption]
  const cmd = requestedAction.commandline
  if (
    cmd &&
    cmd.executor === "exec_file" &&
    Array.isArray(cmd.argvPrefix) &&
    cmd.argvPrefix.length >= 2
  ) {
    const prefixArgv = cmd.argvPrefix.slice(0, cmd.argvPrefix.length - 1)
    options.push({
      id: "argv_prefix",
      summary: `Allow ${cmd.program} ${prefixArgv.join(" ")} ...`,
      detail: requestedAction.detail,
      grantSpec: {
        capability: requestedAction.capability,
        filesystem: requestedAction.filesystem,
        cua: requestedAction.cua,
        browser: requestedAction.browser,
        commandline: {
          ...cmd,
          commandMatchType: "argv_prefix",
          argvPrefix: prefixArgv,
        },
      },
    })
  }
  return options
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
