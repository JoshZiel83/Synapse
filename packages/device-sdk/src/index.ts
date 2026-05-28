// @synapse/device-sdk — consumer-side SDK (web / desktop / CLI) for the
// Synapse devices REST API. Headless: no React, no UI, no local capability
// execution. Mirrors docs/device-runtime-v3.md §10.3.

import {
  ClaimDaemonInputSchema,
  ConsumePairingInputSchema,
  CreateCloudDeviceInputSchema,
  CreateCloudDeviceResultSchema,
  DeviceDetailSchema,
  DeviceServiceSummarySchema,
  DeviceSummarySchema,
  PairingTicketSchema,
  SetActiveDeviceCapabilitiesInputSchema,
  StartPairingInputSchema,
  type ClaimDaemonInput,
  type ConsumePairingInput,
  type ConsumePairingResult,
  type CreateCloudDeviceInput,
  type CreateCloudDeviceResult,
  type DeviceDetail,
  type DeviceServiceSummary,
  type DeviceSummary,
  type PairingTicket,
  type SetActiveDeviceCapabilitiesInput,
  type StartPairingInput,
} from "@synapse/device-protocol"

/**
 * AccessTarget — DTO at the SDK boundary describing who a grant attaches to.
 * Server resolves to an access_subjects row via upsertAccessSubject; SDK
 * callers never construct conversation_actor_context UUIDs themselves.
 */
export type AccessTarget =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "actor"; actorId: string }
  | { kind: "conversation"; conversationId: string }
  | {
      kind: "actor_in_conversation"
      actorId: string
      conversationId: string
    }
  | { kind: "remote_agent"; remoteAgentId: string }

/** DevicePrincipal — server-internal type, but useful in SDK consumers that
 * call projection-style debug endpoints (future PR). */
export type DevicePrincipal =
  | { kind: "actor"; actorId: string; conversationId?: string }
  | { kind: "conversation"; conversationId: string }
  | {
      kind: "actor_in_conversation"
      conversationActorContextId: string
      actorId: string
      conversationId: string
    }
  | { kind: "remote_agent"; remoteAgentId: string; conversationId: string }
  | { kind: "workspace_member"; workspaceId: string; workspaceMemberId: string }

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

  async listDevices(workspaceId: string): Promise<DeviceSummary[]> {
    const result = await this.request<{ devices: unknown[] }>(
      "GET",
      `/api/v1/workspaces/${workspaceId}/devices`
    )
    return result.devices.map((d) => DeviceSummarySchema.parse(d))
  }

  async getDevice(
    workspaceId: string,
    deviceId: string
  ): Promise<DeviceDetail> {
    const raw = await this.request<unknown>(
      "GET",
      `/api/v1/workspaces/${workspaceId}/devices/${deviceId}`
    )
    return DeviceDetailSchema.parse(raw)
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
  ): Promise<CreateCloudDeviceResult> {
    const parsed = CreateCloudDeviceInputSchema.parse(input)
    const raw = await this.request<unknown>(
      "POST",
      `/api/v1/workspaces/${parsed.workspace_id}/devices/cloud`,
      parsed
    )
    return CreateCloudDeviceResultSchema.parse(raw)
  }

  // ───────────────────────────── pairing ─────────────────────────────────────

  async startPairing(input: StartPairingInput): Promise<PairingTicket> {
    const parsed = StartPairingInputSchema.parse(input)
    const raw = await this.request<unknown>(
      "POST",
      `/api/v1/workspaces/${parsed.workspace_id}/devices/pairing-sessions`,
      {
        mode: parsed.mode,
        title: parsed.title,
        device_type: parsed.device_type,
        device_id: parsed.device_id,
        requested_pubkey_fingerprint: parsed.requested_pubkey_fingerprint,
        self_challenge: parsed.self_challenge,
      }
    )
    return PairingTicketSchema.parse(raw)
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
    input: ClaimDaemonInput
  ): Promise<DeviceServiceSummary> {
    const parsed = ClaimDaemonInputSchema.parse(input)
    const raw = await this.request<unknown>(
      "POST",
      `/api/v1/workspaces/${workspaceId}/devices/${deviceId}/services`,
      {
        service_kind: "remote_agent_daemon",
        remote_agent_machine_id: parsed.remote_agent_machine_id,
      }
    )
    return DeviceServiceSummarySchema.parse(raw)
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

// Re-export protocol types so consumers depend on @synapse/device-sdk only.
export type {
  DeviceSummary,
  DeviceDetail,
  DeviceServiceSummary,
  PairingTicket,
  ConsumePairingInput,
  ConsumePairingResult,
  CreateCloudDeviceInput,
  CreateCloudDeviceResult,
  ClaimDaemonInput,
  SetActiveDeviceCapabilitiesInput,
  StartPairingInput,
}
