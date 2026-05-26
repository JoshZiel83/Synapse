// Device dashboard view types — minimal shape used by /dashboard/devices
// pages. Mirrors the device-protocol DTOs but kept local so packages/web-next
// can avoid a hard dep on @synapse/device-protocol in the v3.0 skeleton.

export interface DeviceSummaryView {
  id: string
  workspace_id: string
  title: string
  host_kind: "local" | "cloud"
  host_provider: string | null
  device_type: string
  platform: string | null
  trust_status: "pending" | "trusted" | "revoked"
  last_seen_at: string | null
  last_connected_at: string | null
}

export interface DeviceServiceSummaryView {
  id: string
  device_id: string
  service_kind: "device_runtime" | "remote_agent_daemon"
  version: string | null
  status: "starting" | "online" | "degraded" | "offline"
  last_seen_at: string | null
  remote_agent_machine_id: string | null
}

export interface DeviceCapabilitySummaryView {
  id: string
  workspace_id: string
  exposure_id: string
  display_name: string
  transport: "builtin" | "stdio" | "http" | "sse" | "custom"
  builtin_kind: "filesystem" | "commandline" | "browser" | "cua" | null
  runtime_status:
    | "discovered"
    | "healthy"
    | "degraded"
    | "failed"
    | "quarantined"
    | "offline"
  /**
   * v3.1: exposure-level metadata pass-through. chrome-devtools-mcp provider
   * publishes `{enabled: boolean, disabledReason?: string, schemaVersion: string}`
   * so the dashboard can render disabled / "Coming soon" rows.
   */
  metadata?: Record<string, unknown> | null
}

export interface DeviceDetailView extends DeviceSummaryView {
  description: string | null
  owner_workspace_member_id: string | null
  services: DeviceServiceSummaryView[]
  capabilities: DeviceCapabilitySummaryView[]
}

export interface DevicePairingTicketView {
  pairing_session_id: string
  mode: "local_qr" | "cloud_bootstrap" | "service_join"
  pairing_code: string | null
  bootstrap_token?: string | null
  expires_at: string
  verification_uri: string | null
  verification_uri_complete: string | null
  status:
    | "pending"
    | "confirmed"
    | "consumed"
    | "expired"
    | "cancelled"
    | "rejected"
}
