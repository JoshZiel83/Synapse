// @synapse/device-protocol — zod schemas for Control Plane messages, REST DTOs,
// and the operation envelope embedded in MCP _meta.synapse_operation (§4.5).

import { z } from "zod"
import { IsoInstantStringSchema } from "./instant.schema.js"
import {
  RUNTIME_BUILTIN_KINDS,
  RUNTIME_CONTROL_PLANE_SESSION_STATUSES,
  RUNTIME_EXPOSURE_RUNTIME_STATUSES,
  RUNTIME_EXPOSURE_TRANSPORTS,
  RUNTIME_MCP_ERROR_CODES,
  RUNTIME_OPERATION_ATTEMPT_STATUSES,
  RUNTIME_OPERATION_ATTEMPT_TRANSPORTS,
  RUNTIME_OPERATION_STATUSES,
  RUNTIME_OPERATION_TASK_MODES,
  RUNTIME_PAIRING_MODES,
  RUNTIME_PAIRING_STATUSES,
  RUNTIME_PRINCIPAL_KINDS,
  RUNTIME_SERVICE_KINDS,
  RUNTIME_SERVICE_STATUSES,
  DEVICE_TRUST_STATUSES,
  DEVICE_TYPES,
  HOST_KINDS,
  REMOTE_AGENT_RUNTIME_CATALOG_STATUSES,
  REMOTE_AGENT_RUNTIME_KINDS,
  REMOTE_AGENT_RUNTIME_STATES,
  RUNTIME_AUTHORIZATION_BROWSER_OPERATIONS,
  RUNTIME_AUTHORIZATION_CAPABILITIES,
  RUNTIME_AUTHORIZATION_GRANT_RETENTIONS,
  RUNTIME_AUTHORIZATION_GRANT_STATUSES,
  RUNTIME_AUTHORIZATION_REQUEST_MODES,
  SERVER_FACADE_ERROR_CODES,
} from "./enums.js"

// ───────────────────────── W3C trace-context wire fragment ───────────────────
// device-protocol is zod-only (deliberately NO dependency on @synapse/shared),
// so this pins the SAME regex + tracestate cap as the canonical artifact
// `packages/shared/src/utils/traceparent.ts` — a sanctioned literal duplicate
// listed in that file's JSDoc sync list; any change there must be mirrored
// byte-for-byte here. Receiver rule (degrade-not-reject, uniform): a malformed
// or oversized trace field `.catch(undefined)`s to ABSENT — it never rejects
// the business frame it rides on (works inside strictObject too: the failed
// key is dropped from the parse output on zod 4.3.6).
//
// The api→daemon direction (`agent:start` / `agent:deliver` items /
// `agent:task:resolved`) deliberately carries BARE `z.string().optional()`
// trace fields instead of this fragment: the api is the ONLY producer and
// mints the pair via activeTraceCarrier(), whose activeTracestate() enforces
// the same 1024 cap at the single emission point — receiver-side re-validation
// on that trusted first-party hop would be dead weight.

const TRACEPARENT_RE =
  /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/
const MAX_TRACESTATE_LENGTH = 1024

const wireTraceContextFields = {
  traceparent: z.string().regex(TRACEPARENT_RE).optional().catch(undefined),
  tracestate: z.string().max(MAX_TRACESTATE_LENGTH).optional().catch(undefined),
}

// A complete `{traceparent, tracestate?}` carrier as a list element (e.g.
// origin_carriers): here traceparent is REQUIRED per entry — an entry without
// a valid traceparent carries no linkable origin, so it degrades as a WHOLE
// entry (see originCarriersField), never as a per-key absence.
const WireTraceCarrierSchema = z.object({
  traceparent: z.string().regex(TRACEPARENT_RE),
  tracestate: z.string().max(MAX_TRACESTATE_LENGTH).optional().catch(undefined),
})

// Trace-carrier LIST field (origin_carriers) with PER-ENTRY salvage: a
// malformed entry `.catch(null)`s and is filtered out so the remaining
// link-worthy carriers survive — list entries are independent carriers, so
// salvage here is NOT the tracestate partial-salvage corruption vector (§3c).
// The whole field still degrades to absent (never rejecting the task body) on
// a non-array, an empty result, or >20 raw entries (producer bug / abuse).
const originCarriersField = z
  .array(WireTraceCarrierSchema.nullable().catch(null))
  .max(20)
  .transform((entries) => {
    const valid = entries.filter(
      (entry): entry is NonNullable<typeof entry> => entry !== null
    )
    return valid.length > 0 ? valid : undefined
  })
  .optional()
  .catch(undefined)

// ───────────────────────────── subject + scope (wire) ────────────────────────
// subject-scope-refactor: SubjectRefWireSchema is a deliberately narrow wire
// schema for device-capability-binding flows. Allowed kinds (4):
//   workspace / actor / remote_agent / conversation.
// Explicitly REJECTED: workspace_member (current device access-binding routes
// have no member-target path and admitting it would expand the surface), plus
// user / external / system (platform-wide subjects cannot anchor a workspace-
// bound device-capability binding). The wider `SubjectRef` in shared/access
// still admits workspace_member etc for non-device flows (skills, memory,
// evaluator) — those are out of scope here.

