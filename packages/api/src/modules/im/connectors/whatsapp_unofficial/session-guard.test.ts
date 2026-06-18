import test from "node:test"
import assert from "node:assert/strict"
import {
  AUTO_PAUSE_SECONDS,
  OPERATOR_PAUSE_SECONDS,
  clearSessionPause,
  getRemainingPauseMs,
  getSessionPause,
  isSessionPaused,
  pauseSession,
  pauseSessionOperator,
  setRedisForTest,
  type SessionGuardRedis,
} from "./session-guard.js"

class FakeRedis implements SessionGuardRedis {
  private store = new Map<string, { value: string; expiresAtMs: number }>()
  async set(
    key: string,
    value: string,
    _mode: "EX",
    seconds: number
  ): Promise<"OK"> {
    this.store.set(key, { value, expiresAtMs: Date.now() + seconds * 1000 })
    return "OK"
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0
  }
  async ttl(key: string): Promise<number> {
    const e = this.store.get(key)
    if (!e) return -2
    return Math.ceil((e.expiresAtMs - Date.now()) / 1000)
  }
  async exists(key: string): Promise<number> {
    return this.store.has(key) ? 1 : 0
  }
}

function withFakeRedis<T>(fn: (r: FakeRedis) => Promise<T>): Promise<T> {
  const r = new FakeRedis()
  const restore = setRedisForTest(r)
  return fn(r).finally(restore)
}

test("auto pause sets the flag with a reason; isSessionPaused reflects it", async () => {
  await withFakeRedis(async () => {
    assert.equal(await isSessionPaused("acc1"), false)
    await pauseSession("acc1", "logged_out")
    assert.equal(await isSessionPaused("acc1"), true)
    const pause = await getSessionPause("acc1")
    assert.equal(pause?.reason, "logged_out")
    assert.ok((pause?.remainingMs ?? 0) > 0)
    assert.ok((pause?.remainingMs ?? 0) <= AUTO_PAUSE_SECONDS * 1000)
  })
})

test("operator pause uses the operator reason + longer TTL", async () => {
  await withFakeRedis(async () => {
    await pauseSessionOperator("acc2")
    const pause = await getSessionPause("acc2")
    assert.equal(pause?.reason, "operator")
    assert.ok((pause?.remainingMs ?? 0) > AUTO_PAUSE_SECONDS * 1000)
    assert.ok((pause?.remainingMs ?? 0) <= OPERATOR_PAUSE_SECONDS * 1000)
  })
})

test("operator pause honors a custom ttl", async () => {
  await withFakeRedis(async () => {
    await pauseSessionOperator("acc3", 120)
    const ms = await getRemainingPauseMs("acc3")
    assert.ok(ms > 0 && ms <= 120_000)
  })
})

test("clearSessionPause removes the flag (operator kill-switch off)", async () => {
  await withFakeRedis(async () => {
    await pauseSessionOperator("acc4")
    assert.equal(await isSessionPaused("acc4"), true)
    await clearSessionPause("acc4")
    assert.equal(await isSessionPaused("acc4"), false)
    assert.equal(await getSessionPause("acc4"), null)
  })
})

test("getSessionPause tolerates a legacy/opaque value (treats as operator)", async () => {
  await withFakeRedis(async (r) => {
    await r.set("im:whatsapp_unofficial:session-paused:acc5", "12345", "EX", 60)
    const pause = await getSessionPause("acc5")
    assert.equal(pause?.reason, "operator")
  })
})
