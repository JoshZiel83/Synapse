// @synapse/device-protocol — enum constants shared between server, runtime, sdk.
// Mirrors §3, §5, §6, §11 of docs/device-runtime-v3.md.

export const HOST_KINDS = ["local", "cloud"] as const
export type HostKind = (typeof HOST_KINDS)[number]

// v3.0: only device_runtime + remote_agent_daemon. DeskAct is supervised by
// device_runtime as a child process, NOT a service. See §5.2.
export const DEVICE_SERVICE_KINDS = [
  "device_runtime",
  "remote_agent_daemon",
] as const
export type DeviceServiceKind = (typeof DEVICE_SERVICE_KINDS)[number]

export const DEVICE_SERVICE_STATUSES = [
  "starting",
  "online",
  "degraded",
  "offline",
] as const
export type DeviceServiceStatus = (typeof DEVICE_SERVICE_STATUSES)[number]

export const DEVICE_TRUST_STATUSES = ["pending", "trusted", "revoked"] as const
export type DeviceTrustStatus = (typeof DEVICE_TRUST_STATUSES)[number]

export const DEVICE_TYPES = [
  "desktop_computer",
  "laptop_computer",
  "mobile_phone",
  "tablet",
  "server",
  "virtual_machine",
  "cloud_sandbox",
  "custom",
] as const
export type DeviceType = (typeof DEVICE_TYPES)[number]

// device_exposures.transport — same as relay_exposures.transport plus stays
// stable across the rename.
export const DEVICE_EXPOSURE_TRANSPORTS = [
  "builtin",
  "stdio",
  "http",
  "sse",
  "custom",
] as const
export type DeviceExposureTransport =
  (typeof DEVICE_EXPOSURE_TRANSPORTS)[number]

// Built-in MCP server kinds. v3.0 set: filesystem, commandline, browser, cua.
// VFS is NOT a capability_kind — it's an internal projection on top of
// filesystem/browser/cua (§6 Notes).
export const DEVICE_BUILTIN_KINDS = [
  "filesystem",
  "commandline",
  "browser",
  "cua",
] as const
export type DeviceBuiltinKind = (typeof DEVICE_BUILTIN_KINDS)[number]

export const DEVICE_EXPOSURE_RUNTIME_STATUSES = [
  "discovered",
  "healthy",
  "degraded",
  "failed",
  "quarantined",
  "offline",
] as const
export type DeviceExposureRuntimeStatus =
  (typeof DEVICE_EXPOSURE_RUNTIME_STATUSES)[number]

// Sync sources (claude_code, etc.) — preserved from relay v2.
export const DEVICE_SYNC_SOURCE_KINDS = [
  "manual",
  "claude_code",
  "claude_desktop",
  "codex",
  "gemini",
  "opencode",
  "custom",
] as const
export type DeviceSyncSourceKind = (typeof DEVICE_SYNC_SOURCE_KINDS)[number]

export const DEVICE_SYNC_MODES = ["snapshot", "follow"] as const
export type DeviceSyncMode = (typeof DEVICE_SYNC_MODES)[number]

export const DEVICE_SYNC_STATUSES = [
  "unknown",
  "idle",
  "syncing",
  "error",
  "disabled",
] as const
export type DeviceSyncStatus = (typeof DEVICE_SYNC_STATUSES)[number]

// Control Plane session enums.
export const DEVICE_CONTROL_PLANE_SESSION_STATUSES = [
  "connecting",
  "active",
  "closing",
  "closed",
  "rejected",
] as const
export type DeviceControlPlaneSessionStatus =
  (typeof DEVICE_CONTROL_PLANE_SESSION_STATUSES)[number]

export const DEVICE_CONTROL_PLANE_TRANSPORTS = ["websocket"] as const
export type DeviceControlPlaneTransport =
  (typeof DEVICE_CONTROL_PLANE_TRANSPORTS)[number]

// Pairing modes — see §8 of the spec.
export const DEVICE_PAIRING_MODES = [
  "local_qr",
  "cloud_bootstrap",
  "service_join",
] as const
export type DevicePairingMode = (typeof DEVICE_PAIRING_MODES)[number]