export const SubjectRefWireSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), workspaceId: z.uuid() }),
  z.object({ kind: z.literal("actor"), actorId: z.uuid() }),
  z.object({
    kind: z.literal("remote_agent"),
    remoteAgentId: z.uuid(),
  }),
  z.object({
    kind: z.literal("conversation"),
    conversationId: z.uuid(),
  }),
])
export type SubjectRefWire = z.infer<typeof SubjectRefWireSchema>

// subject-scope-refactor: ScopedSubjectTargetWireSchema applies a strict
// combination whitelist via superRefine. Only three shapes are allowed:
//   (a) scope == null + any of the 4 SubjectRefWireSchema kinds;
//   (b) (subject.kind=actor, scope.kind=conversation);
//   (c) (subject.kind=remote_agent, scope.kind=conversation).
// All other combinations RAISE Zod issue. Future scope kinds require
// synchronized updates to subjectScopeLabel, UI copy, specificityRank, the
// tg_runtime_authorization_grant_validate trigger, and full test coverage.

export const ScopedSubjectTargetWireSchema = z
  .object({
    subject: SubjectRefWireSchema,
    scope: SubjectRefWireSchema.optional(),
  })
  .superRefine((target, ctx) => {
    if (!target.scope) {
      return // any subject kind is fine when unscoped
    }
    const allowed =
      (target.subject.kind === "actor" ||
        target.subject.kind === "remote_agent") &&
      target.scope.kind === "conversation"
    if (!allowed) {
      ctx.addIssue({
        code: "custom",
        message: `scoped target (subject.kind=${target.subject.kind}, scope.kind=${target.scope.kind}) is not in whitelist (only actor+conversation, remote_agent+conversation)`,
        path: ["scope"],
      })
    }
  })
export type RuntimeCapabilityAccessTarget = z.infer<
  typeof ScopedSubjectTargetWireSchema
>

// ───────────────────────────── runtime authorization ─────────────────────────

export const RuntimeFilesystemPolicySchema = z.object({
  access: z.enum(["read", "write"]),
  path_prefixes: z.array(z.string()),
})

export const RuntimeBrowserPolicySchema = z.object({
  action: z.enum(["read", "write"]),
  scope_type: z.enum(["host", "domain", "origin"]).optional(),
  origin: z.string().optional(),
  host: z.string().optional(),
  registrable_domain: z.string().optional(),
  // v3.1: operation-level allowlist. Schema-optional for backward compat with
  // any envelope serialized before v3.1 lands, but the runtime matcher treats
  // missing `operations` as fail-closed when the requested action demands an
  // operation (see @synapse/shared matchers.ts).
  operations: z
    .array(z.enum(RUNTIME_AUTHORIZATION_BROWSER_OPERATIONS))
    .optional(),
})

// Commandline policy on the wire (snake_case). This is the canonical schema for
// signed envelopes and persisted grant_specs JSON. @synapse/shared exposes a
// compatibility alias named WireCommandlinePolicySchema, but must not redeclare
// a second schema copy.

const ShellWireSchema = z.object({
  executor: z.enum(["bash", "powershell"]),
  command_match_type: z.enum(["exact", "prefix", "tool"]),
  command_text: z.string().optional(),
  working_directory: z.string().optional(),
  allow_bundled_toolchain: z.boolean().optional(),
  allowed_env: z.array(z.string()).optional(),
})

const ExecFileWireSchema = z.object({
  executor: z.literal("exec_file"),
  command_match_type: z.enum([
    "argv_exact",
    "argv_prefix",
    "argv_exact_preapproved",
    "program_only",
  ]),
  program: z.string(),
  argv_prefix: z.array(z.string()).optional(),
  working_directory: z.string().optional(),
  allow_bundled_toolchain: z.boolean().optional(),
  allowed_env: z.array(z.string()).optional(),
})

// Sandbox confinement variant — no command/argv matcher (isolation is the
// boundary).
const SandboxWireSchema = z.object({
  executor: z.literal("sandbox"),
  working_directory: z.string().optional(),
  allowed_env: z.array(z.string()).optional(),
})

export const RuntimeCommandlinePolicySchema = z.discriminatedUnion("executor", [
  ShellWireSchema,
  ExecFileWireSchema,
  SandboxWireSchema,
])
export type RuntimeCommandlinePolicy = z.infer<
  typeof RuntimeCommandlinePolicySchema
>

export const RuntimeCuaPolicySchema = z.object({
  access: z.enum(["read", "write"]),
})

