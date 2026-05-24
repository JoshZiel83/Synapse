import type { CapabilityAccessTarget } from "@synapse/shared/types"

// relay-access.ts — DEPRECATED stubs (PR #17 of device-runtime v3).
//
// Relay capability access state queries return empty results; mutations are
// no-ops. The v3 replacement is the device_capability resource_type on
// resource_access_bindings, written via
// packages/api/src/modules/capability-projection/device-capabilities.ts
// (setActiveDeviceCapabilitiesForTarget).import type { CapabilityAccessTarget } from "@synapse/shared/types"

export interface RelayExposureAccessGrant {
  id: string
  capabilityId: string
  exposureId: string
  effectiveConversationTypeMask?: number | null
  target:
    | (CapabilityAccessTarget & { type: CapabilityAccessTarget["type"] })
    | { type: "workspace_member"; workspaceMemberId: string }
}

export interface RelayExposureAccessState {
  exposures: unknown[]
  grants: RelayExposureAccessGrant[]
}

export async function ensureRelayExposureDefaultAccess(_params: {
  workspaceId: string
  exposureId: string
}): Promise<void> {
  // no-op
}

export async function touchRelayExposureAccessState(_params: {
  workspaceId: string
  exposureId: string
}): Promise<void> {
  // no-op
}

export async function listRelayExposureAccessState(
  _workspaceId: string,
  _exposureId?: string | null
): Promise<RelayExposureAccessState> {
  return { exposures: [], grants: [] }
}

export async function grantRelayExposureAccess(_input: {
  workspaceId: string
  exposureId: string
  capabilityId?: string
  targets: unknown[]
}): Promise<{ granted: unknown[] }> {
  return { granted: [] }
}

export async function revokeRelayExposureAccess(_input: {
  workspaceId: string
  exposureId: string
  capabilityId?: string
  targets: unknown[]
}): Promise<{ revoked: unknown[] }> {
  return { revoked: [] }
}

export async function updateRelayExposurePolicy(_input: {
  workspaceId: string
  exposureId: string
  capabilityId?: string
  policy: unknown
}): Promise<{ ok: true }> {
  return { ok: true }
}

export async function updateRelayExposureAccessGrant(_input: {
  workspaceId: string
  capabilityId: string
  grantId: string
  patch: unknown
}): Promise<{ ok: true }> {
  return { ok: true }
}

export async function revokeRelayDeviceAccessState(_input: {
  workspaceId: string
  deviceId: string
}): Promise<{ revoked: number }> {
  return { revoked: 0 }
}
