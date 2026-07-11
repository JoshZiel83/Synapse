// P4a / S0 (PREREQ-CAT) pins — the coverage the P2 pins MISSED.
//
// The P2 device-less-mode-a pin SEEDS catalog rows directly and bypasses
// persistCatalogSync. But persistCatalogSync itself was still `devices`-table-
// bound: it read `selectFrom("devices") … throw "device not found"` and joined
// `devices` for owner attribution. A real kind='sandbox' runtime has NO
// `devices` row, so the api-authored catalog persist would FAIL. These pins
// drive the REAL persistCatalogSync (executor test seam) so the re-point is
// actually exercised, plus the LEFT-JOIN owner-attribution parity for a device.

import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { Kysely } from "kysely"
import type { DeviceCatalogExposure } from "@synapse/device-protocol"
import { SUBJECT_KIND } from "@synapse/shared"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { persistCatalogSync } from "./repo.js"

function uniq(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

async function seedWorkspace(
  db: Kysely<any>
): Promise<{ workspaceId: string; userId: string }> {
  const user = await db
    .insertInto("users")
    .values({ email: `${uniq("u")}@pcs`, name: "u" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({ ownerId: user.id, slug: uniq("ws"), name: "pcs ws" })
    .returning("id")
    .executeTakeFirstOrThrow()
  return { workspaceId: ws.id as string, userId: user.id as string }
}

/** A single filesystem exposure with one tool — the minimal api-authored catalog. */
function fsExposures(): DeviceCatalogExposure[] {
  return [
    {
      stable_key: "synapse.builtin.filesystem.v1",
      display_name: "Filesystem",
      transport: "builtin",
      builtin_kind: "filesystem",
      tools: [
        {
          stable_key: "synapse.builtin.filesystem.fs_read",
          name: "fs_read",
          description: "read a file",
          input_schema: { type: "object" },
        },
      ],
    },
  ]
}

test("S0: a device-less (kind='sandbox') runtime persists an api-authored catalog through the REAL persistCatalogSync, owner-less", async () => {
  await withTestDb(async (db) => {
    const { workspaceId } = await seedWorkspace(db)
    // kind='sandbox' runtime — NO devices row (the whole point).
    const runtimeId = randomUUID()
    await db
      .insertInto("runtimes")
      .values({ id: runtimeId, workspaceId, kind: "sandbox" })
      .execute()
    // A real bare_dataplane service (schema CHECK: data_plane_endpoint NOT NULL,
    // tunnel_path_token / current_session_id / remote_agent_machine_id NULL).
    const svc = await db
      .insertInto("runtimeServices")
      .values({
        runtimeId,
        serviceKind: "bare_dataplane",
        status: "online",
        dataPlaneEndpoint: `inprocess:${runtimeId}`,
        transport: "direct",
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    const serviceId = svc.id as string

    const result = await persistCatalogSync({
      runtimeId: runtimeId,
      serviceId,
      exposures: fsExposures(),
      executor: db,
    })

    assert.equal(result.exposureCount, 1, "one exposure persisted")
    const assigned = result.assignedIds["synapse.builtin.filesystem.v1"]
    assert.ok(assigned, "assignedIds keyed by stable_key")
    assert.ok(
      assigned.tools["fs_read"]?.runtime_tool_id,
      "tool id minted for the fork's target-id check"
    )

    // Exposure actually landed on the runtime.
    const exp = await db
      .selectFrom("runtimeExposures")
      .select(["id", "workspaceId", "runtimeStatus"])
      .where("runtimeId", "=", runtimeId)
      .executeTakeFirstOrThrow()
    assert.equal(exp.workspaceId, workspaceId)
    assert.equal(exp.runtimeStatus, "healthy")

    // The capability resource is owner-less (bare capability has no owner).
    const cap = await db
      .selectFrom("runtimeCapabilities as dc")
      .innerJoin("workspaceResources as wr", "wr.id", "dc.id")
      .select(["wr.ownerSubjectId", "wr.createdBySubjectId"])
      .where("dc.exposureId", "=", assigned.runtime_exposure_id)
      .executeTakeFirstOrThrow()
    assert.equal(
      cap.ownerSubjectId,
      null,
      "bare-sandbox capability is owner-less (owner_subject_id NULL)"
    )
    // created by the platform subject (no human), not owner-derived.
    const platformSubject = await upsertAccessSubject(db, {
      kind: SUBJECT_KIND.PLATFORM,
    })
    assert.equal(cap.createdBySubjectId, platformSubject)
  })
})

test("A7: persistCatalogSync owner attribution for a real device is byte-identical (LEFT JOIN superset carries the device owner)", async () => {
  await withTestDb(async (db) => {
    const { workspaceId, userId } = await seedWorkspace(db)
    const member = await db
      .insertInto("workspaceMembers")
      .values({ workspaceId, userId } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    const memberId = member.id as string

    // kind='device' runtime + its devices detail row with an explicit owner.
    const runtimeId = randomUUID()
    await db
      .insertInto("runtimes")
      .values({ id: runtimeId, workspaceId, kind: "device" })
      .execute()
    await db
      .insertInto("devices")
      .values({
        id: runtimeId,
        workspaceId,
        ownerWorkspaceMemberId: memberId,
        title: "Workstation",
        platform: "linux",
        arch: "x64",
        publicKey: "pk",
        publicKeyFingerprint: uniq("fp"),
      } as any)
      .execute()
    const svc = await db
      .insertInto("runtimeServices")
      .values({
        runtimeId,
        serviceKind: "device_runtime",
        status: "online",
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()

    const result = await persistCatalogSync({
      runtimeId: runtimeId,
      serviceId: svc.id as string,
      exposures: fsExposures(),
      executor: db,
    })
    const assigned = result.assignedIds["synapse.builtin.filesystem.v1"]!

    const cap = await db
      .selectFrom("runtimeCapabilities as dc")
      .innerJoin("workspaceResources as wr", "wr.id", "dc.id")
      .select(["wr.ownerSubjectId"])
      .where("dc.exposureId", "=", assigned.runtime_exposure_id)
      .executeTakeFirstOrThrow()
    // owner_subject_id is the WORKSPACE_MEMBER access-subject wrapping the
    // backing device's owner member (byte-identical owner attribution).
    const ownerMemberSubject = await upsertAccessSubject(db, {
      kind: SUBJECT_KIND.WORKSPACE_MEMBER,
      workspaceMemberId: memberId,
    } as any)
    assert.ok(cap.ownerSubjectId, "device capability has an owner")
    assert.equal(
      cap.ownerSubjectId,
      ownerMemberSubject,
      "device capability inherits the backing device's owner (byte-identical to pre-P4a)"
    )
  })
})

test("S0: persistCatalogSync rejects a missing or soft-deleted runtime", async () => {
  await withTestDb(async (db) => {
    const { workspaceId } = await seedWorkspace(db)
    // never-existed runtime id
    await assert.rejects(
      persistCatalogSync({
        runtimeId: randomUUID(),
        serviceId: randomUUID(),
        exposures: fsExposures(),
        executor: db,
      }),
      /runtime .* not found/
    )
    // soft-deleted runtime (deleted_at set) must also be refused. Insert the
    // service while the runtime is still live (the sd_fk_live trigger forbids
    // attaching a service to a soft-deleted runtime), THEN soft-delete.
    const runtimeId = randomUUID()
    await db
      .insertInto("runtimes")
      .values({ id: runtimeId, workspaceId, kind: "sandbox" })
      .execute()
    const svc = await db
      .insertInto("runtimeServices")
      .values({
        runtimeId,
        serviceKind: "bare_dataplane",
        status: "online",
        dataPlaneEndpoint: `inprocess:${runtimeId}`,
        transport: "direct",
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    await db
      .updateTable("runtimes")
      .set({ deletedAt: new Date() } as any)
      .where("id", "=", runtimeId)
      .execute()
    await assert.rejects(
      persistCatalogSync({
        runtimeId: runtimeId,
        serviceId: svc.id as string,
        exposures: fsExposures(),
        executor: db,
      }),
      /runtime .* not found/
    )
  })
})
