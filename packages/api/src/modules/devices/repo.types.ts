import type {
  DeviceBuiltinKind,
  DeviceExposureRuntimeStatus,
  DeviceExposureTransport,
  DeviceServiceKind,
  DeviceServiceStatus,
  DeviceTrustStatus,
  DeviceType,
  HostKind,
} from "@synapse/device-protocol/enums"

/**
 * Device record/projection shapes produced by the repo layer (camelCase
 * domain records with Date instants). The presenter turns these into the
 * app-facing camelCase views. Owned here (repo file) so the repo is the
 * structural authority for device read models, not the service.
 */

export interface DeviceSummaryRecord {
  id: string
  workspaceId: string
  title: string
  hostKind: HostKind
  hostProvider: string | null
  deviceType: DeviceType
  platform: string | null
  trustStatus: DeviceTrustStatus
  lastSeenAt: Date | null
  lastConnectedAt: Date | null
}

export interface DeviceServiceRecord {
  id: string
  deviceId: string
  serviceKind: DeviceServiceKind
  version: string | null
  status: DeviceServiceStatus
  lastSeenAt: Date | null
  remoteAgentMachineId: string | null
}

export interface DeviceCapabilityRecord {
  id: string
  workspaceId: string
  exposureId: string
  exposureStableKey: string
  displayName: string
  transport: DeviceExposureTransport
  builtinKind: DeviceBuiltinKind | null
  runtimeStatus: DeviceExposureRuntimeStatus
  metadata: Record<string, unknown> | null
}

export interface DeviceDetailRecord extends DeviceSummaryRecord {
  description: string | null
  ownerWorkspaceMemberId: string | null
  services: DeviceServiceRecord[]
  capabilities: DeviceCapabilityRecord[]
}
