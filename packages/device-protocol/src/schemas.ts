// @synapse/device-protocol — zod schemas for Control Plane messages, REST DTOs,
// and the operation envelope embedded in MCP _meta.synapse_operation (§4.5).

import { z } from "zod"
import {
  DEVICE_BUILTIN_KINDS,
  DEVICE_CONTROL_PLANE_SESSION_STATUSES,
  DEVICE_EXPOSURE_RUNTIME_STATUSES,
  DEVICE_EXPOSURE_TRANSPORTS,
  DEVICE_MCP_ERROR_CODES,
  DEVICE_OPERATION_ATTEMPT_STATUSES,
  DEVICE_OPERATION_ATTEMPT_TRANSPORTS,
  DEVICE_OPERATION_STATUSES,
  DEVICE_OPERATION_TASK_MODES,
  DEVICE_PAIRING_MODES,
  DEVICE_PAIRING_STATUSES,
  DEVICE_PRINCIPAL_KINDS,
  DEVICE_SERVICE_KINDS,
  DEVICE_SERVICE_STATUSES,
  DEVICE_SYNC_MODES,
  DEVICE_SYNC_SOURCE_KINDS,
  DEVICE_SYNC_STATUSES,
  DEVICE_TRUST_STATUSES,
  DEVICE_TYPES,
  HOST_KINDS,
  RUNTIME_AUTHORIZATION_BROWSER_OPERATIONS,
  RUNTIME_AUTHORIZATION_CAPABILITIES,
  RUNTIME_AUTHORIZATION_GRANT_RETENTIONS,
  RUNTIME_AUTHORIZATION_GRANT_STATUSES,
  RUNTIME_AUTHORIZATION_REQUEST_MODES,
  SERVER_FACADE_ERROR_CODES,
} from "./enums.js"

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
export type DeviceCapabilityAccessTarget = z.infer<
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

// Commandline policy on the wire (snake_case). Mirrors the equivalent
// shared schema (packages/shared/src/access/policies/commandline.ts —
// WireCommandlinePolicySchema) but is duplicated here to preserve
// device-protocol's package-independence (no @synapse/shared dep so we
// don't invert the dependency graph). A parity test in
// packages/api/src/modules/capability-projection/commandline-parity.test.ts
// asserts both copies accept/reject identical sample inputs so a field
// drift fails CI.

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
  ]),
  program: z.string(),
  argv_prefix: z.array(z.string()).optional(),
  working_directory: z.string().optional(),
  allow_bundled_toolchain: z.boolean().optional(),
  allowed_env: z.array(z.string()).optional(),
})

export const RuntimeCommandlinePolicySchema = z.discriminatedUnion("executor", [
  ShellWireSchema,
  ExecFileWireSchema,
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
    const branch =
      spec.capability === "filesystem"
        ? spec.filesystem
        : spec.capability === "browser"
          ? spec.browser
          : spec.capability === "commandline"
            ? spec.commandline
            : spec.capability === "cua"
              ? spec.cua
              : undefined
    if (!branch) {
      ctx.addIssue({
        code: "custom",
        message: `grant spec missing required branch payload "${spec.capability}"`,
        path: [spec.capability],
      })
    }
  })
/** @deprecated camelCase API-side spec; wire (snake_case) consumers should use
 * RuntimeAuthorizationGrantWireSpec. API-side camelCase consumers should
 * import SharedRuntimeAuthorizationGrantSpec from @synapse/shared. */
export type RuntimeAuthorizationGrantSpec = z.infer<
  typeof RuntimeAuthorizationGrantSpecSchema
>
// subject-scope-refactor: wire-side snake_case alias. API code MUST disambiguate
// (Shared* for camelCase, *WireSpec for snake_case). Bare
// `RuntimeAuthorizationGrantSpec` is forbidden in packages/api/src (residue
// scan in plan Batch 12).
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
  device_runtime_session_id: z.uuid(),
  device_capability_id: z.uuid(),
  device_exposure_id: z.uuid(),
  device_tool_id: z.uuid(),
  device_tool_revision_id: z.uuid(),
  input_hash: z.string(),
  task_mode: z.enum(DEVICE_OPERATION_TASK_MODES),
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
  issued_at: z.string(),
  expires_at: z.string(),
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