// subject-scope-refactor: RuntimeAuthorizationGrantSpecSchema gains a
// branch-specific superRefine: for each `capability`, the corresponding
// per-capability payload MUST be present and valid. Without this, a corrupt
// grant `{capability:"filesystem"}` missing `filesystem` would pass schema and
// later be silently treated as no_match by the runtime matcher, defeating the
// `grant_data_corrupt` denial path. Matched against package-neutral fixtures
// under repo-root `__fixtures__/grant-policy/` (parallel API-side validator
// `validateGrantPolicyForCapability` in packages/shared/src/access/policies/
// grant.ts uses camelCase keys; this snake_case version is wire-equivalent).
export const RuntimeAuthorizationGrantSpecSchema = z
  .object({
    capability: z.enum(RUNTIME_AUTHORIZATION_CAPABILITIES),
    filesystem: RuntimeFilesystemPolicySchema.optional(),
    browser: RuntimeBrowserPolicySchema.optional(),
    commandline: RuntimeCommandlinePolicySchema.optional(),
    cua: RuntimeCuaPolicySchema.optional(),
  })
  .superRefine((spec, ctx) => {
    const selectBranch = () => {
      switch (spec.capability) {
        case "filesystem":
          return spec.filesystem
        case "browser":
          return spec.browser
        case "commandline":
          return spec.commandline
        case "cua":
          return spec.cua
        default:
          return undefined
      }
    }
    const branch = selectBranch()
    if (!branch) {
      ctx.addIssue({
        code: "custom",
        message: `grant spec missing required branch payload "${spec.capability}"`,
        path: [spec.capability],
      })
    }
  })
// subject-scope-refactor: wire-side snake_case spec. API code MUST disambiguate
// (Shared* for camelCase from @synapse/shared, *WireSpec for snake_case here).
// The old bare `RuntimeAuthorizationGrantSpec` alias was removed in round-6 P2-1
// (it duplicated this type); use RuntimeAuthorizationGrantWireSpec on the wire.
export type RuntimeAuthorizationGrantWireSpec = z.infer<
  typeof RuntimeAuthorizationGrantSpecSchema
>

// ───────────────────────────── operation envelope (§4.5) ─────────────────────

/**
 * Embedded in MCP `tools/call` `params._meta.synapse_operation`. Signed by the
 * API; verified by the device runtime before any side effect. The signed
 * payload is this object minus the `signature` field; `signature_kid` IS
 * included in the signed payload.
 */
export const OperationEnvelopeSchema = z.object({
  operation_id: z.uuid(),
  attempt_id: z.uuid(),
  runtime_session_id: z.uuid(),
  runtime_capability_id: z.uuid(),
  runtime_exposure_id: z.uuid(),
  runtime_tool_id: z.uuid(),
  runtime_tool_revision_id: z.uuid(),
  input_hash: z.string(),
  task_mode: z.enum(RUNTIME_OPERATION_TASK_MODES),
  runtime_authorization: z
    .object({
      grant_ids: z.array(z.string()),
      grant_scope: z.string().min(1).max(64),
      grant_specs: z.array(RuntimeAuthorizationGrantSpecSchema),
      retry_nonce: z.string().optional(),
    })
    .optional(),
  // CUA focus-scope id. Server-signed, opaque string keyed by Agent run-session
  // (or principal-derived fallback). Optional at the schema level because
  // non-cua tool dispatches don't compute it; the cua builtin fails closed
  // when an envelope is present but this field is absent. See
  // capability-projection/cua-scope.ts for the derivation rule.
  cua_focus_scope_id: z.string().optional(),
  issued_at: IsoInstantStringSchema,
  expires_at: IsoInstantStringSchema,
  signature_kid: z.string(),
  signature: z.string(),
})
export type OperationEnvelope = z.infer<typeof OperationEnvelopeSchema>

// Structured error block returned via MCP `_meta.synapse_error` so codes
// survive `@modelcontextprotocol/sdk` McpServer wrapping (§14 open item).
export const SynapseErrorSchema = z.object({
  code: z.enum(SERVER_FACADE_ERROR_CODES),
  message: z.string(),
  retry_nonce: z.string().optional(),
  interaction_id: z.uuid().optional(),
  authorization_task_id: z.uuid().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
})
export type SynapseError = z.infer<typeof SynapseErrorSchema>

// ───────────────────────────── REST DTOs ─────────────────────────────────────

// Device read/management views (list / detail / service / capability) are
// app-facing camelCase contracts owned by @synapse/shared
// (schemas/devices.ts), consumed by web-next + the consumer-side device-sdk.
// They are NOT machine/wire shapes, so they no longer live here (master plan
// §2.3-6). The MANAGEMENT WRITE inputs (createCloudDevice / startPairing /
// claimRemoteAgentDaemon / setActiveRuntimeCapabilities) + the cloud RESULT
// view are likewise app-facing camelCase and now live in @synapse/shared
// (§5.1.1/§8.3). Only the true handshake wire shapes (consume / bootstrap /
// control-plane) remain below — device-runtime/sandbox are their sole callers.

// Local-QR consume handshake. The runtime reports its self-describing
// device facts (title / device_type / platform / arch) up-front so the API can
// persist platformKey from pairing onwards (see device-runtime/src/pairing.ts:
// without platform+arch the bundle-eligibility gate falls back to the
// conservative-permissive branch). These were previously only modelled in the
// API controller's local body schema — they are wire fields and belong here so
// the runtime client, SDK, and API parse one source.
export const ConsumePairingInputSchema = z.object({
  pairing_code: z.string().min(1),
  device_pubkey: z.string(),
  service_pubkey: z.string(),
  // R3.P2e-pairing: only device_runtime is pairable through /pairing-sessions
  // (consumeLocalPairingTx always writes 'device_runtime'; the api service-level
  // reject added in R2 stays as defense-in-depth). The WIRE contract used to
  // advertise EVERY service_kind, which was a lie — narrow it to the single
  // legal literal so a non-device_runtime consume fails at parse time.
  service_kind: z.literal("device_runtime").default("device_runtime"),
  client_version: z.string().optional(),
  title: z.string().optional(),
  device_type: z.enum(DEVICE_TYPES).optional(),
  platform: z.string().optional(),
  arch: z.string().optional(),
})
export type ConsumePairingInput = z.infer<typeof ConsumePairingInputSchema>

