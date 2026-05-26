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
  RUNTIME_AUTHORIZATION_GRANT_SCOPES,
  RUNTIME_AUTHORIZATION_GRANT_STATUSES,
  RUNTIME_AUTHORIZATION_REQUEST_MODES,
  SERVER_FACADE_ERROR_CODES,
} from "./enums.js"

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

export const RuntimeCommandlinePolicySchema = z.object({
  executor: z.literal("bash"),
  command_match_type: z.enum(["exact", "prefix", "tool"]),
  command_text: z.string().optional(),
  working_directory: z.string().optional(),
})

export const RuntimeCuaPolicySchema = z.object({
  access: z.enum(["read", "write"]),
})

export const RuntimeAuthorizationGrantSpecSchema = z.object({
  capability: z.enum(RUNTIME_AUTHORIZATION_CAPABILITIES),
  filesystem: RuntimeFilesystemPolicySchema.optional(),
  browser: RuntimeBrowserPolicySchema.optional(),
  commandline: RuntimeCommandlinePolicySchema.optional(),
  cua: RuntimeCuaPolicySchema.optional(),
})
export type RuntimeAuthorizationGrantSpec = z.infer<
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
  operation_id: z.string().uuid(),
  attempt_id: z.string().uuid(),
  device_runtime_session_id: z.string().uuid(),
  device_capability_id: z.string().uuid(),
  device_exposure_id: z.string().uuid(),
  device_tool_id: z.string().uuid(),
  device_tool_revision_id: z.string().uuid(),
  input_hash: z.string(),
  task_mode: z.enum(DEVICE_OPERATION_TASK_MODES),
  runtime_authorization: z
    .object({
      grant_ids: z.array(z.string()),
      grant_scope: z.enum(RUNTIME_AUTHORIZATION_GRANT_SCOPES),
      grant_specs: z.array(RuntimeAuthorizationGrantSpecSchema),
      retry_nonce: z.string().optional(),
    })
    .optional(),
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
  interaction_id: z.string().uuid().optional(),
  authorization_task_id: z.string().uuid().optional(),
  details: z.record(z.unknown()).optional(),
})
export type SynapseError = z.infer<typeof SynapseErrorSchema>

// ───────────────────────────── REST DTOs ─────────────────────────────────────

export const DeviceSummarySchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
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
  id: z.string().uuid(),
  device_id: z.string().uuid(),
  service_kind: z.enum(DEVICE_SERVICE_KINDS),
  version: z.string().nullable(),
  status: z.enum(DEVICE_SERVICE_STATUSES),
  last_seen_at: z.string().nullable(),
  remote_agent_machine_id: z.string().uuid().nullable(),
})
export type DeviceServiceSummary = z.infer<typeof DeviceServiceSummarySchema>

export const DeviceCapabilitySummarySchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  exposure_id: z.string().uuid(),
  display_name: z.string(),
  transport: z.enum(DEVICE_EXPOSURE_TRANSPORTS),
  builtin_kind: z.enum(DEVICE_BUILTIN_KINDS).nullable(),
  runtime_status: z.enum(DEVICE_EXPOSURE_RUNTIME_STATUSES),
  // v3.1: exposure-level metadata pass-through. chrome-devtools-mcp provider
  // sets metadata.enabled and metadata.disabledReason so the dashboard can
  // render "Coming soon" / disabled rows without guessing.
  metadata: z.record(z.unknown()).nullable().optional(),
})
export type DeviceCapabilitySummary = z.infer<
  typeof DeviceCapabilitySummarySchema
>

export const DeviceDetailSchema = DeviceSummarySchema.extend({
  description: z.string().nullable(),
  owner_workspace_member_id: z.string().uuid().nullable(),
  services: z.array(DeviceServiceSummarySchema),
  capabilities: z.array(DeviceCapabilitySummarySchema),
})
export type DeviceDetail = z.infer<typeof DeviceDetailSchema>

export const CreateCloudDeviceInputSchema = z.object({
  workspace_id: z.string().uuid(),
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
  pending_device_id: z.string().uuid(),
  bootstrap_token: z.string(),
  pairing_session_id: z.string().uuid(),
  expires_at: z.string(),
})
export type CreateCloudDeviceResult = z.infer<
  typeof CreateCloudDeviceResultSchema
>

export const StartPairingInputSchema = z.object({
  workspace_id: z.string().uuid(),
  mode: z.enum(DEVICE_PAIRING_MODES),
  title: z.string().optional(),
  device_type: z.enum(DEVICE_TYPES).optional(),
  // service_join only:
  device_id: z.string().uuid().optional(),
  requested_pubkey_fingerprint: z.string().optional(),
  self_challenge: z.string().optional(),
})
export type StartPairingInput = z.infer<typeof StartPairingInputSchema>

export const PairingTicketSchema = z.object({
  pairing_session_id: z.string().uuid(),
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
  device_id: z.string().uuid(),
  service_id: z.string().uuid(),
  service_key_id: z.string().uuid(),
  control_plane_url: z.string(),
})
export type ConsumePairingResult = z.infer<typeof ConsumePairingResultSchema>

export const ClaimDaemonInputSchema = z.object({
  remote_agent_machine_id: z.string().uuid(),
})
export type ClaimDaemonInput = z.infer<typeof ClaimDaemonInputSchema>

export const SetActiveDeviceCapabilitiesInputSchema = z.object({
  workspaceId: z.string().uuid(),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("workspace"), workspaceId: z.string().uuid() }),
    z.object({ kind: z.literal("actor"), actorId: z.string().uuid() }),
    z.object({
      kind: z.literal("conversation"),
      conversationId: z.string().uuid(),
    }),
    z.object({
      kind: z.literal("actor_in_conversation"),
      actorId: z.string().uuid(),
      conversationId: z.string().uuid(),
    }),
    z.object({
      kind: z.literal("remote_agent"),
      remoteAgentId: z.string().uuid(),
    }),
  ]),
  device_capability_ids: z.array(z.string().uuid()),
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
  device_id: z.string().uuid(),
  service_id: z.string().uuid(),
  service_kind: z.enum(DEVICE_SERVICE_KINDS),
  client_version: z.string(),
  signed_challenge: z.string(),
})
export type DeviceHelloParams = z.infer<typeof DeviceHelloParamsSchema>

export const DeviceCatalogToolSchema = z.object({
  stable_key: z.string(),
  name: z.string(),
  description: z.string(),
  input_schema: z.record(z.unknown()),
  annotations: z.record(z.unknown()).optional(),
})
export type DeviceCatalogTool = z.infer<typeof DeviceCatalogToolSchema>

export const DeviceCatalogExposureSchema = z.object({
  stable_key: z.string(),
  display_name: z.string(),
  description: z.string().optional(),
  transport: z.enum(DEVICE_EXPOSURE_TRANSPORTS),
  builtin_kind: z.enum(DEVICE_BUILTIN_KINDS).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
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
  runtime_session_id: z.string().uuid(),
  conversation_id: z.string().uuid().nullable(),
})

export const ServerRuntimeSessionCloseParamsSchema = z.object({
  runtime_session_id: z.string().uuid(),
})

export const ServerOperationCancelParamsSchema = z.object({
  operation_id: z.string().uuid(),
  reason: z.string().optional(),
})

export const ServerCuaTerminateParamsSchema = z.object({
  runtime_session_id: z.string().uuid(),
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
  RUNTIME_AUTHORIZATION_GRANT_SCOPES,
  RUNTIME_AUTHORIZATION_GRANT_STATUSES,
  RUNTIME_AUTHORIZATION_REQUEST_MODES,
  SERVER_FACADE_ERROR_CODES,
}