export const DeviceSummarySchema = z.object({
  id: z.uuid(),
  workspace_id: z.uuid(),
  title: z.string(),
  host_kind: z.enum(HOST_KINDS),
  host_provider: z.string().nullable(),
  device_type: z.enum(DEVICE_TYPES),
  platform: z.string().nullable(),
  trust_status: z.enum(DEVICE_TRUST_STATUSES),
  last_seen_at: z.string().nullable(),
  last_connected_at: z.string().nullable(),
})
export type DeviceSummary = z.infer<typeof DeviceSummarySchema>

export const DeviceServiceSummarySchema = z.object({
  id: z.uuid(),
  device_id: z.uuid(),
  service_kind: z.enum(DEVICE_SERVICE_KINDS),
  version: z.string().nullable(),
  status: z.enum(DEVICE_SERVICE_STATUSES),
  last_seen_at: z.string().nullable(),
  remote_agent_machine_id: z.uuid().nullable(),
})
export type DeviceServiceSummary = z.infer<typeof DeviceServiceSummarySchema>

export const DeviceCapabilitySummarySchema = z.object({
  id: z.uuid(),
  workspace_id: z.uuid(),
  exposure_id: z.uuid(),
  // v3.1: stable_key (e.g. "builtin/browser/navigation") so UI can group /
  // filter without guessing from display_name. Needed by the Settings →
  // Runtime Authorizations page to scope the operation chip list to
  // operations the exposure can actually request.
  exposure_stable_key: z.string(),
  display_name: z.string(),
  transport: z.enum(DEVICE_EXPOSURE_TRANSPORTS),
  builtin_kind: z.enum(DEVICE_BUILTIN_KINDS).nullable(),
  runtime_status: z.enum(DEVICE_EXPOSURE_RUNTIME_STATUSES),
  // v3.1: exposure-level metadata pass-through. chrome-devtools-mcp provider
  // sets metadata.enabled and metadata.disabledReason so the dashboard can
  // render "Coming soon" / disabled rows without guessing.
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
})
export type DeviceCapabilitySummary = z.infer<
  typeof DeviceCapabilitySummarySchema
>

export const DeviceDetailSchema = DeviceSummarySchema.extend({
  description: z.string().nullable(),
  owner_workspace_member_id: z.uuid().nullable(),
  services: z.array(DeviceServiceSummarySchema),
  capabilities: z.array(DeviceCapabilitySummarySchema),
})
export type DeviceDetail = z.infer<typeof DeviceDetailSchema>

export const CreateCloudDeviceInputSchema = z.object({
  workspace_id: z.uuid(),
  title: z.string().min(1),
  host_provider: z.literal("e2b"),
  preset: z.string().optional(),
})
export type CreateCloudDeviceInput = z.infer<
  typeof CreateCloudDeviceInputSchema
>

// POST /workspaces/:wsId/devices/cloud returns the pending pairing-session
// info, NOT a DeviceDetail. The sandbox runtime claims the device row via
// /api/v1/devices/bootstrap with the bootstrap_token.
export const CreateCloudDeviceResultSchema = z.object({
  pending_device_id: z.uuid(),
  bootstrap_token: z.string(),
  pairing_session_id: z.uuid(),
  expires_at: z.string(),
})
export type CreateCloudDeviceResult = z.infer<
  typeof CreateCloudDeviceResultSchema
>

export const StartPairingInputSchema = z.object({
  workspace_id: z.uuid(),
  mode: z.enum(DEVICE_PAIRING_MODES),
  title: z.string().optional(),
  device_type: z.enum(DEVICE_TYPES).optional(),
  // service_join only:
  device_id: z.uuid().optional(),
  requested_pubkey_fingerprint: z.string().optional(),
  self_challenge: z.string().optional(),
})
export type StartPairingInput = z.infer<typeof StartPairingInputSchema>

export const PairingTicketSchema = z.object({
  pairing_session_id: z.uuid(),
  mode: z.enum(DEVICE_PAIRING_MODES),
  pairing_code: z.string().nullable(),
  expires_at: z.string(),
  verification_uri: z.string().nullable(),
  verification_uri_complete: z.string().nullable(),
  status: z.enum(DEVICE_PAIRING_STATUSES),
})
export type PairingTicket = z.infer<typeof PairingTicketSchema>

export const ConsumePairingInputSchema = z.object({
  pairing_code: z.string().min(1),
  device_pubkey: z.string(),
  service_pubkey: z.string(),
  service_kind: z.enum(DEVICE_SERVICE_KINDS).default("device_runtime"),
  client_version: z.string().optional(),
})
export type ConsumePairingInput = z.infer<typeof ConsumePairingInputSchema>