export const ConsumePairingResultSchema = z.object({
  device_id: z.uuid(),
  service_id: z.uuid(),
  service_key_id: z.uuid(),
  control_plane_url: z.string(),
})
export type ConsumePairingResult = z.infer<typeof ConsumePairingResultSchema>

// Cloud sandbox bootstrap handshake (§8.2). Runs INSIDE the sandbox on first
// boot, exchanging the env-injected bootstrap_token for long-term device +
// service credentials via POST /api/v1/devices/bootstrap. Unauthenticated; the
// bootstrap_token IS the credential. The result intentionally mirrors
// ConsumePairingResult (same logical handshake output, different entry path).
export const CloudBootstrapInputSchema = z.object({
  bootstrap_token: z.string().min(1),
  device_pubkey: z.string().min(1),
  service_pubkey: z.string().min(1),
  client_version: z.string().optional(),
  // R3.P2d-wire: sandboxes.platform/arch are now NOT NULL (fail-closed, no
  // back-compat). The cloud bootstrap client always sends process.platform /
  // process.arch, so REQUIRE them on the wire — the old `?? "linux"` / `?? "x64"`
  // handler fallback is removed and a missing platform/arch now fails at parse.
  platform: z.string().min(1),
  arch: z.string().min(1),
})
export type CloudBootstrapInput = z.infer<typeof CloudBootstrapInputSchema>

export const CloudBootstrapResultSchema = z.object({
  runtime_id: z.uuid(),
  service_id: z.uuid(),
  service_key_id: z.uuid(),
  control_plane_url: z.string(),
})
export type CloudBootstrapResult = z.infer<typeof CloudBootstrapResultSchema>

// ─────────────── remote-agent daemon internal RPC (machine surface) ──────────
// The remote-agent daemon (packages/remote-agent-daemon) talks to the API over
// a machine-key-authenticated REST surface mounted under /api/v1/internal/* .
// These are NOT app-facing ({ data }) endpoints — they are the daemon↔API
// machine protocol, registered via wireRoute() and consumed only by the daemon.
// The field set is snake_case because this is a machine/wire RPC surface. The
// API maps these payloads to its internal camelCase service parameters at the
// route boundary, and the daemon builds these same wire shapes before POSTing.
// They live here so the API route parser and the daemon's request-body
// construction reference ONE source instead of the previous split (API-local
// zod schemas + daemon hand-built JSON literals).
// Open payload arrays/records (questions / content_blocks / checklist /
// collaboration_state / metadata) are deliberately passthrough — their inner
// shape is owned by the agent-session/chat layers, not the transport.

export const RemoteAgentUserInputTaskBodySchema = z.strictObject({
  conversation_id: z.uuid(),
  run_key: z.string().trim().min(1).max(255),
  title: z.string().trim().min(1).max(255),
  instructions: z.string().trim().max(5000).optional(),
  questions: z.array(z.any()).min(1).max(4),
  expires_at: IsoInstantStringSchema.optional(),
  // Trace carriers of the deliveries feeding the turn that raised this task
  // (daemon dedupes by trace id, ≤20), so the api can LINK the task to every
  // originating trace. Degrade-not-reject with per-entry salvage (see
  // originCarriersField): a malformed entry is dropped, valid siblings
  // survive; a non-array or >20 entries drops the whole field, never the task.
  origin_carriers: originCarriersField,
})
export type RemoteAgentUserInputTaskBody = z.infer<
  typeof RemoteAgentUserInputTaskBodySchema
>

export const RemoteAgentPlanApprovalTaskBodySchema = z.strictObject({
  conversation_id: z.uuid(),
  run_key: z.string().trim().min(1).max(255),
  title: z.string().trim().min(1).max(255),
  summary: z.string().trim().max(5000).optional(),
  plan_markdown: z.string().trim().min(1),
  checklist: z.array(z.any()).optional(),
  collaboration_mode: z.string().trim().max(120).optional(),
  collaboration_state: z.record(z.string(), z.any()).optional(),
  expires_at: IsoInstantStringSchema.optional(),
  // Same contract as RemoteAgentUserInputTaskBodySchema.origin_carriers.
  origin_carriers: originCarriersField,
})
export type RemoteAgentPlanApprovalTaskBody = z.infer<
  typeof RemoteAgentPlanApprovalTaskBodySchema
>

export const RemoteAgentSendMessageBodySchema = z.strictObject({
  conversation_id: z.uuid(),
  client_message_id: z.uuid().optional(),
  content_blocks: z.array(z.any()).min(1),
  reply_to_item_id: z.uuid().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
})
export type RemoteAgentSendMessageBody = z.infer<
  typeof RemoteAgentSendMessageBodySchema
>

