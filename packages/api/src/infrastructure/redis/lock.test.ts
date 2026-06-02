import test from "node:test"
import assert from "node:assert/strict"
import { acquireLock, renewLock, releaseLock } from "./lock.js"
import type { LockRedisLike } from "./lock.js"

/**
 * Tiny in-memory Redis fake implementing just SET NX PX + the two Lua scripts
 * our lock uses (matched by substring, since we control the call sites).
 */
function makeFakeRedis(): LockRedisLike & {
  store: Map<string, string>
  forceExpire(key: string): void
} {
  const store = new Map<string, string>()
  return {
    store,
    forceExpire(key: string) {
      store.delete(key)
    },
    async set(key, value, _mode, _ttl, _nx) {
      if (store.has(key)) return null
      store.set(key, value)
      return "OK"
    },
    async eval(script, _numKeys, ...args) {
      const key = String(args[0])
      const token = String(args[1])
      const current = store.get(key)
      if (current !== token) return 0
      if (script.includes("PEXPIRE")) return 1 // renew: TTL noop in fake
      if (script.includes("DEL")) {
        store.delete(key)
        return 1
      }
      return 0
    },
  }
}

test("acquire returns a lock, second acquire is blocked", async () => {
  const redis = makeFakeRedis()
  const a = await acquireLock(redis, "k", 1000)
  assert.ok(a)
  const b = await acquireLock(redis, "k", 1000)
  assert.equal(b, null)
})

test("release frees the lock so it can be re-acquired", async () => {
  const redis = makeFakeRedis()
  const a = await acquireLock(redis, "k", 1000)
  assert.ok(a)
  await releaseLock(redis, a)
  const b = await acquireLock(redis, "k", 1000)
  assert.ok(b)
})

test("renew succeeds only while we hold the token", async () => {
  const redis = makeFakeRedis()
  const a = await acquireLock(redis, "k", 1000)
  assert.ok(a)
  assert.equal(await renewLock(redis, a, 1000), true)
})

test("FENCING: a stale holder cannot release a lock taken over by another", async () => {
  const redis = makeFakeRedis()
  const first = await acquireLock(redis, "k", 1000)
  assert.ok(first)
  // Simulate TTL expiry; a second worker acquires the same key.
  redis.forceExpire("k")
  const second = await acquireLock(redis, "k", 1000)
  assert.ok(second)
  assert.notEqual(first.token, second.token)
  // The stale first holder tries to release — must NOT delete second's lock.
  await releaseLock(redis, first)
  assert.equal(redis.store.get("k"), second.token)
  // And the stale holder cannot renew it either.
  assert.equal(await renewLock(redis, first, 1000), false)
})

test("tokens are unique per acquire", async () => {
  const redis = makeFakeRedis()
  const a = await acquireLock(redis, "k1", 1000)
  const b = await acquireLock(redis, "k2", 1000)
  assert.ok(a && b)
  assert.notEqual(a.token, b.token)
})