export const DEVICE_PAIRING_STATUSES = [
  "pending",
  "confirmed",
  "consumed",
  "expired",
  "cancelled",
  "rejected",
] as const
export type DevicePairingStatus = (typeof DEVICE_PAIRING_STATUSES)[number]

// Runtime authorization grant. Scope set extended with actor_in_conversation
// in v3 (see §4.2); remote_agent added so bridged remote agents can hold
// device-capability grants in their own subject-scoped row.
export const RUNTIME_AUTHORIZATION_GRANT_SCOPES = [
  "once",
  "actor",
  "conversation",
  "actor_in_conversation",
  "remote_agent",
  "workspace",
] as const
export type RuntimeAuthorizationGrantScope =
  (typeof RUNTIME_AUTHORIZATION_GRANT_SCOPES)[number]

export const RUNTIME_AUTHORIZATION_GRANT_RETENTIONS = [
  "consume_once",
  "until_revoked",
] as const
export type RuntimeAuthorizationGrantRetention =
  (typeof RUNTIME_AUTHORIZATION_GRANT_RETENTIONS)[number]

export const RUNTIME_AUTHORIZATION_GRANT_STATUSES = [
  "active",
  "consumed",
  "revoked",
  "superseded",
] as const
export type RuntimeAuthorizationGrantStatus =
  (typeof RUNTIME_AUTHORIZATION_GRANT_STATUSES)[number]

// requestAuthorization mode — preserved from v2 relay-invoke-options.
export const RUNTIME_AUTHORIZATION_REQUEST_MODES = [
  "none",
  "background",
  "blocking",
] as const
export type RuntimeAuthorizationRequestMode =
  (typeof RUNTIME_AUTHORIZATION_REQUEST_MODES)[number]

// Capability kinds that fine-grained runtime authorization understands.
export const RUNTIME_AUTHORIZATION_CAPABILITIES = [
  "filesystem",
  "cua",
  "browser",
  "commandline",
] as const
export type RuntimeAuthorizationCapability =
  (typeof RUNTIME_AUTHORIZATION_CAPABILITIES)[number]

// Operation lifecycle statuses. awaiting_authorization is new in v3 (§6).
export const DEVICE_OPERATION_STATUSES = [
  "created",
  "dispatched",
  "awaiting_authorization",
  "received",
  "started",
  "output_streaming",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const
export type DeviceOperationStatus = (typeof DEVICE_OPERATION_STATUSES)[number]

export const DEVICE_OPERATION_TASK_MODES = ["sync", "async"] as const
export type DeviceOperationTaskMode =
  (typeof DEVICE_OPERATION_TASK_MODES)[number]

export const DEVICE_OPERATION_ATTEMPT_TRANSPORTS = [
  "mcp_http",
  "control_plane_task",
] as const
export type DeviceOperationAttemptTransport =
  (typeof DEVICE_OPERATION_ATTEMPT_TRANSPORTS)[number]

export const DEVICE_OPERATION_ATTEMPT_STATUSES = [
  "issued",
  "sent",
  "response_received",
  "acknowledged",
  "failed",
  "abandoned",
] as const
export type DeviceOperationAttemptStatus =
  (typeof DEVICE_OPERATION_ATTEMPT_STATUSES)[number]

// Principal kinds passed to capability-projection.projectToolsForPrincipal.
export const DEVICE_PRINCIPAL_KINDS = [
  "actor",
  "conversation",
  "actor_in_conversation",
  "remote_agent",
  "workspace_member",
] as const
export type DevicePrincipalKind = (typeof DEVICE_PRINCIPAL_KINDS)[number]

// §4.5 device-side error contract. runtime_authorization_requested is
// server-side-only and intentionally NOT in this list.
export const DEVICE_MCP_ERROR_CODES = [
  "tool_definition_changed",
  "permission_denied",
  "runtime_constraint",
  "invalid_request",
  "expired_envelope",
  "replay_detected",
] as const
export type DeviceMcpErrorCode = (typeof DEVICE_MCP_ERROR_CODES)[number]

// §4.5 server-side facade adds runtime_authorization_requested on top.
export const SERVER_FACADE_ERROR_CODES = [
  ...DEVICE_MCP_ERROR_CODES,
  "runtime_authorization_requested",
] as const
export type ServerFacadeErrorCode = (typeof SERVER_FACADE_ERROR_CODES)[number]
