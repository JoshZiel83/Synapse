import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
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
    .values({ email: `${rid()}@${NS}`, name: "u" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({ ownerId: user.id, slug: `ws-${rid()}`, name: `${NS} ws` })
    .returning("id")
    .executeTakeFirstOrThrow()
  const actorRoot = await db
    .insertInto("workspaceApps")
    .values({
      id: crypto.randomUUID(),
      workspaceId: ws.id,
      kind: "actor",
      displayName: `a-${rid()}`,
      status: "active",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const actor = await db
    .insertInto("actors")
    .values({
      id: actorRoot.id as string,
      role: "assistant",
      title: "t",
      currentVersion: 1,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const member = await db
    .insertInto("workspaceMembers")
    .values({
      workspaceId: ws.id,
      userId: user.id,
      trustLevel: "member",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const conv = await db
    .insertInto("conversations")
    .values({
      workspaceId: ws.id,
      kind: "direct",
      title: "t",
      createdByWorkspaceMemberId: member.id,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  // Three device capabilities: one "pre-existing manual" + two "sandbox".
  async function newCapability() {
    const device = await db
      .insertInto("devices")
      .values({
        workspaceId: ws.id,
        title: `dev-${rid()}`,
        publicKey: `pk-${rid()}`,
        publicKeyFingerprint: `fp-${rid()}`,
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    const service = await db
      .insertInto("deviceServices")
      .values({
        deviceId: device.id,
        serviceKind: "device_runtime",
        status: "online",
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    const exposure = await db
      .insertInto("deviceExposures")
      .values({
        deviceId: device.id,
        serviceId: service.id,
        stableKey: `k-${rid()}`,
        displayName: "x",
        transport: "builtin",
        builtinKind: "filesystem",
        runtimeStatus: "healthy",
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    const capId = crypto.randomUUID()
    await db
      .insertInto("workspaceApps")
      .values({
        id: capId,
        workspaceId: ws.id,
        kind: "device_capability",
        displayName: "x",
        status: "active",
      } as any)
      .execute()
    const cap = await db
      .insertInto("deviceCapabilities")
      .values({
        id: capId,
        exposureId: exposure.id,
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
    .selectFrom("workspaceAppGrants")
    .select("workspaceAppId")
    .where("workspaceId", "=", workspaceId)
    .where("status", "=", "active")
    .execute()
  return new Set(
    rows
      .map((r: any) => r.workspaceAppId as string | null)
      .filter((v: string | null): v is string => v !== null)
  )
}

test("addDeviceCapabilitiesForTarget is additive; revoke is targeted", async () => {
  await withTestDb(async (db) => {
    const s = await seed(db)
    const target = {
      kind: "actor" as const,
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
      .selectFrom("workspaceAppGrants")
      .select((eb) => eb.fn.countAll<string>().as("c"))
      .where("workspaceId", "=", s.workspaceId)
      .where("workspaceAppId", "=", s.sandboxCap1)
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
