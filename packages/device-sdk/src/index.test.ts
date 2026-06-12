// device-sdk boundary tests — lock the app-facing camelCase contract.
//
// The management methods (listDevices / getDevice / createCloudDevice /
// startPairing / claimRemoteAgentDaemon / setActiveDeviceCapabilitiesForTarget)
// are app-facing: they SEND camelCase bodies and PARSE the shared camelCase
// view schemas (@synapse/shared). Only the true handshake wire method
// (consumePairing) keeps the device-protocol snake_case shape. These tests pin
// both halves so the boundary cannot silently regress (round-2 review #7: the
// SDK had zero tests covering the new shared-contract boundary).

import test from "node:test"
import assert from "node:assert/strict"
import { DeviceSdk } from "./index.js"

const wsId = "00000000-0000-4000-8000-000000000001"
const deviceId = "00000000-0000-4000-8000-000000000002"
const capId = "00000000-0000-4000-8000-000000000003"
const machineId = "00000000-0000-4000-8000-000000000004"
const serviceId = "00000000-0000-4000-8000-000000000005"
const exposureId = "00000000-0000-4000-8000-000000000006"

interface CapturedRequest {
  url: string
  method: string
  body: unknown
}

/**
 * Build a DeviceSdk whose fetch records every request and replies with the
 * caller-provided JSON body (status 200) — or 204 when `responseBody` is null.
 */
function makeSdk(responseBody: unknown, status = 200) {
  const captured: CapturedRequest[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    captured.push({
      url: String(url),
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body as string) : undefined,
    })
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return responseBody
      },
      async text() {
        return ""
      },
    } as unknown as Response
  }) as unknown as typeof fetch
  const sdk = new DeviceSdk({
    baseUrl: "https://api.test",
    authToken: "tok",
    fetchImpl,
  })
  return { sdk, captured }
}

const deviceViewJson = {
  id: deviceId,
  workspaceId: wsId,
  title: "Box",
  hostKind: "local",
  hostProvider: null,
  deviceType: "desktop_computer",
  platform: null,
  trustStatus: "trusted",
  lastSeenAt: null,
  lastConnectedAt: null,
}

const deviceServiceViewJson = {
  id: serviceId,
  deviceId,
  serviceKind: "remote_agent_daemon",
  version: null,
  status: "online",
  lastSeenAt: null,
  remoteAgentMachineId: machineId,
}

test("listDevices parses the camelCase DeviceView array (app contract)", async () => {
  const { sdk, captured } = makeSdk({ data: [deviceViewJson] })
  const devices = await sdk.listDevices(wsId)
  assert.equal(devices.length, 1)
  assert.equal(devices[0]?.workspaceId, wsId)
  assert.equal(devices[0]?.hostKind, "local")
  assert.equal(captured[0]?.method, "GET")
  assert.match(captured[0]?.url ?? "", /\/workspaces\/.*\/devices$/)
})

test("getDevice parses the camelCase DeviceDetailView", async () => {
  const { sdk } = makeSdk({
    data: {
      ...deviceViewJson,
      description: null,
      ownerWorkspaceMemberId: null,
      services: [deviceServiceViewJson],
      capabilities: [
        {
          id: capId,
          workspaceId: wsId,
          exposureId,
          exposureStableKey: "fs.read",
          displayName: "Filesystem",
          transport: "stdio",
          builtinKind: null,
          runtimeStatus: "healthy",
          metadata: null,
        },
      ],
    },
  })
  const detail = await sdk.getDevice(wsId, deviceId)
  assert.equal(detail.services[0]?.remoteAgentMachineId, machineId)
  assert.equal(detail.capabilities[0]?.exposureStableKey, "fs.read")
})

