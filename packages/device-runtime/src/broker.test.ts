import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createFileBackedBroker,
  readPrivateKeyPemFromKeystoreFile,
} from "./broker.js"

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
      devicePrivateKeyRef: deviceKey.privateKeyRef,
      services: [
        {
          serviceKind: "device_runtime",
          serviceId: "svc-1",
          pubkeyFingerprint: deviceKey.publicKeyFingerprint,
          privateKeyRef: deviceKey.privateKeyRef,
        },
      ],
    })

    const loaded = await broker.loadDeviceIdentity()
    assert.ok(loaded)
    assert.equal(loaded!.deviceId, "dev-1")
    assert.equal(loaded!.services[0]!.serviceKind, "device_runtime")
    assert.equal(loaded!.services[0]!.privateKeyRef, deviceKey.privateKeyRef)
    assert.equal(loaded!.devicePrivateKeyRef, deviceKey.privateKeyRef)

    const reread = await broker.loadKeyPair(deviceKey.privateKeyRef)
    assert.ok(reread)
    assert.equal(reread!.publicKeyFingerprint, deviceKey.publicKeyFingerprint)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("file-backed broker rejects malformed identity state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synapse-device-broker-"))
  try {
    const broker = createFileBackedBroker({ brokerDir: dir })
    writeFileSync(
      join(dir, "device-identity.json"),
      JSON.stringify({
        deviceId: "dev-1",
        serverOrigin: "http://localhost:3001",
        hostKind: "browser",
        devicePubkeyFingerprint: "fp",
        devicePrivateKeyRef: "local:device",
        services: [],
      })
    )

    assert.equal(await broker.loadDeviceIdentity(), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("file-backed broker rejects malformed keystore state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synapse-device-broker-"))
  const keystorePath = join(dir, "device-keys.json")
  try {
    const broker = createFileBackedBroker({ brokerDir: dir })
    writeFileSync(
      keystorePath,
      JSON.stringify({
        "local:service": {
          publicKey: "public-pem",
          privateKey: 123,
          publicKeyFingerprint: "fingerprint",
        },
      })
    )

    assert.equal(await broker.loadKeyPair("local:service"), null)
    assert.equal(
      readPrivateKeyPemFromKeystoreFile(keystorePath, "local:service"),
      null
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("file-backed broker reads private PEM through keystore codec", () => {
  const dir = mkdtempSync(join(tmpdir(), "synapse-device-broker-"))
  const keystorePath = join(dir, "device-keys.json")
  try {
    writeFileSync(
      keystorePath,
      JSON.stringify({
        "local:service": {
          publicKey: "public-pem",
          privateKey: "private-pem",
          publicKeyFingerprint: "fingerprint",
        },
      })
    )

    assert.equal(
      readPrivateKeyPemFromKeystoreFile(keystorePath, "local:service"),
      "private-pem"
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
