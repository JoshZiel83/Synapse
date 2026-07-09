// S6 — consume-fork pins. Two obligations:
//   (d) REAL-DEVICE regression: the 'device' branch of consumeCloudBootstrapTx /
//       consumeLocalPairingTx is unchanged — runtimes(kind='device') + a devices
//       detail row + service + key, NO sandboxes row.
//   SANDBOX fork: target_runtime_kind='sandbox' mints runtimes(kind='sandbox') +
//       a sandboxes detail row (NO devices row), reading adapter/mode/session_id
//       from the pairing context.
//
// The consume/mint txns take an `executor` TEST SEAM so they run on the same
// withTestDb rolled-back connection (production still uses the global tx).

import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID, createHash } from "node:crypto"
import { sql } from "kysely"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { consumeCloudBootstrapTx, consumeLocalPairingTx } from "./repo.js"

function uniq(p: string): string {
  return `${p}-${Math.random().toString(36).slice(2, 12)}`
}

async function seedWorkspace(db: Kysely<any>): Promise<string> {
  const user = await db
    .insertInto("users")
    .values({ email: `${uniq("u")}@cf`, name: "u" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({ ownerId: user.id, slug: uniq("ws"), name: "cf ws" })
    .returning("id")
    .executeTakeFirstOrThrow()
  return ws.id as string
}

async function seedCloudPairing(
  db: Kysely<any>,
  workspaceId: string,
  targetRuntimeKind: "device" | "sandbox",
  context: Record<string, unknown>
): Promise<{ tokenHash: Buffer; pendingRuntimeId: string }> {
  const token = uniq("tok")
  const tokenHash = createHash("sha256").update(token).digest()
  const pendingRuntimeId = randomUUID()
  await db
    .insertInto("runtimePairingSessions")
    .values({
      id: randomUUID(),
      workspaceId,
      mode: "cloud_bootstrap",
      targetRuntimeKind,
      serverBaseUrl: "",
      requestedTitle: "Cloud Device",
      bootstrapTokenHash: tokenHash,
      status: "pending",
      expiresAt: new Date(Date.now() + 600_000),
      context: sql`${JSON.stringify({ pending_runtime_id: pendingRuntimeId, ...context })}::jsonb`,
    } as any)
    .execute()
  return { tokenHash, pendingRuntimeId }
}

test("(d) consumeCloudBootstrapTx DEVICE branch: runtimes(kind=device)+devices, NO sandboxes", async () => {
  await withTestDb(async (db) => {
    const ws = await seedWorkspace(db)
    const { tokenHash, pendingRuntimeId } = await seedCloudPairing(
      db,
      ws,
      "device",
      {}
    )
    const result = await consumeCloudBootstrapTx({
      tokenHash,
      device: {
        platform: "linux",
        arch: "x64",
        publicKey: "pk",
        publicKeyFingerprint: uniq("dfp"),
      },
      service: { serviceId: randomUUID(), version: null },
      serviceKey: {
        serviceKeyId: randomUUID(),
        pubkey: "spk",
        pubkeyFingerprint: uniq("sfp"),
      },
      executor: db,
    })
    assert.equal(result.outcome, "ok")
    if (result.outcome !== "ok") return
    assert.equal(result.pendingDeviceId, pendingRuntimeId)

    const runtime = await db
      .selectFrom("runtimes")
      .select(["kind"])
      .where("id", "=", pendingRuntimeId)
      .executeTakeFirst()
    assert.equal(runtime?.kind, "device")
    const device = await db
      .selectFrom("devices")
      .select("id")
      .where("id", "=", pendingRuntimeId)
      .executeTakeFirst()
    assert.ok(device, "devices detail row present")
    const sandbox = await db
      .selectFrom("sandboxes")
      .select("id")
      .where("id", "=", pendingRuntimeId)
      .executeTakeFirst()
    assert.equal(sandbox, undefined, "NO sandboxes row for a device")
    const svc = await db
      .selectFrom("runtimeServices")
      .select("id")
      .where("runtimeId", "=", pendingRuntimeId)
      .executeTakeFirst()
    assert.ok(svc, "runtime service present")
  })
})

test("consumeCloudBootstrapTx SANDBOX branch: runtimes(kind=sandbox)+sandboxes, NO devices", async () => {
  await withTestDb(async (db) => {
    const ws = await seedWorkspace(db)
    const { tokenHash, pendingRuntimeId } = await seedCloudPairing(
      db,
      ws,
      "sandbox",
      { adapter: "docker", mode: "resident", session_id: null }
    )
    const result = await consumeCloudBootstrapTx({
      tokenHash,
      device: {
        platform: "linux",
        arch: "x64",
        publicKey: "pk",
        publicKeyFingerprint: uniq("dfp"),
      },
      service: { serviceId: randomUUID(), version: null },
      serviceKey: {
        serviceKeyId: randomUUID(),
        pubkey: "spk",
        pubkeyFingerprint: uniq("sfp"),
      },
      executor: db,
    })
    assert.equal(result.outcome, "ok")

    const runtime = await db
      .selectFrom("runtimes")
      .select(["kind"])
      .where("id", "=", pendingRuntimeId)
      .executeTakeFirst()
    assert.equal(runtime?.kind, "sandbox")
    const sandbox = await db
      .selectFrom("sandboxes")
      .select(["id", "adapter", "mode", "state"])
      .where("id", "=", pendingRuntimeId)
      .executeTakeFirst()
    assert.ok(sandbox, "sandboxes detail row present")
    assert.equal(sandbox?.adapter, "docker")
    assert.equal(sandbox?.mode, "resident")
    assert.equal(sandbox?.state, "provisioning")
    const device = await db
      .selectFrom("devices")
      .select("id")
      .where("id", "=", pendingRuntimeId)
      .executeTakeFirst()
    assert.equal(device, undefined, "NO devices row for a sandbox runtime")
  })
})

test("(d) consumeLocalPairingTx DEVICE branch: runtimes(kind=device)+devices, NO sandboxes", async () => {
  await withTestDb(async (db) => {
    const ws = await seedWorkspace(db)
    const pairingCode = uniq("code")
    await db
      .insertInto("runtimePairingSessions")
      .values({
        id: randomUUID(),
        workspaceId: ws,
        mode: "local_qr",
        targetRuntimeKind: "device",
        serverBaseUrl: "http://localhost:3001",
        pairingCode,
        status: "pending",
        expiresAt: new Date(Date.now() + 600_000),
        context: sql`'{}'::jsonb`,
      } as any)
      .execute()
    const result = await consumeLocalPairingTx({
      pairingCode,
      pubkeyFingerprint: uniq("dfp"),
      serviceFingerprint: uniq("sfp"),
      devicePubkey: "dpk",
      servicePubkey: "spk",
      clientVersion: null,
      executor: db,
    })
    assert.equal(result.outcome, "ok")
    if (result.outcome !== "ok") return

    const runtime = await db
      .selectFrom("runtimes")
      .select(["kind"])
      .where("id", "=", result.deviceId)
      .executeTakeFirst()
    assert.equal(runtime?.kind, "device")
    const device = await db
      .selectFrom("devices")
      .select("id")
      .where("id", "=", result.deviceId)
      .executeTakeFirst()
    assert.ok(device, "devices detail row present")
    const sandbox = await db
      .selectFrom("sandboxes")
      .select("id")
      .where("id", "=", result.deviceId)
      .executeTakeFirst()
    assert.equal(sandbox, undefined, "NO sandboxes row for a device")
  })
})
