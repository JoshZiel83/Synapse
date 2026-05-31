import test from "node:test"
import assert from "node:assert/strict"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import {
  addDeviceCapabilitiesForTarget,
  revokeDeviceCapabilitiesForTarget,
} from "./device-capabilities.js"

/**
 * Regression for the sandbox-grant clobber bug: addDeviceCapabilitiesForTarget
 * and revokeDeviceCapabilitiesForTarget must be ADDITIVE / TARGETED — they must
 * never disturb a pre-existing manual capability binding on the same
 * (actor, conversation) target, unlike the full-replace setter.
 *
 * Note: listActiveDeviceCapabilitiesForTarget reads the singleton db, so this
 * test asserts via a direct query on the test client instead.
 */

const NS = "dcap"
function rid(): string {
  return Math.random().toString(36).slice(2, 10)
}

async function seed(db: Kysely<any>) {
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
  const actor = await db
    .insertInto("actors")
    .values({
      workspace_id: ws.id,
      name: `a-${rid()}`,
      role: "assistant",
      title: "t",
      current_version: 1,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const member = await db
    .insertInto("workspace_members")
    .values({
      workspace_id: ws.id,
      user_id: user.id,
      trust_level: "member",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const conv = await db
    .insertInto("conversations")
    .values({
      workspace_id: ws.id,
      kind: "direct",
      title: "t",
      created_by_workspace_member_id: member.id,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  // Three device capabilities: one "pre-existing manual" + two "sandbox".
  async function newCapability() {
    const device = await db
      .insertInto("devices")
      .values({
        workspace_id: ws.id,
        title: `dev-${rid()}`,
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
    const exposure = await db
      .insertInto("device_exposures")
      .values({
        device_id: device.id,
        service_id: service.id,
        stable_key: `k-${rid()}`,
        display_name: "x",
        transport: "builtin",
        builtin_kind: "filesystem",
        runtime_status: "healthy",
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    const cap = await db
      .insertInto("device_capabilities")
      .values({
        workspace_id: ws.id,
        exposure_id: exposure.id,
        status: "active",
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    return cap.id as string
  }
  return {
    workspaceId: ws.id as string,
    actorId: actor.id as string,
    conversationId: conv.id as string,
    preExistingCap: await newCapability(),
    sandboxCap1: await newCapability(),
    sandboxCap2: await newCapability(),
  }
}

async function activeCapIds(
  db: Kysely<any>,
  workspaceId: string
): Promise<Set<string>> {
  const rows = await db
    .selectFrom("resource_access_bindings")
    .select("device_capability_id")
    .where("workspace_id", "=", workspaceId)
    .where("resource_type", "=", "device_capability")
    .where("status", "=", "active")
    .execute()
  return new Set(
    rows
      .map((r: any) => r.device_capability_id as string | null)
      .filter((v: string | null): v is string => v !== null)
  )
}

test("addDeviceCapabilitiesForTarget is additive; revoke is targeted", async () => {
  await withTestDb(async (db) => {
    const s = await seed(db)
    const target = {
      kind: "actor_in_conversation" as const,
      actorId: s.actorId,
      conversationId: s.conversationId,
    }

    // A pre-existing manual binding (e.g. an operator granted this capability).
    await addDeviceCapabilitiesForTarget(
      {
        workspaceId: s.workspaceId,
        target,
        deviceCapabilityIds: [s.preExistingCap],
        reason: "manual",
      },
      { db }
    )

    // Sandbox provision adds ITS capabilities — must NOT clobber the manual one.
    await addDeviceCapabilitiesForTarget(
      {
        workspaceId: s.workspaceId,
        target,
        deviceCapabilityIds: [s.sandboxCap1, s.sandboxCap2],
        reason: "sandbox provision",
      },
      { db }
    )

    let active = await activeCapIds(db, s.workspaceId)
    assert.ok(active.has(s.preExistingCap), "pre-existing survived provision")
    assert.ok(active.has(s.sandboxCap1))
    assert.ok(active.has(s.sandboxCap2))

    // Re-provision (idempotent): adding the same sandbox caps again is a no-op.
    await addDeviceCapabilitiesForTarget(
      {
        workspaceId: s.workspaceId,
        target,
        deviceCapabilityIds: [s.sandboxCap1, s.sandboxCap2],
      },
      { db }
    )
    const dupCount = await db
      .selectFrom("resource_access_bindings")
      .select((eb: any) => eb.fn.countAll().as("c"))
      .where("workspace_id", "=", s.workspaceId)
      .where("device_capability_id", "=", s.sandboxCap1)
      .where("status", "=", "active")
      .executeTakeFirstOrThrow()
    assert.equal(Number(dupCount.c), 1, "no duplicate active binding")

    // Sandbox teardown revokes ONLY its capabilities — the manual one survives.
    await revokeDeviceCapabilitiesForTarget(
      {
        workspaceId: s.workspaceId,
        target,
        deviceCapabilityIds: [s.sandboxCap1, s.sandboxCap2],
        reason: "sandbox teardown",
      },
      { db }
    )

    active = await activeCapIds(db, s.workspaceId)
    assert.ok(
      active.has(s.preExistingCap),
      "pre-existing manual binding survived sandbox teardown"
    )
    assert.ok(!active.has(s.sandboxCap1), "sandbox cap1 revoked")
    assert.ok(!active.has(s.sandboxCap2), "sandbox cap2 revoked")
  })
})
