import type {
  RuntimeBuiltinKind,
  RuntimeExposureRuntimeStatus,
  RuntimeExposureTransport,
  RuntimePairingMode,
  RuntimePairingStatus,
  RuntimeServiceKind,
  RuntimeServiceStatus,
  DeviceTrustStatus,
  DeviceType,
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
  deviceType: DeviceType
  platform: string | null
  trustStatus: DeviceTrustStatus
  lastSeenAt: Date | null
  lastConnectedAt: Date | null
}

export interface RuntimeServiceRecord {
  id: string
  deviceId: string
  serviceKind: RuntimeServiceKind
  version: string | null
  status: RuntimeServiceStatus
  lastSeenAt: Date | null
  remoteAgentMachineId: string | null
}

export interface DeviceCapabilityRecord {
  id: string
  workspaceId: string
  exposureId: string
  exposureStableKey: string
  displayName: string
  transport: RuntimeExposureTransport
  builtinKind: RuntimeBuiltinKind | null
  runtimeStatus: RuntimeExposureRuntimeStatus
  metadata: Record<string, unknown> | null
}

export interface DeviceDetailRecord extends DeviceSummaryRecord {
  description: string | null
  ownerWorkspaceMemberId: string | null
  services: RuntimeServiceRecord[]
  capabilities: DeviceCapabilityRecord[]
}

/**
 * Pairing-ticket domain record produced by startPairing (camelCase, Date
 * instant). The presenter turns it into the app-facing RuntimePairingTicketView.
 * `oneClickCommands` carries dashboard-only install commands; `bootstrapToken`
 * is the app copy handed to web (the wire snake `bootstrap_token` is separate).
 */
export interface RuntimePairingTicketRecord {
  pairingSessionId: string
  mode: RuntimePairingMode
  pairingCode: string | null
  bootstrapToken: string | null
  expiresAt: Date
  verificationUri: string | null
  verificationUriComplete: string | null
  status: RuntimePairingStatus
  oneClickCommands: { unix: string; windows: string } | null
}
