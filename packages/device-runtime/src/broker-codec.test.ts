import assert from "node:assert/strict"
import test from "node:test"

import {
  parseDeviceIdentityJsonText,
  parseKeystoreJsonText,
} from "./broker-codec.js"

test("parseKeystoreJsonText accepts persisted key entries", () => {
  assert.deepEqual(
    parseKeystoreJsonText(
      JSON.stringify({
        "local:service": {
          publicKey: "public-pem",
          privateKey: "private-pem",
          publicKeyFingerprint: "fingerprint",
        },
      })
    ),
    {
      "local:service": {
        publicKey: "public-pem",
        privateKey: "private-pem",
        publicKeyFingerprint: "fingerprint",
      },
    }
  )
})

test("parseKeystoreJsonText rejects malformed JSON and malformed entries", () => {
  assert.throws(() => parseKeystoreJsonText("{not-json"))
  assert.throws(() =>
    parseKeystoreJsonText(
      JSON.stringify({
        "local:service": {
          publicKey: "public-pem",
          privateKey: 123,
          publicKeyFingerprint: "fingerprint",
        },
      })
    )
  )
})

test("parseDeviceIdentityJsonText accepts persisted identity state", () => {
  const parsed = parseDeviceIdentityJsonText(
    JSON.stringify({
      deviceId: "dev-1",
      serverOrigin: "http://localhost:3001",
      hostKind: "local",
      services: [
        {
          serviceKind: "device_runtime",
          serviceId: "svc-1",
          pubkeyFingerprint: "fp",
          privateKeyRef: "local:service",
        },
      ],
      devicePubkeyFingerprint: "device-fp",
      devicePrivateKeyRef: "local:device",
    })
  )

  assert.equal(parsed.deviceId, "dev-1")
  assert.equal(parsed.services[0]?.serviceKind, "device_runtime")
})

test("parseDeviceIdentityJsonText rejects malformed identity state", () => {
  assert.throws(() => parseDeviceIdentityJsonText("{not-json"))
  assert.throws(() =>
    parseDeviceIdentityJsonText(
      JSON.stringify({
        deviceId: "dev-1",
        serverOrigin: "http://localhost:3001",
        hostKind: "browser",
        services: [],
        devicePubkeyFingerprint: "device-fp",
        devicePrivateKeyRef: "local:device",
      })
    )
  )
})
