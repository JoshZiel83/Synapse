// @synapse/device-sdk — consumer-side SDK (web / desktop / CLI) for the
// Synapse devices REST API. Headless: no React, no UI, no local capability
// execution. Mirrors docs/device-runtime-v3.md §10.3.

import {
  ConsumePairingInputSchema,
  type ConsumePairingInput,
  type ConsumePairingResult,
  type DeviceCapabilityAccessTarget,
} from "@synapse/device-protocol"
import {
  DeviceDetailViewSchema,
  DeviceListViewSchema,
  DevicePairingTicketViewSchema,
  DeviceServiceViewSchema,
  CreateCloudDeviceInputSchema,
  CreateCloudDeviceResultViewSchema,
  StartPairingInputSchema,
  ClaimDaemonServiceInputSchema,
  SetActiveDeviceCapabilitiesInputSchema,
  type DeviceDetailView,
  type DeviceListView,
  type DevicePairingTicketView,
  type DeviceServiceView,
  type DeviceView,
  type CreateCloudDeviceInput,
  type CreateCloudDeviceResultView,
  type ClaimDaemonServiceInput,
  type SetActiveDeviceCapabilitiesInput,
  type StartPairingInput,
} from "@synapse/shared/schemas"

/**
 * AccessTarget — re-export of the narrow wire type
 * `DeviceCapabilityAccessTarget` from @synapse/device-protocol. SDK callers
 * see the device-specific shape (no workspace_member, no scope=workspace etc.;
 * see ScopedSubjectTargetWireSchema superRefine in
 * packages/device-protocol/src/schemas.ts).
 */
export type AccessTarget = DeviceCapabilityAccessTarget

// subject-scope-refactor: DevicePrincipal SDK-local type removed at cutover.
// The server-internal `DevicePrincipal` union was renamed/collapsed: the
// scoped-actor case ('actor_in_conversation') is now expressed as
// (principal.kind='actor', activeConversationSubjectId set) inside
// RuntimePrincipalContext. SDK consumers that need to identify a principal at
// the API boundary should use the underlying SubjectRef from @synapse/shared.