export const RemoteAgentCompleteDeliveriesBodySchema = z.strictObject({
  delivery_ids: z.array(z.uuid()).min(1),
})
export type RemoteAgentCompleteDeliveriesBody = z.infer<
  typeof RemoteAgentCompleteDeliveriesBodySchema
>

// Per-delivery failure report (clean-break reshape, remediation plan §4.C /
// §4.D change 4d): each failed delivery carries ITS OWN originating trace
// context, so a mixed-origin batch failure no longer collapses every delivery
// under one conversation-level traceparent (the C3a fan-in mis-parenting).
// Trace fields are degrade-not-reject like every api-inbound carrier — a
// malformed field drops to absent, never the delivery or the body.
export const RemoteAgentFailDeliveryEntrySchema = z.strictObject({
  delivery_id: z.uuid(),
  ...wireTraceContextFields,
})
export type RemoteAgentFailDeliveryEntry = z.infer<
  typeof RemoteAgentFailDeliveryEntrySchema
>

export const RemoteAgentFailDeliveriesBodySchema = z.strictObject({
  deliveries: z.array(RemoteAgentFailDeliveryEntrySchema).min(1),
  reason: z.string().trim().max(2000).optional(),
})
export type RemoteAgentFailDeliveriesBody = z.infer<
  typeof RemoteAgentFailDeliveriesBodySchema
>

export const RemoteAgentHistoryQuerySchema = z.strictObject({
  after_sequence: z.coerce.number().int().min(0).optional(),
  before_sequence: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
export type RemoteAgentHistoryQuery = z.infer<
  typeof RemoteAgentHistoryQuerySchema
>

export const RemoteAgentCheckMessagesQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(500).optional(),
})
export type RemoteAgentCheckMessagesQuery = z.infer<
  typeof RemoteAgentCheckMessagesQuerySchema
>

export const RemoteAgentSearchMessagesQuerySchema = z.strictObject({
  conversation_id: z.uuid(),
  q: z.string().trim().min(1).max(512),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})
export type RemoteAgentSearchMessagesQuery = z.infer<
  typeof RemoteAgentSearchMessagesQuerySchema
>

// Built-in reverse-MCP IM tool inputs. This is also a machine surface: the
// remote-agent runtime calls the API's MCP endpoint, so these inputs stay
// snake_case and the API maps them to internal camelCase service parameters.
// Projected plugin/device tools keep their downstream-owned raw JSON Schema and
// are intentionally not modeled here.
export const RemoteAgentMcpListConversationsToolInputSchema = z.strictObject({})
export type RemoteAgentMcpListConversationsToolInput = z.infer<
  typeof RemoteAgentMcpListConversationsToolInputSchema
>

export const RemoteAgentMcpCheckMessagesToolInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(500).optional(),
})
export type RemoteAgentMcpCheckMessagesToolInput = z.infer<
  typeof RemoteAgentMcpCheckMessagesToolInputSchema
>

export const RemoteAgentMcpReadHistoryToolInputSchema = z.strictObject({
  after_sequence: z.number().int().min(0).optional(),
  before_sequence: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(200).optional(),
})
export type RemoteAgentMcpReadHistoryToolInput = z.infer<
  typeof RemoteAgentMcpReadHistoryToolInputSchema
>

export const RemoteAgentMcpSendMessageToolInputSchema = z.strictObject({
  content: z.string().trim().min(1).max(20000),
  reply_to_item_id: z.uuid().optional(),
})
export type RemoteAgentMcpSendMessageToolInput = z.infer<
  typeof RemoteAgentMcpSendMessageToolInputSchema
>

export const RemoteAgentMcpSearchMessagesToolInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(512),
  limit: z.number().int().min(1).max(100).optional(),
})
export type RemoteAgentMcpSearchMessagesToolInput = z.infer<
  typeof RemoteAgentMcpSearchMessagesToolInputSchema
>

// Remote-agent daemon -> API WebSocket messages. This is the non-REST machine
// surface under /ws/remote-agents. It uses snake_case wire keys, and the API
// converts these to internal camelCase records inside remote-agents/wire.ts.
const RemoteAgentRuntimeKindWireSchema = z.enum(REMOTE_AGENT_RUNTIME_KINDS)
const RemoteAgentRuntimeStateWireSchema = z.enum(REMOTE_AGENT_RUNTIME_STATES)
const RemoteAgentRuntimeCatalogStatusWireSchema = z.enum(
  REMOTE_AGENT_RUNTIME_CATALOG_STATUSES
)

export const RemoteAgentRuntimeCapabilityWireSchema = z.strictObject({
  supports_request_user_input: z.boolean().optional(),
  supports_plan_mode: z.boolean().optional(),
  supports_persistent_session: z.boolean().optional(),
  supports_codex_app_server: z.boolean().optional(),
  supports_structured_io: z.boolean().optional(),
})
export type RemoteAgentRuntimeCapabilityWire = z.infer<
  typeof RemoteAgentRuntimeCapabilityWireSchema
>

