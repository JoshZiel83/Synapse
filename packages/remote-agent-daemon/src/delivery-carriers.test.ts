import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buildFailDeliveriesReport,
  DeliveryCarrierMap,
  dedupeCarriersByTraceId,
  singleTraceScope,
} from "./delivery-carriers.js"
import type { TraceCarrier } from "./trace-context.js"

function tp(n: number, span = 1): string {
  const traceId = n.toString(16).padStart(32, "0")
  const spanId = span.toString(16).padStart(16, "0")
  return `00-${traceId}-${spanId}-01`
}

function carrier(n: number, span = 1, tracestate?: string): TraceCarrier {
  return tracestate
    ? { traceparent: tp(n, span), tracestate }
    : { traceparent: tp(n, span) }
}

test("scopeFor: single-origin batch yields that carrier; mixed origins yield undefined", () => {
  const map = new DeliveryCarrierMap()
  // The C3a fan-in repro: [dA:trace-A, dB:trace-B] in one batch.
  map.set("dA", carrier(0xa))
  map.set("dB", carrier(0xb))
  assert.equal(map.scopeFor(["dA", "dB"]), undefined)
  assert.deepEqual(map.scopeFor(["dA"]), carrier(0xa))
  assert.deepEqual(map.scopeFor(["dB"]), carrier(0xb))

  // Same trace, different spans (two deliveries of one request) ⇒ ONE scope.
  map.set("dC1", carrier(0xc, 1))
  map.set("dC2", carrier(0xc, 2))
  assert.deepEqual(map.scopeFor(["dC1", "dC2"]), carrier(0xc, 1))

  // Untraced/evicted ids do not veto a single present origin.
  assert.deepEqual(map.scopeFor(["dA", "untraced"]), carrier(0xa))
  assert.equal(map.scopeFor(["untraced"]), undefined)
})

test("set ignores untraced deliveries and delete/clear drop entries", () => {
  const map = new DeliveryCarrierMap()
  map.set("d1", undefined)
  assert.equal(map.size, 0)
  map.set("d2", carrier(2))
  assert.equal(map.size, 1)
  map.delete("d2")
  assert.equal(map.size, 0)
  map.set("d3", carrier(3))
  map.clear()
  assert.equal(map.size, 0)
  assert.equal(map.get("d3"), undefined)
})

test("FIFO cap: 1100 deliveries keep the map at <= 1024, evicting oldest first", () => {
  const map = new DeliveryCarrierMap()
  for (let i = 0; i < 1100; i++) {
    map.set(`d${i}`, carrier(i + 1))
  }
  assert.equal(map.size, 1024)
  // The first 76 inserted entries were evicted; the newest survive.
  assert.equal(map.get("d0"), undefined)
  assert.equal(map.get("d75"), undefined)
  assert.deepEqual(map.get("d76"), carrier(77))
  assert.deepEqual(map.get("d1099"), carrier(1100))
})

test("re-insert overwrites the carrier AND refreshes the FIFO position (re-notified deliveries evict last)", () => {
  const map = new DeliveryCarrierMap(4)
  map.set("d1", carrier(1))
  map.set("d2", carrier(2))
  map.set("d3", carrier(3))
  // Re-notified delivery: NEW carrier replaces the old one...
  map.set("d1", carrier(0x11, 2, "es=fresh"))
  assert.deepEqual(map.get("d1"), carrier(0x11, 2, "es=fresh"))
  // ...and the re-insert moved d1 to the FIFO tail, so pushing over the cap
  // evicts the TRUE oldest (d2) while the re-inserted d1 survives.
  map.set("d4", carrier(4))
  map.set("d5", carrier(5))
  assert.equal(map.size, 4)
  assert.equal(map.get("d2"), undefined, "true-oldest d2 is evicted")
  assert.deepEqual(
    map.get("d3"),
    carrier(3),
    "d3 outlives the tail-refreshed d1's old slot"
  )
  assert.deepEqual(map.get("d1"), carrier(0x11, 2, "es=fresh"))
  assert.deepEqual(map.get("d5"), carrier(5))

  // A deleted-then-re-set id behaves as fresh (tail position, new carrier).
  map.delete("d1")
  assert.equal(map.get("d1"), undefined)
  map.set("d1", carrier(0x12))
  map.set("d6", carrier(6))
  assert.deepEqual(map.get("d1"), carrier(0x12), "re-set after delete is fresh")
})

