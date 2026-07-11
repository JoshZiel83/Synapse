import assert from "node:assert/strict"
import { test } from "node:test"
import { bootstrapCloudDevice } from "./cloud-bootstrap.js"
import { pair, startPairingSession } from "./pairing.js"
import type {
  DeviceIdentityBroker,
  DeviceIdentityRecord,
  KeyPair,
} from "./types.js"

const DEVICE_ID = "00000000-0000-4000-8000-000000000001"
const SERVICE_ID = "00000000-0000-4000-8000-000000000002"
const SERVICE_KEY_ID = "00000000-0000-4000-8000-000000000003"
const PAIRING_SESSION_ID = "00000000-0000-4000-8000-000000000004"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function createBroker(): {
  broker: DeviceIdentityBroker
  saved: DeviceIdentityRecord[]
} {
  const saved: DeviceIdentityRecord[] = []
  const keyPair = (label: string): KeyPair => ({
    publicKey: `public-${label}`,
    privateKeyRef: `private-${label}`,
    publicKeyFingerprint: `fingerprint-${label}`,
  })
  return {
    saved,
    broker: {
      brokerFilePath: "/tmp/synapse-device-test.json",
      async loadDeviceIdentity() {
        return saved[0] ?? null
      },
      async saveDeviceIdentity(record) {
        saved.push(record)
      },
      async generateKeyPair(label) {
        return keyPair(label)
      },
      async loadKeyPair(label) {
        return keyPair(label)
      },
    },
  }
}

function installFetch(
  t: { after(fn: () => void): void },
  handler: typeof fetch
): void {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  globalThis.fetch = handler
}

test("bootstrapCloudDevice validates the bare wire result before saving identity", async (t) => {
  const { broker, saved } = createBroker()
  installFetch(t, async () =>
    jsonResponse({
      runtime_id: DEVICE_ID,
      service_id: SERVICE_ID,
      service_key_id: SERVICE_KEY_ID,
      control_plane_url: "wss://api.example.test/control",
    })
  )

  const result = await bootstrapCloudDevice({
    serverOrigin: "https://api.example.test",
    broker,
    bootstrapToken: "bootstrap-token",
    clientVersion: "test",
  })

  assert.deepEqual(result, {
    deviceId: DEVICE_ID,
    serviceId: SERVICE_ID,
    controlPlaneUrl: "wss://api.example.test/control",
  })
  assert.equal(saved.length, 1)
  assert.equal(saved[0]?.deviceId, DEVICE_ID)
})

test("bootstrapCloudDevice rejects malformed wire results without saving identity", async (t) => {
  const { broker, saved } = createBroker()
  installFetch(t, async () =>
    jsonResponse({
      runtime_id: DEVICE_ID,
      service_id: "not-a-uuid",
      service_key_id: SERVICE_KEY_ID,
      control_plane_url: "wss://api.example.test/control",
    })
  )

  await assert.rejects(
    bootstrapCloudDevice({
      serverOrigin: "https://api.example.test",
      broker,
      bootstrapToken: "bootstrap-token",
      clientVersion: "test",
    }),
    /bootstrap response shape invalid/
  )
  assert.equal(saved.length, 0)
})

test("pair validates the consumePairing wire result before saving identity", async (t) => {
  const { broker, saved } = createBroker()
  installFetch(t, async () =>
    jsonResponse({
      device_id: DEVICE_ID,
      service_id: SERVICE_ID,
      service_key_id: SERVICE_KEY_ID,
      control_plane_url: "wss://api.example.test/control",
    })
  )

  const result = await pair({
    mode: "local_qr",
    serverOrigin: "https://api.example.test",
    broker,
    pairingCode: "pairing-code",
    clientVersion: "test",
  })

  assert.equal(result.deviceId, DEVICE_ID)
  assert.equal(result.serviceId, SERVICE_ID)
  assert.equal(saved.length, 1)
})

test("pair rejects malformed consumePairing wire results without saving identity", async (t) => {
  const { broker, saved } = createBroker()
  installFetch(t, async () =>
    jsonResponse({
      device_id: DEVICE_ID,
      service_id: SERVICE_ID,
      service_key_id: SERVICE_KEY_ID,
      control_plane_url: 42,
    })
  )

  await assert.rejects(
    pair({
      mode: "local_qr",
      serverOrigin: "https://api.example.test",
      broker,
      pairingCode: "pairing-code",
      clientVersion: "test",
    }),
    /consumePairing response shape invalid/
  )
  assert.equal(saved.length, 0)
})

test("startPairingSession unwraps and validates the app data envelope", async (t) => {
  installFetch(t, async () =>
    jsonResponse({
      data: {
        pairingSessionId: PAIRING_SESSION_ID,
        mode: "local_qr",
        pairingCode: "123456",
        bootstrapToken: null,
        expiresAt: "2026-01-01T00:00:00.000Z",
        verificationUri: null,
        verificationUriComplete: null,
        status: "pending",
        oneClickCommands: null,
      },
    })
  )

  const ticket = await startPairingSession(
    "https://api.example.test",
    "00000000-0000-4000-8000-000000000005",
    { mode: "local_qr" },
    "auth-token"
  )

  assert.equal(ticket.pairingSessionId, PAIRING_SESSION_ID)
  assert.equal(ticket.pairingCode, "123456")
})

test("startPairingSession rejects a bare app view without the data envelope", async (t) => {
  installFetch(t, async () =>
    jsonResponse({
      pairingSessionId: PAIRING_SESSION_ID,
      mode: "local_qr",
      pairingCode: "123456",
      expiresAt: "2026-01-01T00:00:00.000Z",
      verificationUri: null,
      verificationUriComplete: null,
      status: "pending",
    })
  )

  await assert.rejects(
    startPairingSession(
      "https://api.example.test",
      "00000000-0000-4000-8000-000000000005",
      { mode: "local_qr" },
      "auth-token"
    ),
    /startPairing response shape invalid/
  )
})
