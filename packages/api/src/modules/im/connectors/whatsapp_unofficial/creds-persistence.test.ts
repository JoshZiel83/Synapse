import test from "node:test"
import assert from "node:assert/strict"
import {
  AUTH_BLOB_CREDENTIAL_KEY,
  clearAuthSnapshot,
  decryptAuthBlob,
  deserializeAuthSnapshot,
  encryptAuthBlob,
  freshAuthSnapshot,
  loadAuthSnapshotFromCredentials,
  persistAuthSnapshot,
  serializeAuthSnapshot,
} from "./creds-persistence.js"

test("BufferJSON round-trip preserves Buffer key material", () => {
  const snap = freshAuthSnapshot()
  const restored = deserializeAuthSnapshot(serializeAuthSnapshot(snap))
  assert.equal(restored.creds.registrationId, snap.creds.registrationId)
  assert.ok(Buffer.isBuffer(restored.creds.noiseKey.private))
  assert.ok(Buffer.isBuffer(restored.creds.signedIdentityKey.public))
})

test("encrypt produces enc:v2 envelope, decrypt round-trips", () => {
  const ser = serializeAuthSnapshot(freshAuthSnapshot())
  const enc = encryptAuthBlob(ser)
  assert.ok(enc.startsWith("enc:v2:"))
  assert.equal(decryptAuthBlob(enc), ser)
})

test("decryptAuthBlob passes through a legacy unencrypted blob", () => {
  const ser = serializeAuthSnapshot(freshAuthSnapshot())
  assert.equal(decryptAuthBlob(ser), ser)
})

test("loadAuthSnapshotFromCredentials: null when absent, snapshot when present", () => {
  assert.equal(loadAuthSnapshotFromCredentials(undefined), null)
  assert.equal(loadAuthSnapshotFromCredentials({}), null)
  assert.equal(
    loadAuthSnapshotFromCredentials({ [AUTH_BLOB_CREDENTIAL_KEY]: "" }),
    null
  )

  const snap = freshAuthSnapshot()
  const blob = encryptAuthBlob(serializeAuthSnapshot(snap))
  const loaded = loadAuthSnapshotFromCredentials({
    [AUTH_BLOB_CREDENTIAL_KEY]: blob,
  })
  assert.ok(loaded)
  assert.equal(loaded.creds.registrationId, snap.creds.registrationId)
})

test("persistAuthSnapshot encrypts and writes through the injected update seam", async () => {
  const calls: Array<Record<string, unknown>> = []
  const fakeUpdate = (async (params: Record<string, unknown>) => {
    calls.push(params)
    return params as never
  }) as never

  await persistAuthSnapshot(
    { workspaceId: "ws1", accountId: "acc1", snapshot: freshAuthSnapshot() },
    { update: fakeUpdate }
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].accountId, "acc1")
  assert.equal(calls[0].expectedTransportKind, "whatsapp_unofficial")
  const creds = calls[0].credentials as Record<string, unknown>
  assert.ok(String(creds[AUTH_BLOB_CREDENTIAL_KEY]).startsWith("enc:v2:"))
})

test("clearAuthSnapshot wipes the blob and marks error status", async () => {
  const calls: Array<Record<string, unknown>> = []
  const fakeUpdate = (async (params: Record<string, unknown>) => {
    calls.push(params)
    return params as never
  }) as never

  await clearAuthSnapshot(
    { workspaceId: "ws1", accountId: "acc1" },
    { update: fakeUpdate }
  )
  assert.equal(calls[0].status, "error")
  const creds = calls[0].credentials as Record<string, unknown>
  assert.equal(creds[AUTH_BLOB_CREDENTIAL_KEY], "")
})
