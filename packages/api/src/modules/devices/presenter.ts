import type {
  DeviceCapabilityView,
  DeviceDetailView,
  DevicePairingTicketView,
  DeviceServiceView,
  DeviceView,
} from "@synapse/shared"
import { serializeOptionalInstant } from "../../infrastructure/datetime.js"
import { serializeInstant } from "../../infrastructure/datetime.js"
import type {
  DeviceCapabilityRecord,
  DeviceDetailRecord,
  DevicePairingTicketRecord,
  DeviceServiceRecord,
  DeviceSummaryRecord,
} from "./repo.types.js"

/**
 * Device presentation layer: DB records → app-facing camelCase views (master
 * plan §2.3-6). Owns Date→IsoInstantString. The signed wire shapes
 * (pairing/bootstrap/control-plane) live in @synapse/device-protocol and are
 * NOT built here.
 */

export function presentDevice(record: DeviceSummaryRecord): DeviceView {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    title: record.title,
    deviceType: record.deviceType,
    platform: record.platform,
    trustStatus: record.trustStatus,
    lastSeenAt: serializeOptionalInstant(record.lastSeenAt) ?? null,
    lastConnectedAt: serializeOptionalInstant(record.lastConnectedAt) ?? null,
  }
}

export function presentDeviceService(
  record: DeviceServiceRecord
): DeviceServiceView {
  return {
    id: record.id,
    deviceId: record.deviceId,
    serviceKind: record.serviceKind,
    version: record.version ?? null,
    status: record.status,
    lastSeenAt: serializeOptionalInstant(record.lastSeenAt) ?? null,
    remoteAgentMachineId: record.remoteAgentMachineId ?? null,
  }
}

export function presentDeviceCapability(
  record: DeviceCapabilityRecord
): DeviceCapabilityView {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    exposureId: record.exposureId,
    exposureStableKey: record.exposureStableKey,
    displayName: record.displayName,
    transport: record.transport,
    builtinKind: record.builtinKind ?? null,
    runtimeStatus: record.runtimeStatus,
    metadata: record.metadata ?? null,
  }
}

export function presentDeviceDetail(
  record: DeviceDetailRecord
): DeviceDetailView {
  return {
    ...presentDevice(record),
    description: record.description ?? null,
    ownerWorkspaceMemberId: record.ownerWorkspaceMemberId ?? null,
    services: record.services.map(presentDeviceService),
    capabilities: record.capabilities.map(presentDeviceCapability),
  }
}

export function presentDevicePairingTicket(
  record: DevicePairingTicketRecord
): DevicePairingTicketView {
  return {
    pairingSessionId: record.pairingSessionId,
    mode: record.mode,
    pairingCode: record.pairingCode,
    bootstrapToken: record.bootstrapToken,
    expiresAt: serializeInstant(record.expiresAt),
    verificationUri: record.verificationUri,
    verificationUriComplete: record.verificationUriComplete,
    status: record.status,
    oneClickCommands: record.oneClickCommands,
  }
}
