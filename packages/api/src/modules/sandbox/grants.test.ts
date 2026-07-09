import test from "node:test"
import assert from "node:assert/strict"
import { SUBJECT_KIND } from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { insertDeviceRuntime } from "../../test/helpers/runtime-fixtures.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { resolveRuntimeBuiltinIds, SandboxGrantsError } from "./grants.js"

/**
 * grants.ts unit coverage that doesn't require a live device/API:
 *  - resolveRuntimeBuiltinIds maps a device's filesystem+commandline exposures to
 *    their capability ids (and tolerates a fs-only device). Whether the
 *    commandline grant is built is decided by the resolved catalog
 *    (commandlineCapabilityId != null), exercised by test:integration.
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
    .values({ email: `${rid()}@${NS}`, name: "u" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({ ownerId: user.id, slug: `ws-${rid()}`, name: `${NS} ws` })
    .returning("id")
    .executeTakeFirstOrThrow()
  const device = await insertDeviceRuntime(db, {
    workspaceId: ws.id,
    title: "sandbox-dev",
    publicKey: `pk-${rid()}`,
    publicKeyFingerprint: `fp-${rid()}`,
  })
  const service = await db
    .insertInto("runtimeServices")
    .values({
      runtimeId: device.id,
      serviceKind: "device_runtime",
      status: "online",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()

  async function addBuiltin(kind: "filesystem" | "commandline") {
    const exposure = await db
      .insertInto("runtimeExposures")
      .values({
        runtimeId: device.id,
        workspaceId: ws.id,
        serviceId: service.id,
        stableKey: `synapse.builtin.${kind}.v1`,
        displayName: kind,
        transport: "builtin",
        builtinKind: kind,
        runtimeStatus: "healthy",
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    const createdBySubjectId = await upsertAccessSubject(db, {
      kind: SUBJECT_KIND.PLATFORM,
    })
    const capabilityRoot = await db
      .insertInto("workspaceResources")
      .values({
        workspaceId: ws.id,
        kind: "runtime_capability",
        displayName: kind,
        createdBySubjectId,
        status: "active",
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    const capability = await db
      .insertInto("runtimeCapabilities")
      .values({
        id: capabilityRoot.id as string,
        workspaceId: ws.id,
        exposureId: exposure.id,
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

test("grants.ts: resolveRuntimeBuiltinIds maps fs + commandline builtins", async () => {
  await withTestDb(async (db) => {
    const { deviceId, fs, cmd } = await seedDeviceWithBuiltins(db, {
      commandline: true,
    })
    const ids = await resolveRuntimeBuiltinIds(deviceId, db)
    assert.equal(ids.filesystemExposureId, fs.exposureId)
    assert.equal(ids.filesystemCapabilityId, fs.capabilityId)
    assert.equal(ids.commandlineExposureId, cmd!.exposureId)
    assert.equal(ids.commandlineCapabilityId, cmd!.capabilityId)
  })
})

test("grants.ts: resolveRuntimeBuiltinIds tolerates a filesystem-only device", async () => {
  await withTestDb(async (db) => {
    const { deviceId, fs } = await seedDeviceWithBuiltins(db, {
      commandline: false,
    })
    const ids = await resolveRuntimeBuiltinIds(deviceId, db)
    assert.equal(ids.filesystemCapabilityId, fs.capabilityId)
    assert.equal(ids.commandlineExposureId, null)
    assert.equal(ids.commandlineCapabilityId, null)
  })
})

test("grants.ts: resolveRuntimeBuiltinIds throws when filesystem capability is absent", async () => {
  await withTestDb(async (db) => {
    // A device with no exposures at all.
    const user = await db
      .insertInto("users")
      .values({ email: `${rid()}@${NS}`, name: "u" })
      .returning("id")
      .executeTakeFirstOrThrow()
    const ws = await db
      .insertInto("workspaces")
      .values({ ownerId: user.id, slug: `ws-${rid()}`, name: `${NS} ws` })
      .returning("id")
      .executeTakeFirstOrThrow()
    const device = await insertDeviceRuntime(db, {
      workspaceId: ws.id,
      title: "bare",
      publicKey: `pk-${rid()}`,
      publicKeyFingerprint: `fp-${rid()}`,
    })
    await assert.rejects(
      () => resolveRuntimeBuiltinIds(device.id as string, db),
      (err: unknown) => err instanceof SandboxGrantsError
    )
  })
})
