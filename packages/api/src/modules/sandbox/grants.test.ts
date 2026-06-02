import test from "node:test"
import assert from "node:assert/strict"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { resolveDeviceBuiltinIds, SandboxGrantsError } from "./grants.js"
import {
  isSandboxCommandlineAvailable,
  __setSandboxCommandlineAvailableForTest,
} from "./model.js"

/**
 * grants.ts + model.ts unit coverage that doesn't require a live device/API:
 *  - resolveDeviceBuiltinIds maps a device's filesystem+commandline exposures to
 *    their capability ids (and tolerates a fs-only device).
 *  - the bwrap probe cache seam works (the full two-layer grant creation runs
 *    against the global pool and is exercised by test:integration).
 */

const NS = "sbg"
function rid(): string {
  return Math.random().toString(36).slice(2, 10)
}

async function seedDeviceWithBuiltins(
  db: Kysely<any>,
  opts: { commandline: boolean }
) {
  const user = await db
    .insertInto("users")
    .values({ email: `${rid()}@${NS}`, name: "u", password_hash: "x" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({ owner_id: user.id, slug: `ws-${rid()}`, name: `${NS} ws` })
    .returning("id")
    .executeTakeFirstOrThrow()
  const device = await db
    .insertInto("devices")
    .values({
      workspace_id: ws.id,
      title: "sandbox-dev",
      public_key: `pk-${rid()}`,
      public_key_fingerprint: `fp-${rid()}`,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const service = await db
    .insertInto("device_services")
    .values({
      device_id: device.id,
      service_kind: "device_runtime",
      status: "online",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()

  async function addBuiltin(kind: "filesystem" | "commandline") {
    const exposure = await db
      .insertInto("device_exposures")
      .values({
        device_id: device.id,
        service_id: service.id,
        stable_key: `synapse.builtin.${kind}.v1`,
        display_name: kind,
        transport: "builtin",
        builtin_kind: kind,
        runtime_status: "healthy",
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    const capability = await db
      .insertInto("device_capabilities")
      .values({
        workspace_id: ws.id,
        exposure_id: exposure.id,
        status: "active",
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    return {
      exposureId: exposure.id as string,
      capabilityId: capability.id as string,
    }
  }

  const fs = await addBuiltin("filesystem")
  const cmd = opts.commandline ? await addBuiltin("commandline") : null
  return { deviceId: device.id as string, fs, cmd }
}

test("grants.ts: resolveDeviceBuiltinIds maps fs + commandline builtins", async () => {
  await withTestDb(async (db) => {
    const { deviceId, fs, cmd } = await seedDeviceWithBuiltins(db, {
      commandline: true,
    })
    const ids = await resolveDeviceBuiltinIds(deviceId, db)
    assert.equal(ids.filesystemExposureId, fs.exposureId)
    assert.equal(ids.filesystemCapabilityId, fs.capabilityId)
    assert.equal(ids.commandlineExposureId, cmd!.exposureId)
    assert.equal(ids.commandlineCapabilityId, cmd!.capabilityId)
  })
})

test("grants.ts: resolveDeviceBuiltinIds tolerates a filesystem-only device", async () => {
  await withTestDb(async (db) => {
    const { deviceId, fs } = await seedDeviceWithBuiltins(db, {
      commandline: false,
    })
    const ids = await resolveDeviceBuiltinIds(deviceId, db)
    assert.equal(ids.filesystemCapabilityId, fs.capabilityId)
    assert.equal(ids.commandlineExposureId, null)
    assert.equal(ids.commandlineCapabilityId, null)
  })
})

test("grants.ts: resolveDeviceBuiltinIds throws when filesystem capability is absent", async () => {
  await withTestDb(async (db) => {
    // A device with no exposures at all.
    const user = await db
      .insertInto("users")
      .values({ email: `${rid()}@${NS}`, name: "u", password_hash: "x" })
      .returning("id")
      .executeTakeFirstOrThrow()
    const ws = await db
      .insertInto("workspaces")
      .values({ owner_id: user.id, slug: `ws-${rid()}`, name: `${NS} ws` })
      .returning("id")
      .executeTakeFirstOrThrow()
    const device = await db
      .insertInto("devices")
      .values({
        workspace_id: ws.id,
        title: "bare",
        public_key: `pk-${rid()}`,
        public_key_fingerprint: `fp-${rid()}`,
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    await assert.rejects(
      () => resolveDeviceBuiltinIds(device.id as string, db),
      (err: unknown) => err instanceof SandboxGrantsError
    )
  })
})

test("model.ts: bwrap probe cache seam", () => {
  __setSandboxCommandlineAvailableForTest(true)
  assert.equal(isSandboxCommandlineAvailable(), true)
  __setSandboxCommandlineAvailableForTest(false)
  assert.equal(isSandboxCommandlineAvailable(), false)
  // Reset so other tests re-probe the real host.
  __setSandboxCommandlineAvailableForTest(null)
})
