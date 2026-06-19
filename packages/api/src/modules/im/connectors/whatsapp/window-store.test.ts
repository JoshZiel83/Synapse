import test from "node:test"
import assert from "node:assert/strict"
import { fromUnixMillis } from "@synapse/shared/datetime"
import {
  createWhatsappWindowStore,
  WHATSAPP_WINDOW_MS,
} from "./window-store.js"

/**
 * Minimal in-memory redis stub. Honors the `EX <ttl>` mode by recording the
 * mode + ttl per key (so the 48h-TTL contract can be asserted) and by
 * supporting an explicit expiry simulation (`expire`).
 */
function fakeRedis() {
  const store = new Map<string, string>()
  /** Last (mode, ttl) seen by `set`, per key. */
  const setArgs = new Map<string, { mode?: string; ttl?: number }>()
  return {
    store,
    setArgs,
    set: async (key: string, value: string, mode?: unknown, ttl?: unknown) => {
      store.set(key, value)
      setArgs.set(key, {
        ...(typeof mode === "string" ? { mode } : {}),
        ...(typeof ttl === "number" ? { ttl } : {}),
      })
      return "OK"
    },
    get: async (key: string) => store.get(key) ?? null,
    /** Test-only: simulate the key's TTL elapsing (key disappears). */
    expire: (key: string) => store.delete(key),
  }
}

test("window-store: isWithin24h is false before any inbound", async () => {
  const redis = fakeRedis()
  const ws = createWhatsappWindowStore(redis as never)
  assert.equal(
    await ws.isWithin24h({ accountId: "a", waId: "15551230000" }),
    false
  )
})

test("window-store: recordInbound opens the window; isWithin24h true just inside", async () => {
  const redis = fakeRedis()
  const ws = createWhatsappWindowStore(redis as never)
  const t0 = 1_700_000_000_000
  await ws.recordInbound({ accountId: "a", waId: "p", at: fromUnixMillis(t0) })
  // 1ms before the 24h edge → open.
  assert.equal(
    await ws.isWithin24h({
      accountId: "a",
      waId: "p",
      nowMs: t0 + WHATSAPP_WINDOW_MS - 1,
    }),
    true
  )
})

test("window-store: window is closed at/after the 24h boundary", async () => {
  const redis = fakeRedis()
  const ws = createWhatsappWindowStore(redis as never)
  const t0 = 1_700_000_000_000
  await ws.recordInbound({ accountId: "a", waId: "p", at: fromUnixMillis(t0) })
  assert.equal(
    await ws.isWithin24h({
      accountId: "a",
      waId: "p",
      nowMs: t0 + WHATSAPP_WINDOW_MS,
    }),
    false
  )
  assert.equal(
    await ws.isWithin24h({
      accountId: "a",
      waId: "p",
      nowMs: t0 + WHATSAPP_WINDOW_MS + 60_000,
    }),
    false
  )
})

test("window-store (WC-7/#36): recordInbound writes with EX = 48h (172800s)", async () => {
  // The 48h TTL is deliberately longer than the 24h window so a borderline
  // check still finds the timestamp and reports "closed" rather than "never
  // messaged". If the TTL were dropped/shortened, isWithin24h would start
  // returning false for keys that should report a recently-closed window. This
  // test fails on any code that omits the EX arg or uses the wrong TTL.
  const redis = fakeRedis()
  const ws = createWhatsappWindowStore(redis as never)
  const t0 = 1_700_000_000_000
  await ws.recordInbound({ accountId: "a", waId: "p", at: fromUnixMillis(t0) })
  const args = redis.setArgs.get("im:whatsapp:window:a:p")
  assert.equal(args?.mode, "EX")
  assert.equal(args?.ttl, 48 * 60 * 60)
  assert.equal(args?.ttl, 172800)
})

test("window-store (WC-7/#36): an expired window key reads back as 'never messaged' (false)", async () => {
  // Simulate the 48h TTL elapsing: the key vanishes, so isWithin24h must
  // report false (absent key → no positive evidence of an open window).
  const redis = fakeRedis()
  const ws = createWhatsappWindowStore(redis as never)
  const t0 = 1_700_000_000_000
  await ws.recordInbound({ accountId: "a", waId: "p", at: fromUnixMillis(t0) })
  assert.equal(
    await ws.isWithin24h({ accountId: "a", waId: "p", nowMs: t0 + 1 }),
    true
  )
  redis.expire("im:whatsapp:window:a:p")
  assert.equal(
    await ws.isWithin24h({ accountId: "a", waId: "p", nowMs: t0 + 1 }),
    false
  )
  assert.equal(await ws.getLastInboundMs({ accountId: "a", waId: "p" }), null)
})

test("window-store: keys are scoped per (account, waId)", async () => {
  const redis = fakeRedis()
  const ws = createWhatsappWindowStore(redis as never)
  const t0 = 1_700_000_000_000
  await ws.recordInbound({ accountId: "a", waId: "p1", at: fromUnixMillis(t0) })
  assert.equal(
    await ws.isWithin24h({ accountId: "a", waId: "p2", nowMs: t0 + 1 }),
    false
  )
  assert.equal(
    await ws.isWithin24h({ accountId: "b", waId: "p1", nowMs: t0 + 1 }),
    false
  )
  assert.equal(await ws.getLastInboundMs({ accountId: "a", waId: "p1" }), t0)
})