test("collect returns only present carriers in id order", () => {
  const map = new DeliveryCarrierMap()
  map.set("d1", carrier(1))
  map.set("d3", carrier(3))
  assert.deepEqual(map.collect(["d1", "d2", "d3"]), [carrier(1), carrier(3)])
})

test("singleTraceScope handles empty/mixed lists", () => {
  assert.equal(singleTraceScope([]), undefined)
  assert.deepEqual(singleTraceScope([carrier(1)]), carrier(1))
  assert.equal(singleTraceScope([carrier(1), carrier(2)]), undefined)
})

// ─── buildFailDeliveriesReport (§4.C — the fail-deliveries body assembly) ───

test("buildFailDeliveriesReport: C3a repro — a 2-origin batch carries BOTH carriers verbatim, scope undefined", () => {
  const map = new DeliveryCarrierMap()
  map.set("dA", carrier(0xa, 1, "es=a"))
  map.set("dB", carrier(0xb))
  const { deliveries, scope } = buildFailDeliveriesReport(map, ["dA", "dB"])
  assert.deepEqual(deliveries, [
    { delivery_id: "dA", traceparent: tp(0xa), tracestate: "es=a" },
    { delivery_id: "dB", traceparent: tp(0xb) },
  ])
  assert.equal(
    scope,
    undefined,
    "mixed origins ⇒ the POST itself runs untraced (fresh api-side root)"
  )
  // Pure: assembling the report must not consume the map (the caller deletes).
  assert.deepEqual(map.get("dA"), carrier(0xa, 1, "es=a"))
})

test("buildFailDeliveriesReport: single-origin batch ⇒ scope present; untraced ids ⇒ bare {delivery_id}", () => {
  const map = new DeliveryCarrierMap()
  map.set("d1", carrier(0xc, 1))
  map.set("d2", carrier(0xc, 2))
  const { deliveries, scope } = buildFailDeliveriesReport(map, [
    "d1",
    "d2",
    "untraced",
  ])
  assert.deepEqual(deliveries, [
    { delivery_id: "d1", traceparent: tp(0xc, 1) },
    { delivery_id: "d2", traceparent: tp(0xc, 2) },
    { delivery_id: "untraced" },
  ])
  assert.deepEqual(
    scope,
    carrier(0xc, 1),
    "one distinct origin trace ⇒ the POST is parented (untraced ids don't veto)"
  )
  assert.equal(
    "tracestate" in deliveries[0]!,
    false,
    "no tracestate key when the carrier has none"
  )
})

test("buildFailDeliveriesReport: fully-untraced batch ⇒ bare ids, no scope", () => {
  const map = new DeliveryCarrierMap()
  const { deliveries, scope } = buildFailDeliveriesReport(map, ["x", "y"])
  assert.deepEqual(deliveries, [{ delivery_id: "x" }, { delivery_id: "y" }])
  assert.equal(scope, undefined)
})

test("dedupeCarriersByTraceId dedupes by trace id and caps at 20", () => {
  const sameTrace = [carrier(1, 1, "es=a"), carrier(1, 2, "es=b"), carrier(2)]
  const deduped = dedupeCarriersByTraceId(sameTrace)
  assert.equal(deduped.length, 2)
  // First carrier per trace wins (keeps its tracestate).
  assert.deepEqual(deduped[0], carrier(1, 1, "es=a"))
  assert.deepEqual(deduped[1], carrier(2))

  const many = Array.from({ length: 30 }, (_, i) => carrier(i + 1))
  assert.equal(dedupeCarriersByTraceId(many).length, 20)
})

test("dedupeCarriersByTraceId: 20 stale origins + 1 current keeps the CURRENT and drops the oldest (inverted F3)", () => {
  // Arrival-ordered: 20 stale historical origins, then the current turn's.
  const stale = Array.from({ length: 20 }, (_, i) => carrier(i + 1))
  const current = carrier(0xc0ffee)
  const deduped = dedupeCarriersByTraceId([...stale, current])
  assert.equal(deduped.length, 20)
  // The current turn's carrier survives; the oldest stale one (trace 1) is gone.
  assert.ok(
    deduped.some((c) => c.traceparent === current.traceparent),
    "the current turn's origin is kept"
  )
  assert.ok(
    !deduped.some((c) => c.traceparent === stale[0]!.traceparent),
    "the oldest stale origin is the one evicted"
  )
})
