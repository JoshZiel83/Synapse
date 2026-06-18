import test from "node:test"
import assert from "node:assert/strict"
import { fromUnixMillis } from "@synapse/shared/datetime"
import {
  createWhatsappWindowStore,
  WHATSAPP_WINDOW_MS,
} from "./window-store.js"

/** Minimal in-memory redis stub (only set/get with EX are exercised). */
function fakeRedis() {
  const store = new Map<string, string>()
  return {
    store,
    set: async (key: string, value: string, _ex?: unknown, _ttl?: unknown) => {
      store.set(key, value)
      return "OK"
    },
    get: async (key: string) => store.get(key) ?? null,
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
