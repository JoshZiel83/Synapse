import test from "node:test"
import assert from "node:assert/strict"
import {
  clearQqWsSession,
  loadQqWsSession,
  saveQqWsSession,
} from "./session-store.js"

// Minimal in-memory ioredis stub: just enough for the session-store
// surface (get/set/del with NX/PX). Avoids ioredis-mock dep.
class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number }>()
  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key)
    if (!entry) return null
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.store.delete(key)
      return null
    }
    return entry.value
  }
  async set(key: string, value: string, ...args: unknown[]): Promise<"OK"> {
    let ttlMs = 0
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "PX" && typeof args[i + 1] === "number") {
        ttlMs = args[i + 1] as number
      }
    }
    this.store.set(key, {
      value,
      expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0,
    })
    return "OK"
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0
  }
}

test("save + load roundtrips with the original session state", async () => {
  const redis = new FakeRedis() as unknown as import("ioredis").Redis
  // Force-flush throttle by inserting a unique accountId for each test.
  await saveQqWsSession(redis, "acc-roundtrip-1", {
    sessionId: "sess-xyz",
    lastSeq: 42,
    appId: "APPID-A",
  })
  const loaded = await loadQqWsSession(redis, "acc-roundtrip-1", "APPID-A")
  assert.equal(loaded?.sessionId, "sess-xyz")
  assert.equal(loaded?.lastSeq, 42)
  assert.equal(loaded?.appId, "APPID-A")
  assert.ok(loaded?.savedAt)
})

test("loadQqWsSession returns null when appId mismatches and clears the row", async () => {
  const redis = new FakeRedis() as unknown as import("ioredis").Redis
  await saveQqWsSession(redis, "acc-rotated", {
    sessionId: "sess-stale",
    lastSeq: 7,
    appId: "OLD-APPID",
  })
  const loaded = await loadQqWsSession(redis, "acc-rotated", "NEW-APPID")
  assert.equal(loaded, null)
  // And the stale row is now gone.
  const reloaded = await loadQqWsSession(redis, "acc-rotated", "OLD-APPID")
  assert.equal(reloaded, null)
})

test("loadQqWsSession returns null on absent key", async () => {
  const redis = new FakeRedis() as unknown as import("ioredis").Redis
  const loaded = await loadQqWsSession(redis, "acc-missing", "APPID")
  assert.equal(loaded, null)
})

test("clearQqWsSession drops the row", async () => {
  const redis = new FakeRedis() as unknown as import("ioredis").Redis
  await saveQqWsSession(redis, "acc-clear", {
    sessionId: "s",
    lastSeq: 1,
    appId: "A",
  })
  await clearQqWsSession(redis, "acc-clear")
  const loaded = await loadQqWsSession(redis, "acc-clear", "A")
  assert.equal(loaded, null)
})

test("save respects throttle within 1s window (no Redis pounding)", async () => {
  const redis = new FakeRedis() as unknown as import("ioredis").Redis
  // First save sticks.
  await saveQqWsSession(redis, "acc-throttle", {
    sessionId: "s1",
    lastSeq: 1,
    appId: "A",
  })
  // Second save inside the throttle window is ignored.
  await saveQqWsSession(redis, "acc-throttle", {
    sessionId: "s2",
    lastSeq: 99,
    appId: "A",
  })
  const loaded = await loadQqWsSession(redis, "acc-throttle", "A")
  // We see the first save's value, not the second.
  assert.equal(loaded?.sessionId, "s1")
  assert.equal(loaded?.lastSeq, 1)
})