export const ConsumePairingResultSchema = z.object({
  device_id: z.uuid(),
  service_id: z.uuid(),
  service_key_id: z.uuid(),
  control_plane_url: z.string(),
})
export type ConsumePairingResult = z.infer<typeof ConsumePairingResultSchema>

export const ClaimDaemonInputSchema = z.object({
  remote_agent_machine_id: z.uuid(),
})
export type ClaimDaemonInput = z.infer<typeof ClaimDaemonInputSchema>

// subject-scope-refactor: SetActiveDeviceCapabilitiesInputSchema.target now
// reuses ScopedSubjectTargetWireSchema — a strict whitelist that rejects
// `workspace_member` subjects and any scoped combination outside
// `actor+conversation` / `remote_agent+conversation`. wire field
// `device_capability_ids` is unchanged (SDK + server protocol stability).
export const SetActiveDeviceCapabilitiesInputSchema = z.object({
  workspaceId: z.uuid(),
  target: ScopedSubjectTargetWireSchema,
  device_capability_ids: z.array(z.uuid()),
})
export type SetActiveDeviceCapabilitiesInput = z.infer<
  typeof SetActiveDeviceCapabilitiesInputSchema
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
export const DeviceHelloParamsSchema = z.object({
  device_id: z.uuid(),
  service_id: z.uuid(),
  service_kind: z.enum(DEVICE_SERVICE_KINDS),
  client_version: z.string(),
  signed_challenge: z.string(),
})
export type DeviceHelloParams = z.infer<typeof DeviceHelloParamsSchema>

export const DeviceCatalogToolSchema = z.object({
  stable_key: z.string(),
  name: z.string(),
  description: z.string(),
  input_schema: z.record(z.string(), z.unknown()),
  annotations: z.record(z.string(), z.unknown()).optional(),
})
export type DeviceCatalogTool = z.infer<typeof DeviceCatalogToolSchema>

export const DeviceCatalogExposureSchema = z.object({
  stable_key: z.string(),
  display_name: z.string(),
  description: z.string().optional(),
  transport: z.enum(DEVICE_EXPOSURE_TRANSPORTS),
  builtin_kind: z.enum(DEVICE_BUILTIN_KINDS).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tools: z.array(DeviceCatalogToolSchema),
})
export type DeviceCatalogExposure = z.infer<typeof DeviceCatalogExposureSchema>

export const DeviceCatalogSyncParamsSchema = z.object({
  exposures: z.array(DeviceCatalogExposureSchema),
})
export type DeviceCatalogSyncParams = z.infer<
  typeof DeviceCatalogSyncParamsSchema
>

export const DeviceServiceStatusParamsSchema = z.object({
  status: z.enum(DEVICE_SERVICE_STATUSES),
  detail: z.string().optional(),
})

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
  DEVICE_BUILTIN_KINDS,
  DEVICE_CONTROL_PLANE_SESSION_STATUSES,
  DEVICE_EXPOSURE_RUNTIME_STATUSES,
  DEVICE_EXPOSURE_TRANSPORTS,
  DEVICE_MCP_ERROR_CODES,
  DEVICE_OPERATION_ATTEMPT_STATUSES,
  DEVICE_OPERATION_ATTEMPT_TRANSPORTS,
  DEVICE_OPERATION_STATUSES,
  DEVICE_OPERATION_TASK_MODES,
  DEVICE_PAIRING_MODES,
  DEVICE_PAIRING_STATUSES,
  DEVICE_PRINCIPAL_KINDS,
  DEVICE_SERVICE_KINDS,
  DEVICE_SERVICE_STATUSES,
  DEVICE_SYNC_MODES,
  DEVICE_SYNC_SOURCE_KINDS,
  DEVICE_SYNC_STATUSES,
  DEVICE_TRUST_STATUSES,
  DEVICE_TYPES,
  HOST_KINDS,
  RUNTIME_AUTHORIZATION_CAPABILITIES,
  RUNTIME_AUTHORIZATION_GRANT_RETENTIONS,
  RUNTIME_AUTHORIZATION_GRANT_STATUSES,
  RUNTIME_AUTHORIZATION_REQUEST_MODES,
  SERVER_FACADE_ERROR_CODES,
}
