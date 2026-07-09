// G3 — device-less Mode-A pin (the real Mode-A green criterion for the P2
// substrate generalization, §4.7 / CORRECTION 3). Drives a kind='sandbox'
// runtime with NO `devices` row through the four cross-module read paths that
// used to hard-check the `devices` table:
//   1. device.hello auth  (selectDeviceHelloAuthContext → runtimes existence)
//   2. catalog readiness  (isFilesystemExposureHealthy — the waitForCatalog tick)
//   3. tool projection     (selectDeviceCapabilityToolsForSubjects surfaces
//                           the sandbox's fs + commandline tools)
//   4. access evaluation   (loadDeviceExposureDeviceId + loadDeviceCapabilityAccessRow
//                           resolve non-null for the sandbox's capability)
// Without S3 every one of these drops the device-less runtime, so Mode-A
// provision would ALWAYS fail. This fixture never inserts a `devices` row.

import test from "node:test"
import assert from "node:assert/strict"
import {
  randomUUID,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto"
import type { Kysely } from "kysely"
import { SUBJECT_KIND } from "@synapse/shared"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { authenticateDeviceHello } from "../devices/control-plane-auth.js"
import { isFilesystemExposureHealthy } from "./repo.js"
import { selectDeviceCapabilityToolsForSubjects } from "../capability-projection/repo.js"
import {
  loadDeviceExposureDeviceId,
  loadDeviceCapabilityAccessRow,
} from "../access/repo-evaluator.js"

function uniq(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

interface SandboxRuntimeSeed {
  workspaceId: string
  runtimeId: string
  serviceId: string
  grantSubjectId: string
  builtins: Record<
    "filesystem" | "commandline",
    { exposureId: string; capabilityId: string; toolId: string }
  >
  serviceKeyPubPem: string
  servicePrivateKey: KeyObject
}

/**
 * Seed a kind='sandbox' runtime (NO `devices` row) with a device_runtime
 * service + service key + fs/commandline builtin exposures fully projected
 * (exposure → capability(resource) → tool → revision → catalog revision) and a
 * `use` grant to a subject. Mirrors what the in-sandbox device-runtime
 * self-registers via device.catalog.sync — but on a sandbox-kind runtime.
 */
async function seedSandboxRuntime(
  db: Kysely<any>
): Promise<SandboxRuntimeSeed> {
  const user = await db
    .insertInto("users")
    .values({ email: uniq("u") + "@dlm", name: "u" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({ ownerId: user.id, slug: uniq("ws"), name: "dlm ws" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const workspaceId = ws.id as string

  // kind='sandbox' runtime — NO devices row (the whole point of the pin).
  const runtimeId = randomUUID()
  await db
    .insertInto("runtimes")
    .values({ id: runtimeId, workspaceId, kind: "sandbox" })
    .execute()

  const service = await db
    .insertInto("runtimeServices")
    .values({
      runtimeId,
      serviceKind: "device_runtime",
      status: "online",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const serviceId = service.id as string

  // Real ed25519 service key so device.hello signature verification runs for real.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const serviceKeyPubPem = publicKey.export({
    format: "pem",
    type: "spki",
  }) as string
  await db
    .insertInto("runtimeServiceKeys")
    .values({
      serviceId,
      pubkey: serviceKeyPubPem,
      pubkeyFingerprint: uniq("svc-fp"),
    } as any)
    .execute()

  const platformSubject = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.PLATFORM,
  })
  // The subject the tools are granted to (any access subject works for the
  // projection; we grant `use` with scope NULL and pass it in subjectIds).
  const grantSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE,
    workspaceId,
  } as any)

  const builtins: SandboxRuntimeSeed["builtins"] = {} as any
  for (const kind of ["filesystem", "commandline"] as const) {
    const exposure = await db
      .insertInto("runtimeExposures")
      .values({
        runtimeId,
        workspaceId,
        serviceId,
        stableKey: `synapse.builtin.${kind}.v1`,
        displayName: kind,
        transport: "builtin",
        builtinKind: kind,
        runtimeStatus: "healthy",
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    const exposureId = exposure.id as string

    const capabilityId = randomUUID()
    await db
      .insertInto("workspaceResources")
      .values({
        id: capabilityId,
        workspaceId,
        kind: "runtime_capability",
        displayName: kind,
        status: "active",
        createdBySubjectId: platformSubject,
      } as any)
      .execute()
    await db
      .insertInto("runtimeCapabilities")
      .values({ id: capabilityId, workspaceId, exposureId } as any)
      .execute()

    const catRev = await db
      .insertInto("runtimeCatalogRevisions")
      .values({
        exposureId,
        revisionSeq: 1,
        schemaHash: uniq("sh"),
        status: "active",
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    const tool = await db
      .insertInto("runtimeTools")
      .values({
        exposureId,
        stableKey: `synapse.builtin.${kind}.tool`,
        currentName: kind === "filesystem" ? "fs_read" : "bash",
        status: "active",
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    const toolId = tool.id as string
    const rev = await db
      .insertInto("runtimeToolRevisions")
      .values({
        toolId,
        catalogRevisionId: catRev.id as string,
        toolName: kind === "filesystem" ? "fs_read" : "bash",
        description: kind,
        inputSchema: { type: "object" },
        definitionHash: uniq("dh"),
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    await db
      .updateTable("runtimeTools")
      .set({ latestRevisionId: rev.id as string } as any)
      .where("id", "=", toolId)
      .execute()

    // Layer-1 capability grant to the subject (what surfaces the tool).
    await db
      .insertInto("workspaceResourceGrants")
      .values({
        workspaceId,
        workspaceResourceId: capabilityId,
        subjectId: grantSubjectId,
        permissions: ["use"],
        status: "active",
      } as any)
      .execute()

    builtins[kind] = { exposureId, capabilityId, toolId }
  }

  return {
    workspaceId,
    runtimeId,
    serviceId,
    grantSubjectId,
    builtins,
    serviceKeyPubPem,
    servicePrivateKey: privateKey,
  }
}

test("G3: a device-less sandbox runtime authenticates device.hello (runtimes existence probe)", async () => {
  await withTestDb(async (db) => {
    const seed = await seedSandboxRuntime(db)
    const nonce = "hello-challenge-" + uniq("n")
    const signedChallenge = cryptoSign(
      null,
      Buffer.from(nonce, "utf8"),
      seed.servicePrivateKey
    ).toString("base64")
    const result = await authenticateDeviceHello(
      {
        deviceId: seed.runtimeId,
        serviceId: seed.serviceId,
        signedChallenge,
        challengeNonce: nonce,
      },
      db
    )
    assert.equal(result.ok, true, "sandbox runtime hello must authenticate")
    if (result.ok) {
      assert.equal(result.deviceId, seed.runtimeId)
      assert.equal(result.serviceId, seed.serviceId)
    }
  })
})

test("G3: waitForCatalog tick (isFilesystemExposureHealthy) sees the sandbox's fs exposure", async () => {
  await withTestDb(async (db) => {
    const seed = await seedSandboxRuntime(db)
    assert.equal(await isFilesystemExposureHealthy(seed.runtimeId, db), true)
  })
})

test("G3: selectDeviceCapabilityToolsForSubjects surfaces the sandbox's fs + commandline tools", async () => {
  await withTestDb(async (db) => {
    const seed = await seedSandboxRuntime(db)
    const rows = await selectDeviceCapabilityToolsForSubjects(
      {
        workspaceId: seed.workspaceId,
        subjectIds: [seed.grantSubjectId],
        runtimeScopeSubjectIds: [],
      },
      db
    )
    const byBuiltin = new Map(rows.map((r) => [r.builtinKind, r]))
    assert.ok(byBuiltin.has("filesystem"), "fs tool surfaced")
    assert.ok(byBuiltin.has("commandline"), "commandline tool surfaced")
    // The runtimeId is the sandbox runtime id (r.id), NOT a device id.
    assert.equal(byBuiltin.get("filesystem")!.runtimeId, seed.runtimeId)
    // deviceName COALESCEs to 'Sandbox' (no devices row) and platform/arch to
    // linux/x64 defaults.
    assert.equal(byBuiltin.get("filesystem")!.deviceName, "Sandbox")
    assert.equal(byBuiltin.get("filesystem")!.devicePlatform, "linux")
    assert.equal(byBuiltin.get("filesystem")!.deviceArch, "x64")
  })
})

test("G3: the access-evaluator resolves a non-null access row for the sandbox's capability", async () => {
  await withTestDb(async (db) => {
    const seed = await seedSandboxRuntime(db)
    const resolvedRuntimeId = await loadDeviceExposureDeviceId(
      db,
      seed.builtins.filesystem.exposureId
    )
    assert.equal(resolvedRuntimeId, seed.runtimeId)
    const accessRow = await loadDeviceCapabilityAccessRow(
      db,
      seed.builtins.filesystem.capabilityId
    )
    assert.ok(accessRow, "capability access row resolves for a sandbox runtime")
    assert.equal(accessRow!.workspaceId, seed.workspaceId)
  })
})
