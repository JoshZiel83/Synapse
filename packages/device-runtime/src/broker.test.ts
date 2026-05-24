import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFileBackedBroker } from "./broker.js"

test("file-backed broker round-trips identity + key pair", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synapse-device-broker-"))
  try {
    const broker = createFileBackedBroker({ brokerDir: dir })
    assert.equal(await broker.loadDeviceIdentity(), null)

    const deviceKey = await broker.generateKeyPair("device")
    assert.ok(deviceKey.publicKey.includes("BEGIN PUBLIC KEY"))
    assert.ok(deviceKey.publicKeyFingerprint.length === 64)

    await broker.saveDeviceIdentity({
      deviceId: "dev-1",
      serverOrigin: "http://localhost:3001",
      hostKind: "local",
      devicePubkeyFingerprint: deviceKey.publicKeyFingerprint,
      services: [
        {
          serviceKind: "device_runtime",
          serviceId: "svc-1",
          pubkeyFingerprint: deviceKey.publicKeyFingerprint,
        },
      ],
    })

    const loaded = await broker.loadDeviceIdentity()
    assert.ok(loaded)
    assert.equal(loaded!.deviceId, "dev-1")
    assert.equal(loaded!.services[0]!.serviceKind, "device_runtime")

    const reread = await broker.loadKeyPair(deviceKey.privateKeyRef)
    assert.ok(reread)
    assert.equal(reread!.publicKeyFingerprint, deviceKey.publicKeyFingerprint)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
