// Device dashboard view types — minimal shape used by /dashboard/devices
// pages. Mirrors the device-protocol DTOs but kept local so packages/web-next
// can avoid a hard dep on @synapse/device-protocol in the v3.0 skeleton.
import type { Timestamp } from "@synapse/shared/types"

export interface DeviceSummaryView {
  id: string
  workspace_id: string
  title: string
  host_kind: "local" | "cloud"
  host_provider: string | null
  device_type: string
  platform: string | null
  trust_status: "pending" | "trusted" | "revoked"
  last_seen_at: Timestamp | null
  last_connected_at: Timestamp | null
}

export interface DeviceServiceSummaryView {
  id: string
  device_id: string
  service_kind: "device_runtime" | "remote_agent_daemon"
  version: string | null
  status: "starting" | "online" | "degraded" | "offline"
  last_seen_at: Timestamp | null
  remote_agent_machine_id: string | null
}

export interface DeviceCapabilitySummaryView {
  id: string
  workspace_id: string
  exposure_id: string
  /**
   * v3.1: e.g. "builtin/browser/navigation". Used by the Settings →
   * Runtime Authorizations page to scope the operation chip list to
   * operations the selected exposure can actually request.
   */
  exposure_stable_key: string
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
  expires_at: Timestamp
  verification_uri: string | null
  verification_uri_complete: string | null
  status:
    | "pending"
    | "confirmed"
    | "consumed"
    | "expired"
    | "cancelled"
    | "rejected"
  one_click_commands?: { unix: string; windows: string } | null
}