export const RemoteAgentRuntimeCatalogEntryWireSchema = z.strictObject({
  runtime_kind: RemoteAgentRuntimeKindWireSchema,
  executable_path: z.string().optional(),
  status: RemoteAgentRuntimeCatalogStatusWireSchema,
  version: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  last_error: z.string().optional(),
})
export type RemoteAgentRuntimeCatalogEntryWire = z.infer<
  typeof RemoteAgentRuntimeCatalogEntryWireSchema
>

export const RemoteAgentMachineHeartbeatMessageSchema = z.strictObject({
  type: z.literal("heartbeat"),
})
export type RemoteAgentMachineHeartbeatMessage = z.infer<
  typeof RemoteAgentMachineHeartbeatMessageSchema
>

// The four work-triggering daemon→api machine messages (ready, runtime:catalog,
// agent:session, agent:status — never heartbeat) carry optional W3C trace
// context on the envelope, stamped from the daemon's active carrier, so the
// api's per-message SERVER spans parent to the daemon-side trace (§4.D).
export const RemoteAgentMachineReadyMessageSchema = z.strictObject({
  type: z.literal("ready"),
  runtime_catalog: z.array(RemoteAgentRuntimeCatalogEntryWireSchema),
  ...wireTraceContextFields,
})
export type RemoteAgentMachineReadyMessage = z.infer<
  typeof RemoteAgentMachineReadyMessageSchema
>

export const RemoteAgentRuntimeCatalogMessageSchema = z.strictObject({
  type: z.literal("runtime:catalog"),
  runtime_catalog: z.array(RemoteAgentRuntimeCatalogEntryWireSchema),
  ...wireTraceContextFields,
})
export type RemoteAgentRuntimeCatalogMessage = z.infer<
  typeof RemoteAgentRuntimeCatalogMessageSchema
>

export const RemoteAgentSessionMessageSchema = z.strictObject({
  type: z.literal("agent:session"),
  remote_agent_id: z.string().min(1),
  conversation_id: z.string().min(1),
  state: RemoteAgentRuntimeStateWireSchema.optional(),
  session_id: z.string().nullable().optional(),
  ...wireTraceContextFields,
})
export type RemoteAgentSessionMessage = z.infer<
  typeof RemoteAgentSessionMessageSchema
>

export const RemoteAgentStatusMessageSchema = z.strictObject({
  type: z.literal("agent:status"),
  remote_agent_id: z.string().min(1),
  state: RemoteAgentRuntimeStateWireSchema,
  status_text: z.string().nullable().optional(),
  conversation_id: z.string().nullable().optional(),
  task_id: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  last_error: z.string().nullable().optional(),
  run_key: z.string().nullable().optional(),
  capabilities: RemoteAgentRuntimeCapabilityWireSchema.optional(),
  ...wireTraceContextFields,
})
export type RemoteAgentStatusMessage = z.infer<
  typeof RemoteAgentStatusMessageSchema
>

export const RemoteAgentDaemonToApiWsMessageSchema = z.discriminatedUnion(
  "type",
  [
    RemoteAgentMachineHeartbeatMessageSchema,
    RemoteAgentMachineReadyMessageSchema,
    RemoteAgentRuntimeCatalogMessageSchema,
    RemoteAgentSessionMessageSchema,
    RemoteAgentStatusMessageSchema,
  ]
)
export type RemoteAgentDaemonToApiWsMessage = z.infer<
  typeof RemoteAgentDaemonToApiWsMessageSchema
>

export type RemoteAgentDaemonToApiWsFrameParseResult =
  | {
      ok: true
      message: RemoteAgentDaemonToApiWsMessage
    }
  | {
      ok: false
      error: "parse_error" | "invalid_message"
      details?: z.ZodError
    }

export function parseRemoteAgentDaemonToApiWsFrame(
  raw: string
): RemoteAgentDaemonToApiWsFrameParseResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, error: "parse_error" }
  }

  const parsed = RemoteAgentDaemonToApiWsMessageSchema.safeParse(json)
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid_message",
      details: parsed.error,
    }
  }

  return { ok: true, message: parsed.data }
}

export const RemoteAgentApiConnectedMessageSchema = z.strictObject({
  type: z.literal("connected"),
  machine_id: z.string().min(1),
  session_id: z.string().min(1),
  fencing_token: z.string().optional(),
})
export type RemoteAgentApiConnectedMessage = z.infer<
  typeof RemoteAgentApiConnectedMessageSchema
>

export const RemoteAgentApiAuthErrorMessageSchema = z.strictObject({
  type: z.literal("auth_error"),
  message: z.string().min(1),
})
export type RemoteAgentApiAuthErrorMessage = z.infer<
  typeof RemoteAgentApiAuthErrorMessageSchema
>

export const RemoteAgentApiFencedMessageSchema = z.strictObject({
  type: z.literal("fenced"),
  reason: z.string().optional(),
})
export type RemoteAgentApiFencedMessage = z.infer<
  typeof RemoteAgentApiFencedMessageSchema
>

export const RemoteAgentApiPongMessageSchema = z.strictObject({
  type: z.literal("pong"),
})
export type RemoteAgentApiPongMessage = z.infer<
  typeof RemoteAgentApiPongMessageSchema
>

