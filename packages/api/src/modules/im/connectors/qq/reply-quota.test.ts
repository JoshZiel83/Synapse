import test from "node:test"
import assert from "node:assert/strict"
import { assertIsoInstant } from "@synapse/shared/datetime"
import {
  QQ_C2C_REPLY_WINDOW_SECONDS,
  QQ_GROUP_REPLY_WINDOW_SECONDS,
  reserveFirstSend,
} from "./reply-quota.js"
import type { QqLatestInboundAnchor } from "./latest-inbound-store.js"

// Minimal in-memory ioredis stub: we only exercise the Lua eval path of
// reserveFirstSend, so we simulate eval inline by mimicking the script's
// SET-NX + INCR + EXPIRE semantics.
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
  async eval(
    _script: string,
    _numKeys: number,
    reservationKey: string,
    quotaKey: string,
    anchorKind: string,
    anchorId: string,
    maxQuotaStr: string,
    ttlStr: string,
    nowIso: string,
    expiresAtMsStr: string,
    quotaTtlStr: string
  ): Promise<[number, string]> {
    const existing = this.store.get(reservationKey)
    if (existing && existing.expiresAt > Date.now()) {
      return [1, existing.value]
    }
    const maxQuota = Number(maxQuotaStr)
    const ttl = Number(ttlStr)
    const expiresAtMs = Number(expiresAtMsStr)
    const quotaTtl = Number(quotaTtlStr)
    const currentQuotaEntry = this.store.get(quotaKey)
    const currentQuotaCount = currentQuotaEntry
      ? Number(currentQuotaEntry.value)
      : 0
    if (currentQuotaCount >= maxQuota) {
      return [0, "quota_exhausted"]
    }
    const msgSeq = currentQuotaCount + 1
    const reservation = JSON.stringify({
      anchorKind,
      anchorId,
      msgSeq,
      reservedAt: nowIso,
      expiresAt: expiresAtMs,
    })
    this.store.set(reservationKey, {
      value: reservation,
      expiresAt: Date.now() + ttl * 1000,
    })
    this.store.set(quotaKey, {
      value: String(msgSeq),
      expiresAt: Date.now() + quotaTtl * 1000,
    })
    return [2, reservation]
  }
}

function makeAnchor(
  overrides: Partial<QqLatestInboundAnchor> = {}
): QqLatestInboundAnchor {
  return {
    anchorKind: "msg_id",
    anchorId: "MSG-1",
    eventType: "C2C_MESSAGE_CREATE",
    receivedAt: assertIsoInstant(new Date().toISOString()),
    ...overrides,
  }
}

test("reserveFirstSend: c2c expiresAt = receivedAt + 60min, not now() + 60min", async () => {
  const redis = new FakeRedis() as unknown as import("ioredis").Redis
  const receivedAtMs = Date.now() - 30 * 60_000 // 30 minutes ago
  const anchor = makeAnchor({
    receivedAt: assertIsoInstant(new Date(receivedAtMs).toISOString()),
  })
  const result = await reserveFirstSend(redis, {
    linkId: "link-c2c",
    accountId: "acc",
    endpointType: "direct",
    endpointExternalId: "c2c:U1",
    anchor,
  })
  assert.ok(result.ok)
  if (result.ok) {
    const expectedExpires = receivedAtMs + QQ_C2C_REPLY_WINDOW_SECONDS * 1000
    // Allow 5s slop for stub clock drift.
    assert.ok(
      Math.abs(result.reservation.expiresAt - expectedExpires) < 5000,
      `expected ~${expectedExpires}, got ${result.reservation.expiresAt}`
    )
  }
})

test("reserveFirstSend: group expiresAt anchored at receivedAt + 5min (regression P2.5)", async () => {
  const redis = new FakeRedis() as unknown as import("ioredis").Redis
  // Anchor received 4 min ago — should leave ~60s of window remaining,
  // not a fresh 5 min.
  const receivedAtMs = Date.now() - 4 * 60_000
  const anchor = makeAnchor({
    eventType: "GROUP_AT_MESSAGE_CREATE",
    receivedAt: assertIsoInstant(new Date(receivedAtMs).toISOString()),
  })
  const result = await reserveFirstSend(redis, {
    linkId: "link-grp",
    accountId: "acc",
    endpointType: "group",
    endpointExternalId: "GRP",
    anchor,
  })
  assert.ok(result.ok)
  if (result.ok) {
    const expectedExpires = receivedAtMs + QQ_GROUP_REPLY_WINDOW_SECONDS * 1000
    assert.ok(
      Math.abs(result.reservation.expiresAt - expectedExpires) < 5000,
      `expected ~${expectedExpires} (receivedAt + 5min), got ${result.reservation.expiresAt}`
    )
    // The remaining window should be ~60s, not 5min.
    const remainingMs = result.reservation.expiresAt - Date.now()
    assert.ok(
      remainingMs < 2 * 60_000,
      `remaining window ${remainingMs}ms should be < 2min`
    )
  }
})

test("reserveFirstSend: anchor already past its window → returns no_anchor", async () => {
  const redis = new FakeRedis() as unknown as import("ioredis").Redis
  const receivedAtMs = Date.now() - 10 * 60_000 // 10 min ago in group context
  const anchor = makeAnchor({
    eventType: "GROUP_AT_MESSAGE_CREATE",
    receivedAt: assertIsoInstant(new Date(receivedAtMs).toISOString()),
  })
  const result = await reserveFirstSend(redis, {
    linkId: "link-old",
    accountId: "acc",
    endpointType: "group",
    endpointExternalId: "GRP",
    anchor,
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, "no_anchor")
  }
})

test("reserveFirstSend: same linkId hits the existing-reservation early-return (replayed=true)", async () => {
  const redis = new FakeRedis() as unknown as import("ioredis").Redis
  const anchor = makeAnchor()
  const first = await reserveFirstSend(redis, {
    linkId: "link-replay",
    accountId: "acc",
    endpointType: "direct",
    endpointExternalId: "c2c:U1",
    anchor,
  })
  const second = await reserveFirstSend(redis, {
    linkId: "link-replay",
    accountId: "acc",
    endpointType: "direct",
    endpointExternalId: "c2c:U1",
    anchor,
  })
  assert.ok(first.ok)
  assert.ok(second.ok)
  if (first.ok && second.ok) {
    assert.equal(first.reservation.msgSeq, second.reservation.msgSeq)
    assert.equal(second.replayed, true)
  }
})
