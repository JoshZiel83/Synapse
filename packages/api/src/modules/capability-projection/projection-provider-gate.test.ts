// P2(A) — the SANDBOX_PROVIDER=none projection gate. When the sandbox substrate
// is disabled, selectRuntimeCapabilityToolsForSubjects must EXCLUDE a
// kind='sandbox' runtime's tools while KEEPING a real kind='device' runtime's
// tools; when a provider is active it includes both.
//
// CRITICAL: the gate keys on the runtime KIND, never serviceKind — BOTH runtimes
// here mint serviceKind='device_runtime', so a serviceKind filter would wrongly
// hide the real device's tools. This test seeds both to prove the distinction.

import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { Kysely } from "kysely"
import { SUBJECT_KIND } from "@synapse/shared"
import { withTestDb } from "../../test/helpers/db.js"
import { insertDeviceRuntime } from "../../test/helpers/runtime-fixtures.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { selectRuntimeCapabilityToolsForSubjects } from "./repo.js"

function uniq(p: string): string {
  return `${p}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Attach a granted, fully-projected filesystem tool to an already-inserted
 * runtime (device OR sandbox). Mints serviceKind='device_runtime' for both — the
 * whole point being that the provider gate must NOT key on serviceKind.
 */
async function attachFsTool(
  db: Kysely<any>,
  args: {
    workspaceId: string
    runtimeId: string
    grantSubjectId: string
    platformSubject: string
  }
): Promise<void> {
  const { workspaceId, runtimeId, grantSubjectId, platformSubject } = args
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
  const exposure = await db
    .insertInto("runtimeExposures")
    .values({
      runtimeId,
      workspaceId,
      serviceId,
      stableKey: uniq("synapse.builtin.filesystem"),
      displayName: "filesystem",
      transport: "builtin",
      builtinKind: "filesystem",
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
      displayName: "filesystem",
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
      stableKey: uniq("synapse.builtin.filesystem.tool"),
      currentName: "fs_read",
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
      toolName: "fs_read",
      description: "read",
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
}

async function seed(db: Kysely<any>): Promise<{
  workspaceId: string
  grantSubjectId: string
  deviceRuntimeId: string
  sandboxRuntimeId: string
}> {
  const user = await db
    .insertInto("users")
    .values({ email: `${uniq("u")}@ppg`, name: "u" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({ ownerId: user.id, slug: uniq("ws"), name: "ppg ws" } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const workspaceId = ws.id as string

  const platformSubject = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.PLATFORM,
  })
  const grantSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE,
    workspaceId,
  } as any)

  // kind='device' runtime (real device — has a devices row).
  const device = await insertDeviceRuntime(db, {
    workspaceId,
    title: uniq("dev"),
    publicKey: uniq("pk"),
    publicKeyFingerprint: uniq("fp"),
  })
  await attachFsTool(db, {
    workspaceId,
    runtimeId: device.id,
    grantSubjectId,
    platformSubject,
  })

  // kind='sandbox' runtime (device-less).
  const sandboxRuntimeId = randomUUID()
  await db
    .insertInto("runtimes")
    .values({ id: sandboxRuntimeId, workspaceId, kind: "sandbox" })
    .execute()
  await attachFsTool(db, {
    workspaceId,
    runtimeId: sandboxRuntimeId,
    grantSubjectId,
    platformSubject,
  })

  return {
    workspaceId,
    grantSubjectId,
    deviceRuntimeId: device.id,
    sandboxRuntimeId,
  }
}

test("P2(A): provider=none excludes kind='sandbox' tools but keeps kind='device'; active provider includes both", async () => {
  await withTestDb(async (db) => {
    const s = await seed(db)
    const query = {
      workspaceId: s.workspaceId,
      subjectIds: [s.grantSubjectId],
      runtimeScopeSubjectIds: [],
    }

    // provider=none → sandbox excluded, device kept.
    const none = await selectRuntimeCapabilityToolsForSubjects(query, db, {
      sandboxProvider: "none",
    })
    const noneIds = new Set(none.map((r) => r.runtimeId))
    const noneKinds = new Set(none.map((r) => r.runtimeKind))
    assert.ok(noneIds.has(s.deviceRuntimeId), "device tool kept under none")
    assert.ok(
      !noneIds.has(s.sandboxRuntimeId),
      "sandbox tool EXCLUDED under none"
    )
    assert.ok(noneKinds.has("device"), "a device row survives")
    assert.ok(!noneKinds.has("sandbox"), "no sandbox row projected")

    // provider=local → both present (gate off).
    const local = await selectRuntimeCapabilityToolsForSubjects(query, db, {
      sandboxProvider: "local",
    })
    const localIds = new Set(local.map((r) => r.runtimeId))
    assert.ok(localIds.has(s.deviceRuntimeId), "device tool present")
    assert.ok(
      localIds.has(s.sandboxRuntimeId),
      "sandbox tool INCLUDED when a provider is active"
    )
  })
})
