// Unit + integration test for device.hello authentication. Exercises the
// real authenticateRuntimeHello against a test database with a known
// (device, runtime_services, runtime_service_keys) seed and validates each
// failure mode.

import test from "node:test"
import assert from "node:assert/strict"
import {
  generateKeyPairSync,
  sign as cryptoSign,
  randomUUID,
} from "node:crypto"
import { sql } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { authenticateRuntimeHello } from "./control-plane-auth.js"

interface Seed {
  workspaceId: string
  deviceId: string
  serviceId: string
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]
}

async function seedDeviceWithService(db: any): Promise<Seed> {
  const workspaceId = randomUUID()
  const userId = randomUUID()
  await db.executeQuery(
    sql`INSERT INTO users (id, email, name) VALUES (${userId}, ${`${userId}@test`}, 'tester')`.compile(
      db
    )
  )
  await db.executeQuery(
    sql`INSERT INTO workspaces (id, name, slug, owner_id) VALUES (${workspaceId}, 'test-ws', ${`ws-${workspaceId.slice(0, 8)}`}, ${userId})`.compile(
      db
    )
  )

  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const pubPem = publicKey.export({ format: "pem", type: "spki" }) as string
  const pubFp = randomUUID().replace(/-/g, "") // any unique string

  const deviceId = randomUUID()
  // devices is a CTI detail of runtimes — insert the runtimes parent first (same
  // rolled-back test transaction; deferred detail-consistency validates at the
  // tx boundary).
  await db.executeQuery(
    sql`
      INSERT INTO runtimes (id, workspace_id, kind)
      VALUES (${deviceId}, ${workspaceId}, 'device')
    `.compile(db)
  )
  await db.executeQuery(
    sql`
      INSERT INTO devices (id, workspace_id, title, device_type, public_key, public_key_fingerprint, trust_status)
      VALUES (${deviceId}, ${workspaceId}, 'test-device', 'desktop_computer', ${pubPem}, ${pubFp}, 'trusted')
    `.compile(db)
  )

  const serviceId = randomUUID()
  await db.executeQuery(
    sql`
      INSERT INTO runtime_services (id, runtime_id, service_kind, status)
      VALUES (${serviceId}, ${deviceId}, 'device_runtime', 'starting')
    `.compile(db)
  )

  await db.executeQuery(
    sql`
      INSERT INTO runtime_service_keys (id, service_id, pubkey, pubkey_fingerprint)
      VALUES (${randomUUID()}, ${serviceId}, ${pubPem}, ${pubFp})
    `.compile(db)
  )

  return { workspaceId, deviceId, serviceId, privateKey }
}

function signNonce(privateKey: any, nonce: string): string {
  return cryptoSign(null, Buffer.from(nonce, "utf8"), privateKey).toString(
    "base64"
  )
}

test("authenticateRuntimeHello accepts a valid signature", async () => {
  await withTestDb(async (db) => {
    const seed = await seedDeviceWithService(db)
    const nonce = "0123456789abcdef"
    const result = await authenticateRuntimeHello(
      {
        runtimeId: seed.deviceId,
        serviceId: seed.serviceId,
        signedChallenge: signNonce(seed.privateKey, nonce),
        challengeNonce: nonce,
      },
      db
    )
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.runtimeId, seed.deviceId)
      assert.equal(result.serviceId, seed.serviceId)
    }
  })
})

test("authenticateRuntimeHello rejects unknown runtime_id", async () => {
  await withTestDb(async (db) => {
    const result = await authenticateRuntimeHello(
      {
        runtimeId: randomUUID(),
        serviceId: randomUUID(),
        signedChallenge: "AAAA",
        challengeNonce: "n",
      },
      db
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "device_not_found")
  })
})

test("authenticateRuntimeHello rejects mismatched service/device pair", async () => {
  await withTestDb(async (db) => {
    const seed = await seedDeviceWithService(db)
    const result = await authenticateRuntimeHello(
      {
        runtimeId: seed.deviceId,
        serviceId: randomUUID(), // not a child of seed.deviceId
        signedChallenge: "AAAA",
        challengeNonce: "n",
      },
      db
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "service_not_found")
  })
})

test("authenticateRuntimeHello rejects a wrong signature", async () => {
  await withTestDb(async (db) => {
    const seed = await seedDeviceWithService(db)
    const wrongPrivate = generateKeyPairSync("ed25519").privateKey
    const result = await authenticateRuntimeHello(
      {
        runtimeId: seed.deviceId,
        serviceId: seed.serviceId,
        signedChallenge: signNonce(wrongPrivate, "the-nonce"),
        challengeNonce: "the-nonce",
      },
      db
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "signature_invalid")
  })
})

test("authenticateRuntimeHello rejects a revoked service key", async () => {
  await withTestDb(async (db) => {
    const seed = await seedDeviceWithService(db)
    await db.executeQuery(
      sql`UPDATE runtime_service_keys SET revoked_at = NOW() WHERE service_id = ${seed.serviceId}`.compile(
        db
      )
    )
    const result = await authenticateRuntimeHello(
      {
        runtimeId: seed.deviceId,
        serviceId: seed.serviceId,
        signedChallenge: signNonce(seed.privateKey, "n"),
        challengeNonce: "n",
      },
      db
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "service_key_missing")
  })
})
