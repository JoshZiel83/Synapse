/**
 * Tests for the per-message status claim factory.
 *
 * Validates the multi-replica contract: SETNX gives the claim to exactly
 * one replica; renew succeeds only for the holder; release is a no-op
 * if a different replica owns the slot.
 *
 * Uses a tiny in-memory Redis fake that mirrors the subset of the Redis
 * client surface our claim helpers touch (set with PX/NX, eval with the
 * compare-and-swap Lua scripts). The factory `createStatusClaimClient`
 * lets us inject the fake without touching the production binding.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { createStatusClaimClient, type ClaimRedisLike } from "./claim.js"

interface FakeEntry {
  value: string
  expiresAt: number
}

class FakeRedis implements ClaimRedisLike {
  private store = new Map<string, FakeEntry>()

  private collectExpired() {
    const now = Date.now()
    for (const [k, v] of this.store) {
      if (v.expiresAt <= now) this.store.delete(k)
    }
  }

  async set(
    key: string,
    value: string,
    _px: "PX",
    ttlMs: number,
    nx: "NX"
  ): Promise<"OK" | null> {
    this.collectExpired()
    if (nx === "NX" && this.store.has(key)) return null
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs })
    return "OK"
  }

  async eval(
    script: string,
    _numKeys: number,
    ...args: (string | number)[]
  ): Promise<number> {
    this.collectExpired()
    const key = String(args[0])
    const expected = String(args[1])
    const arg2 = args[2]
    const entry = this.store.get(key)
    if (!entry || entry.value !== expected) return 0
    if (script.includes("PEXPIRE")) {
      entry.expiresAt = Date.now() + Number(arg2)
      return 1
    }
    if (script.includes("DEL")) {
      this.store.delete(key)
      return 1
    }
    return 0
  }

  inject(key: string, value: string, ttlMs: number) {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs })
  }
}

function makeClient(opts: { ttlMs?: number; instanceId?: string } = {}) {
  const fake = new FakeRedis()
  const client = createStatusClaimClient(fake, {
    ttlMs: opts.ttlMs ?? 10_000,
    instanceId: opts.instanceId,
  })
  return { client, fake }
}

test("acquire: first caller wins, second caller gets null", async () => {
  const { client } = makeClient()
  const key = {
    transportAccountId: "acc-a",
    externalMessageId: "om_first_wins",
  }
  const t1 = await client.acquire(key)
  const t2 = await client.acquire(key)
  assert.ok(t1, "first acquire should return a token")
  assert.equal(t2, null, "second acquire on same key must get null")
})

test("acquire: two replicas race the same key — exactly one wins", async () => {
  // Simulate the multi-replica scenario: two ClaimClients with distinct
  // instance ids, both pointed at the same fake redis. They race on the
  // same (account, externalMessageId).
  const fake = new FakeRedis()
  const a = createStatusClaimClient(fake, {
    ttlMs: 10_000,
    instanceId: "replica-A",
  })
  const b = createStatusClaimClient(fake, {
    ttlMs: 10_000,
    instanceId: "replica-B",
  })
  const key = { transportAccountId: "acc-x", externalMessageId: "om_race" }
  const [r1, r2] = await Promise.all([a.acquire(key), b.acquire(key)])
  const wins = [r1, r2].filter((v) => v !== null)
  const losses = [r1, r2].filter((v) => v === null)
  assert.equal(wins.length, 1, "exactly one replica wins")
  assert.equal(losses.length, 1, "exactly one replica is rejected")
})

test("acquire: different externalMessageIds are independent", async () => {
  const { client } = makeClient()
  const t1 = await client.acquire({
    transportAccountId: "acc-b",
    externalMessageId: "om_x1",
  })
  const t2 = await client.acquire({
    transportAccountId: "acc-b",
    externalMessageId: "om_x2",
  })
  assert.ok(t1 && t2, "two different messages → two independent claims")
  assert.notEqual(t1, t2)
})

test("renew: token holder keeps the claim", async () => {
  const { client } = makeClient()
  const key = {
    transportAccountId: "acc-c",
    externalMessageId: "om_renew_holder",
  }
  const token = await client.acquire(key)
  assert.ok(token)
  const ok = await client.renew(key, token!)
  assert.equal(ok, true)
})

test("renew: non-holder returns false even when slot is occupied", async () => {
  const { client } = makeClient()
  const key = {
    transportAccountId: "acc-d",
    externalMessageId: "om_renew_other",
  }
  const holder = await client.acquire(key)
  assert.ok(holder)
  const ok = await client.renew(key, "some:other:replica:uuid")
  assert.equal(ok, false, "renew with wrong token must NOT extend the lease")
})

test("release: holder frees the slot so a new replica can take it", async () => {
  const { client } = makeClient()
  const key = {
    transportAccountId: "acc-e",
    externalMessageId: "om_release_holder",
  }
  const t1 = await client.acquire(key)
  await client.release(key, t1!)
  const t2 = await client.acquire(key)
  assert.ok(t2, "after release, next acquire should succeed")
})

test("release: non-holder is a safe no-op (does not free the holder's slot)", async () => {
  const { client } = makeClient()
  const key = {
    transportAccountId: "acc-f",
    externalMessageId: "om_release_other",
  }
  const holder = await client.acquire(key)
  await client.release(key, "bogus-token")
  const stealer = await client.acquire(key)
  assert.equal(
    stealer,
    null,
    "release with wrong token must NOT yield the slot"
  )
  assert.equal(await client.renew(key, holder!), true)
})

test("TTL: claim auto-expires so a crashed holder doesn't permanently own", async () => {
  const { client, fake } = makeClient({ ttlMs: 50 })
  const fakeKey = `im:status-claim:acc-g:om_ttl`
  fake.inject(fakeKey, "old:replica", 20)
  assert.equal(
    await client.acquire({
      transportAccountId: "acc-g",
      externalMessageId: "om_ttl",
    }),
    null,
    "still within TTL: no take-over"
  )
  await sleep(40)
  const taken = await client.acquire({
    transportAccountId: "acc-g",
    externalMessageId: "om_ttl",
  })
  assert.ok(taken, "after TTL expiry, new acquire wins")
})
