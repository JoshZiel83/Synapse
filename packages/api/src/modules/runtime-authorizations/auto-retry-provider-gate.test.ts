// P2 (SANDBOX_PROVIDER=none) — the auto-retry target lookup must ALSO gate a
// resident (Mode-A) sandbox. A kind='sandbox' runtime that publishes a resident
// device-runtime service mints serviceKind='device_runtime', so its auto-retry
// dispatch takes the ungated dispatchSyncTool path (bare-dispatch's none gate
// only covers serviceKind='bare_dataplane'). findAutoRetryTarget therefore has to
// refuse kind='sandbox' under provider=none itself — otherwise an approval would
// re-dispatch into a sandbox the substrate is supposed to have disabled.
//
// CRITICAL (as in the projection gate): key on the runtime KIND, never
// serviceKind — a real device ALSO mints serviceKind='device_runtime', so a
// serviceKind filter would wrongly refuse real device auto-retries. This test
// seeds BOTH to prove the distinction.

import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { Kysely } from "kysely"
import { SUBJECT_KIND } from "@synapse/shared"
import { withTestDb } from "../../test/helpers/db.js"
import { insertDeviceRuntime } from "../../test/helpers/runtime-fixtures.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { findAutoRetryTarget } from "./repo.js"

function uniq(p: string): string {
  return `${p}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Attach a fully-projected, auto-retry-able tool (currentName + latestRevisionId
 * + active statuses — exactly what findAutoRetryTarget matches) to an
 * already-inserted runtime and return its capability id. Mints
 * serviceKind='device_runtime' for BOTH device and sandbox runtimes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function attachAutoRetryTool(
  db: Kysely<any>,
  args: {
    workspaceId: string
    runtimeId: string
    platformSubject: string
    toolName: string
  }
): Promise<{ capabilityId: string }> {
  const { workspaceId, runtimeId, platformSubject, toolName } = args
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
      currentName: toolName,
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
      toolName,
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
  return { capabilityId }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seed(db: Kysely<any>): Promise<{
  deviceCapabilityId: string
  sandboxCapabilityId: string
  toolName: string
}> {
  const toolName = "fs_read"
  const user = await db
    .insertInto("users")
    .values({ email: `${uniq("u")}@arg`, name: "u" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({ ownerId: user.id, slug: uniq("ws"), name: "arg ws" } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const workspaceId = ws.id as string
  const platformSubject = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.PLATFORM,
  })

  const device = await insertDeviceRuntime(db, {
    workspaceId,
    title: uniq("dev"),
    publicKey: uniq("pk"),
    publicKeyFingerprint: uniq("fp"),
  })
  const deviceCap = await attachAutoRetryTool(db, {
    workspaceId,
    runtimeId: device.id,
    platformSubject,
    toolName,
  })

  const sandboxRuntimeId = randomUUID()
  await db
    .insertInto("runtimes")
    .values({ id: sandboxRuntimeId, workspaceId, kind: "sandbox" } as any)
    .execute()
  const sandboxCap = await attachAutoRetryTool(db, {
    workspaceId,
    runtimeId: sandboxRuntimeId,
    platformSubject,
    toolName,
  })

  return {
    deviceCapabilityId: deviceCap.capabilityId,
    sandboxCapabilityId: sandboxCap.capabilityId,
    toolName,
  }
}

test("P2: provider=none refuses a resident-sandbox auto-retry target but KEEPS a device one; active provider keeps both", async () => {
  await withTestDb(async (db) => {
    const s = await seed(db)

    // provider=none → sandbox target refused (null), device target kept.
    const noneSandbox = await findAutoRetryTarget(
      {
        runtimeCapabilityId: s.sandboxCapabilityId,
        visibleToolName: s.toolName,
      },
      db,
      { sandboxProvider: "none" }
    )
    assert.equal(
      noneSandbox,
      null,
      "resident-sandbox auto-retry must be REFUSED under provider=none"
    )
    const noneDevice = await findAutoRetryTarget(
      {
        runtimeCapabilityId: s.deviceCapabilityId,
        visibleToolName: s.toolName,
      },
      db,
      { sandboxProvider: "none" }
    )
    assert.ok(noneDevice, "device auto-retry must survive under provider=none")
    assert.equal(noneDevice?.serviceKind, "device_runtime")

    // provider=local → both resolve (gate off).
    const localSandbox = await findAutoRetryTarget(
      {
        runtimeCapabilityId: s.sandboxCapabilityId,
        visibleToolName: s.toolName,
      },
      db,
      { sandboxProvider: "local" }
    )
    assert.ok(
      localSandbox,
      "sandbox auto-retry must resolve when a provider is active"
    )
    const localDevice = await findAutoRetryTarget(
      {
        runtimeCapabilityId: s.deviceCapabilityId,
        visibleToolName: s.toolName,
      },
      db,
      { sandboxProvider: "local" }
    )
    assert.ok(
      localDevice,
      "device auto-retry must resolve when a provider is active"
    )
  })
})