test("createCloudDevice SENDS camelCase body + PARSES camelCase result view", async () => {
  const { sdk, captured } = makeSdk({
    data: {
      pendingDeviceId: deviceId,
      bootstrapToken: "btok",
      pairingSessionId: "11111111-0000-4000-8000-000000000001",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  })
  const result = await sdk.createCloudDevice({
    workspaceId: wsId,
    title: "Cloud",
    hostProvider: "e2b",
  })
  // workspaceId travels in the URL, NOT the body (the API body schema is a
  // strictObject that omits workspaceId and rejects unknown keys).
  assert.match(
    captured[0]?.url ?? "",
    new RegExp(`/workspaces/${wsId}/devices/cloud$`)
  )
  const body = captured[0]?.body as Record<string, unknown>
  assert.ok(!("workspaceId" in body), "workspaceId must NOT be in the body")
  assert.equal(body.title, "Cloud")
  assert.equal(body.hostProvider, "e2b")
  assert.ok(!("workspace_id" in body), "must not send snake workspace_id")
  assert.ok(!("host_provider" in body), "must not send snake host_provider")
  // parses camelCase result
  assert.equal(result.bootstrapToken, "btok")
  assert.equal(result.pendingDeviceId, deviceId)
})

test("startPairing SENDS camelCase body + PARSES the camelCase ticket view", async () => {
  const { sdk, captured } = makeSdk({
    data: {
      pairingSessionId: "11111111-0000-4000-8000-000000000002",
      mode: "service_join",
      pairingCode: "abc",
      bootstrapToken: null,
      expiresAt: "2099-01-01T00:00:00.000Z",
      verificationUri: null,
      verificationUriComplete: null,
      status: "pending",
      oneClickCommands: null,
    },
  })
  const ticket = await sdk.startPairing({
    workspaceId: wsId,
    mode: "service_join",
    deviceType: "desktop_computer",
    deviceId,
  })
  const body = captured[0]?.body as Record<string, unknown>
  assert.equal(body.deviceType, "desktop_computer")
  assert.equal(body.deviceId, deviceId)
  assert.ok(!("device_type" in body), "must not send snake device_type")
  assert.ok(!("device_id" in body), "must not send snake device_id")
  assert.equal(ticket.pairingCode, "abc")
})

test("claimRemoteAgentDaemon SENDS camelCase body + PARSES the service view", async () => {
  const { sdk, captured } = makeSdk({ data: deviceServiceViewJson })
  const service = await sdk.claimRemoteAgentDaemon(wsId, deviceId, {
    remoteAgentMachineId: machineId,
  })
  const body = captured[0]?.body as Record<string, unknown>
  assert.equal(body.serviceKind, "remote_agent_daemon")
  assert.equal(body.remoteAgentMachineId, machineId)
  assert.ok(!("service_kind" in body), "must not send snake service_kind")
  assert.ok(
    !("remote_agent_machine_id" in body),
    "must not send snake remote_agent_machine_id"
  )
  assert.equal(service.serviceKind, "remote_agent_daemon")
})

test("setActiveDeviceCapabilitiesForTarget SENDS camelCase deviceCapabilityIds", async () => {
  const { sdk, captured } = makeSdk(null, 204)
  await sdk.setActiveDeviceCapabilitiesForTarget({
    workspaceId: wsId,
    target: { subject: { kind: "workspace", workspaceId: wsId } },
    deviceCapabilityIds: [capId],
  })
  const body = captured[0]?.body as Record<string, unknown>
  assert.deepEqual(body.deviceCapabilityIds, [capId])
  assert.ok(
    !("device_capability_ids" in body),
    "must not send snake device_capability_ids"
  )
})

test("consumePairing keeps the snake_case wire shape (device-protocol handshake)", async () => {
  const { sdk, captured } = makeSdk({
    device_id: deviceId,
    service_id: serviceId,
    service_key_id: "22222222-0000-4000-8000-000000000001",
    control_plane_url: "wss://cp.test",
  })
  const result = await sdk.consumePairing({
    pairing_code: "code",
    device_pubkey: "dpk",
    service_pubkey: "spk",
    service_kind: "device_runtime",
  })
  // wire body stays snake_case
  const body = captured[0]?.body as Record<string, unknown>
  assert.equal(body.pairing_code, "code")
  assert.equal(body.device_pubkey, "dpk")
  // wire result stays snake_case
  assert.equal(result.device_id, deviceId)
  assert.equal(result.control_plane_url, "wss://cp.test")
})

test("invalid response shape is rejected by the view schema parse", async () => {
  // server returns a snake_case device (regression: the contract is camelCase)
  const { sdk } = makeSdk({
    data: [{ ...deviceViewJson, workspaceId: undefined, workspace_id: wsId }],
  })
  await assert.rejects(
    () => sdk.listDevices(wsId),
    "snake_case device payload must fail the camelCase DeviceView parse"
  )
})