export const RemoteAgentApiStartMessageSchema = z.strictObject({
  type: z.literal("agent:start"),
  remote_agent_id: z.string().min(1),
  conversation_id: z.string().min(1).nullable().optional(),
  runtime_kind: RemoteAgentRuntimeKindWireSchema,
  runtime_path: z.string().nullable().optional(),
  local_root_path: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  fencing_token: z.string().optional(),
  server_url: z.string().optional(),
  // W3C trace context of the request that triggered this start, so the daemon
  // can continue the same distributed trace across its subprocess + api
  // callbacks. tracestate rides with traceparent (vendor members survive
  // first-party hops; the pair is minted via activeTraceCarrier()).
  traceparent: z.string().optional(),
  tracestate: z.string().optional(),
})
export type RemoteAgentApiStartMessage = z.infer<
  typeof RemoteAgentApiStartMessageSchema
>

export const RemoteAgentApiStopMessageSchema = z.strictObject({
  type: z.literal("agent:stop"),
  remote_agent_id: z.string().min(1),
})
export type RemoteAgentApiStopMessage = z.infer<
  typeof RemoteAgentApiStopMessageSchema
>

export const RemoteAgentApiDeliveryWireSchema = z.strictObject({
  remote_agent_id: z.string().min(1),
  delivery_id: z.string().min(1),
  conversation_id: z.string().min(1),
  item_id: z.string().min(1),
  // Per-delivery W3C trace context (the enqueuing request's trace; traceparent
  // persisted on the delivery row, tracestate live-path only). Per-delivery,
  // NOT per-frame: one agent:deliver batch fans in deliveries from many
  // conversations/requests, each with its own trace.
  traceparent: z.string().optional(),
  tracestate: z.string().optional(),
})
export type RemoteAgentApiDeliveryWire = z.infer<
  typeof RemoteAgentApiDeliveryWireSchema
>

export const RemoteAgentApiDeliverMessageSchema = z.strictObject({
  type: z.literal("agent:deliver"),
  deliveries: z.array(RemoteAgentApiDeliveryWireSchema),
})
export type RemoteAgentApiDeliverMessage = z.infer<
  typeof RemoteAgentApiDeliverMessageSchema
>

export const RemoteAgentApiTaskResolvedMessageSchema = z.strictObject({
  type: z.literal("agent:task:resolved"),
  remote_agent_id: z.string().min(1),
  task_id: z.string().min(1),
  task: z.record(z.string(), z.unknown()),
  // W3C trace context of the request resolving this task (e.g. a user-input
  // reply), so the daemon's continued turn rejoins the resolver's trace.
  traceparent: z.string().optional(),
  tracestate: z.string().optional(),
})
export type RemoteAgentApiTaskResolvedMessage = z.infer<
  typeof RemoteAgentApiTaskResolvedMessageSchema
>

export const RemoteAgentApiToDaemonWsMessageSchema = z.discriminatedUnion(
  "type",
  [
    RemoteAgentApiConnectedMessageSchema,
    RemoteAgentApiAuthErrorMessageSchema,
    RemoteAgentApiFencedMessageSchema,
    RemoteAgentApiPongMessageSchema,
    RemoteAgentApiStartMessageSchema,
    RemoteAgentApiStopMessageSchema,
    RemoteAgentApiDeliverMessageSchema,
    RemoteAgentApiTaskResolvedMessageSchema,
  ]
)
export type RemoteAgentApiToDaemonWsMessage = z.infer<
  typeof RemoteAgentApiToDaemonWsMessageSchema
>

// ───────────────────────────── Control Plane messages (§7.1) ────────────────

// JSON-RPC 2.0 framing.
export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
})
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>

export type JsonRpcRequestFrameParseResult =
  | {
      ok: true
      request: JsonRpcRequest
    }
  | {
      ok: false
      error: "parse_error" | "invalid_request"
      details?: z.ZodError
    }

export function parseJsonRpcRequestFrame(
  raw: string
): JsonRpcRequestFrameParseResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, error: "parse_error" }
  }

  const parsed = JsonRpcRequestSchema.safeParse(json)
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid_request",
      details: parsed.error,
    }
  }

  return { ok: true, request: parsed.data }
}

export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
})
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>

// device → server
export const RuntimeHelloParamsSchema = z.object({
  runtime_id: z.uuid(),
  service_id: z.uuid(),
  service_kind: z.enum(RUNTIME_SERVICE_KINDS),
  client_version: z.string(),
  signed_challenge: z.string(),
})
export type RuntimeHelloParams = z.infer<typeof RuntimeHelloParamsSchema>

export const RuntimeCatalogToolSchema = z.object({
  stable_key: z.string(),
  name: z.string(),
  description: z.string(),
  input_schema: z.record(z.string(), z.unknown()),
  annotations: z.record(z.string(), z.unknown()).optional(),
})
export type RuntimeCatalogTool = z.infer<typeof RuntimeCatalogToolSchema>

export const RuntimeCatalogExposureSchema = z.object({
  stable_key: z.string(),
  display_name: z.string(),
  description: z.string().optional(),
  transport: z.enum(RUNTIME_EXPOSURE_TRANSPORTS),
  builtin_kind: z.enum(RUNTIME_BUILTIN_KINDS).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tools: z.array(RuntimeCatalogToolSchema),
})
export type RuntimeCatalogExposure = z.infer<
  typeof RuntimeCatalogExposureSchema
