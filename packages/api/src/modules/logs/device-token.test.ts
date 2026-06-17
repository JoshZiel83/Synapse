import { test } from "node:test"
import assert from "node:assert/strict"

// Set the secret BEFORE importing the module (it reads it at module-eval).
process.env.SYNAPSE_LOG_INGEST_SECRET = "unit-test-secret"

test("device log token: mint/verify roundtrip, expiry, tamper", async () => {
  const { mintDeviceLogToken, verifyDeviceLogToken } =
    await import("./device-token.js")
  const now = 1_000_000

  const token = mintDeviceLogToken("dev-1", "svc-1", now)
  assert.ok(token, "token minted")

  // valid within TTL
  assert.deepEqual(verifyDeviceLogToken(token, now + 1_000), {
    deviceId: "dev-1",
    serviceId: "svc-1",
  })

  // expired (TTL is 12h)
  assert.equal(
    verifyDeviceLogToken(token, now + 13 * 60 * 60 * 1000),
    null,
    "expired token rejected"
  )

  // tampered signature / garbage
  assert.equal(verifyDeviceLogToken(`${token}x`, now), null)
  assert.equal(verifyDeviceLogToken("not-a-token", now), null)
  assert.equal(verifyDeviceLogToken("", now), null)
})