export interface DeviceSdkOptions {
  baseUrl: string
  /** Bearer token or session cookie loader; SDK calls fetch() with it. */
  authToken?: string
  /** Optional fetch impl (test override). */
  fetchImpl?: typeof fetch
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`
}

export class DeviceSdk {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly opts: DeviceSdkOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
    }
    if (body !== undefined) headers["content-type"] = "application/json"
    if (this.opts.authToken)
      headers["authorization"] = `Bearer ${this.opts.authToken}`
    const res = await this.fetchImpl(joinUrl(this.opts.baseUrl, path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`${method} ${path} failed: ${res.status} ${text}`)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  // ───────────────────────────── lifecycle ───────────────────────────────────

  async listDevices(workspaceId: string): Promise<DeviceListView> {
    const result = await this.request<{ data: unknown[] }>(
      "GET",
      `/api/v1/workspaces/${workspaceId}/devices`
    )
    return DeviceListViewSchema.parse(result.data)
  }

  async getDevice(
    workspaceId: string,
    deviceId: string
  ): Promise<DeviceDetailView> {
    const res = await this.request<{ data: unknown }>(
      "GET",
      `/api/v1/workspaces/${workspaceId}/devices/${deviceId}`
    )
    return DeviceDetailViewSchema.parse(res.data)
  }

  async deleteDevice(workspaceId: string, deviceId: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/api/v1/workspaces/${workspaceId}/devices/${deviceId}`
    )
  }

  // PR #12: createCloudDevice + bootstrap flow.
  //
  // The API does NOT immediately return a DeviceDetail — it returns the
  // pending pairing session info (pending_device_id, one-time
  // bootstrap_token, expires_at). The caller injects the token into the
  // sandbox env; the runtime inside the sandbox then calls
  // /api/v1/devices/bootstrap to claim the actual device row. Polling for
  // the materialized device happens via listDevices once the sandbox is up.
  async createCloudDevice(
    input: CreateCloudDeviceInput
  ): Promise<CreateCloudDeviceResultView> {
    const parsed = CreateCloudDeviceInputSchema.parse(input)
    // workspaceId travels in the URL; the body carries only the app fields
    // (title/preset/hostProvider). The API route validates the body with
    // CreateCloudDeviceInputSchema.omit({ workspaceId }) (a strictObject), so
    // sending workspaceId in the body would be rejected as an unknown key.
    const { workspaceId, ...body } = parsed
    const res = await this.request<{ data: unknown }>(
      "POST",
      `/api/v1/workspaces/${workspaceId}/devices/cloud`,
      body
    )
    return CreateCloudDeviceResultViewSchema.parse(res.data)
  }

  // ───────────────────────────── pairing ─────────────────────────────────────

  async startPairing(
    input: StartPairingInput
  ): Promise<DevicePairingTicketView> {
    const parsed = StartPairingInputSchema.parse(input)
    const res = await this.request<{ data: unknown }>(
      "POST",
      `/api/v1/workspaces/${parsed.workspaceId}/devices/pairing-sessions`,
      {
        mode: parsed.mode,
        title: parsed.title,
        description: parsed.description,
        deviceType: parsed.deviceType,
        context: parsed.context,
        deviceId: parsed.deviceId,
        requestedPubkeyFingerprint: parsed.requestedPubkeyFingerprint,
        selfChallenge: parsed.selfChallenge,
      }
    )
    return DevicePairingTicketViewSchema.parse(res.data)
  }

  // Used by the Device Runtime (not the chat client), but exposed here so
  // CLI tooling and integration tests can drive the consume step without
  // duplicating fetch boilerplate.
  async consumePairing(
    input: ConsumePairingInput
  ): Promise<ConsumePairingResult> {
    const parsed = ConsumePairingInputSchema.parse(input)
    return this.request<ConsumePairingResult>(
      "POST",
      "/api/v1/devices/pairing-sessions/consume",
      parsed
    )
  }

  // ───────────────────────────── daemon claim (§5.4) ─────────────────────────

  async claimRemoteAgentDaemon(
    workspaceId: string,
    deviceId: string,
    input: { remoteAgentMachineId: string }
  ): Promise<DeviceServiceView> {
    const parsed = ClaimDaemonServiceInputSchema.parse({
      serviceKind: "remote_agent_daemon",
      remoteAgentMachineId: input.remoteAgentMachineId,
    })
    const res = await this.request<{ data: unknown }>(
      "POST",
      `/api/v1/workspaces/${workspaceId}/devices/${deviceId}/services`,
      {
        serviceKind: parsed.serviceKind,
        remoteAgentMachineId: parsed.remoteAgentMachineId,
      }
    )
    return DeviceServiceViewSchema.parse(res.data)
  }

  async detachService(
    workspaceId: string,
    deviceId: string,
    serviceId: string
  ): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/api/v1/workspaces/${workspaceId}/devices/${deviceId}/services/${serviceId}`
    )
  }

  // ───────────────────────────── layer-1 access ──────────────────────────────

  /**
   * Single canonical write for "switch active device" UX. PR #7 (1:1) and
   * PR #8 (group-chat actor-hover) both call this with the right
   * AccessTarget kind. The server validates that:
   *   - the caller has workspace.manage_devices on the workspace
   *   - the caller has device_capability.grant on every listed capability
   *   - the AccessTarget's target row (actor / conversation / context)
   *     belongs to the same workspace
   *   - every listed capability belongs to the same workspace
   */
  async setActiveDeviceCapabilitiesForTarget(
    input: SetActiveDeviceCapabilitiesInput
  ): Promise<void> {
    const parsed = SetActiveDeviceCapabilitiesInputSchema.parse(input)
    await this.request<void>(
      "POST",
      `/api/v1/workspaces/${parsed.workspaceId}/devices/access-bindings`,
      parsed
    )
  }
}

// Re-export the contract types so consumers depend on @synapse/device-sdk only.
// Device read/management views AND app-facing write inputs are camelCase (from
// @synapse/shared); only the true wire/handshake types (consume) stay
// snake_case (from @synapse/device-protocol).
export type {
  DeviceView,
  DeviceListView,
  DeviceDetailView,
  DeviceServiceView,
  DevicePairingTicketView,
  CreateCloudDeviceInput,
  CreateCloudDeviceResultView,
  ClaimDaemonServiceInput,
  SetActiveDeviceCapabilitiesInput,
  StartPairingInput,
}
export type { ConsumePairingInput, ConsumePairingResult }