>

export const RuntimeCatalogSyncParamsSchema = z.object({
  exposures: z.array(RuntimeCatalogExposureSchema),
})
export type RuntimeCatalogSyncParams = z.infer<
  typeof RuntimeCatalogSyncParamsSchema
>

export const RuntimeServiceStatusParamsSchema = z.object({
  status: z.enum(RUNTIME_SERVICE_STATUSES),
  detail: z.string().optional(),
})
export type RuntimeServiceStatusParams = z.infer<
  typeof RuntimeServiceStatusParamsSchema
>

export const RuntimeTunnelUpParamsSchema = z.object({
  internal_url: z.string(),
})
export type RuntimeTunnelUpParams = z.infer<typeof RuntimeTunnelUpParamsSchema>

export const RuntimeTunnelDownParamsSchema = z.object({
  reason: z.string().optional(),
})
export type RuntimeTunnelDownParams = z.infer<
  typeof RuntimeTunnelDownParamsSchema
>

export const RuntimeSessionOpenedParamsSchema = z.object({
  runtime_session_id: z.uuid(),
  conversation_id: z.uuid().nullable().optional(),
  actor_id: z.uuid().nullable().optional(),
})
export type RuntimeSessionOpenedParams = z.infer<
  typeof RuntimeSessionOpenedParamsSchema
>

export const RuntimeSessionClosedParamsSchema = z.object({
  runtime_session_id: z.uuid(),
})
export type RuntimeSessionClosedParams = z.infer<
  typeof RuntimeSessionClosedParamsSchema
>

export const RuntimeTaskRefParamsSchema = z.object({
  operation_id: z.uuid(),
  attempt_id: z.uuid().optional(),
  // W3C trace context of the api dispatch that created this operation, echoed
  // back by the runtime so the task-result leg rejoins the dispatch trace
  // (mirrors tools/call `_meta.traceparent`, SEP-414). Flows into
  // device.task.received/started/status and, via .extend below, output/result.
  ...wireTraceContextFields,
})
export type RuntimeTaskRefParams = z.infer<typeof RuntimeTaskRefParamsSchema>

export const RuntimeTaskOutputParamsSchema = RuntimeTaskRefParamsSchema.extend({
  output: z.unknown(),
})
export type RuntimeTaskOutputParams = z.infer<
  typeof RuntimeTaskOutputParamsSchema
>

export const RuntimeTaskResultParamsSchema = RuntimeTaskRefParamsSchema.extend({
  ok: z.boolean(),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
  result_hash: z.string().optional(),
})
export type RuntimeTaskResultParams = z.infer<
  typeof RuntimeTaskResultParamsSchema
>

export const RuntimeEventEmitParamsSchema = z.object({
  event_type: z.string().min(1).max(80),
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  conversation_id: z.uuid().nullable().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
})
export type RuntimeEventEmitParams = z.infer<
  typeof RuntimeEventEmitParamsSchema
>

export const RuntimeVfsExposureUpsertParamsSchema = z.object({
  exposure_id: z.uuid(),
  vfs: z.record(z.string(), z.unknown()),
})
export type RuntimeVfsExposureUpsertParams = z.infer<
  typeof RuntimeVfsExposureUpsertParamsSchema
>

// server → device
export const ServerRuntimeSessionOpenParamsSchema = z.object({
  runtime_session_id: z.uuid(),
  conversation_id: z.uuid().nullable(),
})

export const ServerRuntimeSessionCloseParamsSchema = z.object({
  runtime_session_id: z.uuid(),
})

export const ServerOperationCancelParamsSchema = z.object({
  operation_id: z.uuid(),
  reason: z.string().optional(),
})

export const ServerCuaTerminateParamsSchema = z.object({
  runtime_session_id: z.uuid(),
  reason: z.string(),
})

// Re-export the enum lists so consumers can iterate.
export {
  RUNTIME_BUILTIN_KINDS,
  RUNTIME_CONTROL_PLANE_SESSION_STATUSES,
  RUNTIME_EXPOSURE_RUNTIME_STATUSES,
  RUNTIME_EXPOSURE_TRANSPORTS,
  RUNTIME_MCP_ERROR_CODES,
  RUNTIME_OPERATION_ATTEMPT_STATUSES,
  RUNTIME_OPERATION_ATTEMPT_TRANSPORTS,
  RUNTIME_OPERATION_STATUSES,
  RUNTIME_OPERATION_TASK_MODES,
  RUNTIME_PAIRING_MODES,
  RUNTIME_PAIRING_STATUSES,
  RUNTIME_PRINCIPAL_KINDS,
  RUNTIME_SERVICE_KINDS,
  RUNTIME_SERVICE_STATUSES,
  DEVICE_TRUST_STATUSES,
  DEVICE_TYPES,
  HOST_KINDS,
  RUNTIME_AUTHORIZATION_CAPABILITIES,
  RUNTIME_AUTHORIZATION_GRANT_RETENTIONS,
  RUNTIME_AUTHORIZATION_GRANT_STATUSES,
  RUNTIME_AUTHORIZATION_REQUEST_MODES,
  SERVER_FACADE_ERROR_CODES,
}
