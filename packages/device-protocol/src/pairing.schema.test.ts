// Lock the device pairing / cloud bootstrap WIRE contracts (snake_case). These
// schemas are the single source of truth for the runtime client, the SDK, and
// the API route parsers (round-6 P1-4: the field set used to be split across
// the API controller's local body schema and an inline cast in the bootstrap
// route). If a field is added/removed on one end the parse must change here.

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  ConsumePairingInputSchema,
  ConsumePairingResultSchema,
  CloudBootstrapInputSchema,
  CloudBootstrapResultSchema,
} from "./schemas.js"

const DEVICE_ID = "00000000-0000-4000-8000-000000000001"
const SERVICE_ID = "00000000-0000-4000-8000-000000000002"
const SERVICE_KEY_ID = "00000000-0000-4000-8000-000000000003"

test("ConsumePairingInputSchema accepts the full local_qr handshake body", () => {
  const parsed = ConsumePairingInputSchema.parse({
    pairing_code: "abc123",
    device_pubkey: "dpk",
    service_pubkey: "spk",
    title: "My Laptop",
    device_type: "desktop_computer",
    platform: "darwin",
    arch: "arm64",
    client_version: "1.2.3",
  })
  // service_kind defaults to device_runtime
  assert.equal(parsed.service_kind, "device_runtime")
  assert.equal(parsed.title, "My Laptop")
  assert.equal(parsed.device_type, "desktop_computer")
  assert.equal(parsed.platform, "darwin")
  assert.equal(parsed.arch, "arm64")
})

test("ConsumePairingInputSchema keeps title/device_type/platform/arch optional", () => {
  // Minimal handshake (no self-describing facts) still parses.
  const parsed = ConsumePairingInputSchema.parse({
    pairing_code: "abc123",
    device_pubkey: "dpk",
    service_pubkey: "spk",
  })
  assert.equal(parsed.title, undefined)
  assert.equal(parsed.device_type, undefined)
})

test("ConsumePairingInputSchema rejects an unknown device_type", () => {
  assert.throws(() =>
    ConsumePairingInputSchema.parse({
      pairing_code: "abc",
      device_pubkey: "dpk",
      service_pubkey: "spk",
      device_type: "toaster",
    })
  )
})

test("ConsumePairingInputSchema accepts an explicit service_kind=device_runtime", () => {
  const parsed = ConsumePairingInputSchema.parse({
    pairing_code: "abc123",
    device_pubkey: "dpk",
    service_pubkey: "spk",
    service_kind: "device_runtime",
  })
  assert.equal(parsed.service_kind, "device_runtime")
})

test("ConsumePairingInputSchema rejects a non-device_runtime service_kind at parse", () => {
  // R3.P2e-pairing: only device_runtime is pairable; the WIRE contract now
  // rejects every other kind (the api service-level reject stays as defense).
  for (const service_kind of ["bare_dataplane", "remote_agent_daemon"]) {
    assert.throws(
      () =>
        ConsumePairingInputSchema.parse({
          pairing_code: "abc123",
          device_pubkey: "dpk",
          service_pubkey: "spk",
          service_kind,
        }),
      `service_kind=${service_kind} must not parse`
    )
  }
})

test("ConsumePairingResultSchema validates the handshake result", () => {
  const parsed = ConsumePairingResultSchema.parse({
    device_id: DEVICE_ID,
    service_id: SERVICE_ID,
    service_key_id: SERVICE_KEY_ID,
    control_plane_url: "wss://cp.test/control-plane",
  })
  assert.equal(parsed.device_id, DEVICE_ID)
})

test("CloudBootstrapInputSchema accepts the sandbox bootstrap body", () => {
  const parsed = CloudBootstrapInputSchema.parse({
    bootstrap_token: "tok",
    device_pubkey: "dpk",
    service_pubkey: "spk",
    client_version: "1.0.0",
    platform: "linux",
    arch: "x64",
  })
  assert.equal(parsed.platform, "linux")
})

test("CloudBootstrapInputSchema requires the credential triple", () => {
  assert.throws(() =>
    CloudBootstrapInputSchema.parse({
      device_pubkey: "dpk",
      service_pubkey: "spk",
    })
  )
})

test("CloudBootstrapInputSchema requires platform + arch (fail-closed, no default)", () => {
  // R3.P2d-wire: sandboxes.platform/arch are NOT NULL; the wire no longer
  // defaults them. A body missing platform/arch (or with empty strings) fails.
  assert.throws(
    () =>
      CloudBootstrapInputSchema.parse({
        bootstrap_token: "tok",
        device_pubkey: "dpk",
        service_pubkey: "spk",
      }),
    "missing platform/arch must not parse"
  )
  assert.throws(
    () =>
      CloudBootstrapInputSchema.parse({
        bootstrap_token: "tok",
        device_pubkey: "dpk",
        service_pubkey: "spk",
        platform: "",
        arch: "",
      }),
    "empty platform/arch must not parse"
  )
})

test("CloudBootstrapResultSchema validates the bootstrap result", () => {
  const parsed = CloudBootstrapResultSchema.parse({
    runtime_id: DEVICE_ID,
    service_id: SERVICE_ID,
    service_key_id: SERVICE_KEY_ID,
    control_plane_url: "wss://cp.test/control-plane",
  })
  assert.equal(parsed.service_key_id, SERVICE_KEY_ID)
})
