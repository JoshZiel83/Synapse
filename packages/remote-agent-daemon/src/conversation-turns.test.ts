import assert from "node:assert/strict"
import { test } from "node:test"
import { ConversationTurns } from "./conversation-turns.js"
import { DeliveryCarrierMap } from "./delivery-carriers.js"
import {
  getTraceparent,
  runWithCarrier,
  type TraceCarrier,
} from "./trace-context.js"

function tp(n: number, span = 1): string {
  return `00-${n.toString(16).padStart(32, "0")}-${span
    .toString(16)
    .padStart(16, "0")}-01`
}
function carrier(n: number, span = 1): TraceCarrier {
  return { traceparent: tp(n, span) }
}

const CONV = "conv-1"
// A single running turn's epoch — the reads (scope/originCarriers/runInScope/
// scoped) all resolve against the FRONT epoch, so a one-turn conversation reads
// back exactly what was noted under this epoch.
const E1 = "epoch-1"
const E2 = "epoch-2"

test("noteDeliveries: 20 stale origins from previous turns + 1 current ⇒ origin_carriers CONTAINS the current one (inverted F3)", () => {
  const map = new DeliveryCarrierMap()
  const turns = new ConversationTurns(map)
  // One turn accumulates 21 distinct-origin deliveries (stale first, current
  // last). The turn set + dedupe both keep the newest.
  for (let i = 0; i < 20; i++) {
    map.set(`stale${i}`, carrier(i + 1))
    turns.noteDeliveries(CONV, E1, [`stale${i}`])
  }
  map.set("current", carrier(0xc0ffee))
  turns.noteDeliveries(CONV, E1, ["current"])

  const origins = turns.originCarriers(CONV)
  assert.equal(origins.length, 20)
  assert.ok(
    origins.some((c) => c.traceparent === tp(0xc0ffee)),
    "the current turn's origin is present"
  )
})

test("single-origin turn ⇒ scope = that carrier and runInScope exposes it", () => {
  const map = new DeliveryCarrierMap()
  const turns = new ConversationTurns(map)
  map.set("d1", carrier(0xa, 1))
  map.set("d2", carrier(0xa, 2)) // same trace, different span
  turns.noteDeliveries(CONV, E1, ["d1", "d2"])

  assert.deepEqual(turns.scope(CONV), carrier(0xa, 1))
  const observed = turns.runInScope(CONV, () => getTraceparent())
  assert.equal(observed, tp(0xa, 1))
})

test("mixed origins ⇒ scope undefined and runInScope MASKS an ambient carrier", () => {
  const map = new DeliveryCarrierMap()
  const turns = new ConversationTurns(map)
  map.set("dA", carrier(0xa))
  map.set("dB", carrier(0xb))
  turns.noteDeliveries(CONV, E1, ["dA", "dB"])

  assert.equal(turns.scope(CONV), undefined)
  // Even inside an ambient carrier scope, a mixed turn masks (never inherits).
  const observed = runWithCarrier(carrier(0x99), () =>
    turns.runInScope(CONV, () => getTraceparent())
  )
  assert.equal(observed, undefined)
})

test("noteDriver: a non-delivery driver carrier scopes the turn", () => {
  const map = new DeliveryCarrierMap()
  const turns = new ConversationTurns(map)
  turns.noteDriver(CONV, E1, carrier(0x7))
  assert.deepEqual(turns.scope(CONV), carrier(0x7))
  turns.noteDriver(CONV, E1, undefined) // untraced driver ⇒ no-op
  assert.deepEqual(turns.scope(CONV), carrier(0x7))
})

test("end() drops the turn's attribution", () => {
  const map = new DeliveryCarrierMap()
  const turns = new ConversationTurns(map)
  map.set("d1", carrier(0xa))
  turns.noteDeliveries(CONV, E1, ["d1"])
  assert.deepEqual(turns.scope(CONV), carrier(0xa))
  turns.end(CONV, E1)
  assert.equal(turns.frontEpoch(CONV), null)
  assert.equal(turns.scope(CONV), undefined)
  assert.deepEqual(turns.originCarriers(CONV), [])
})

test("scoped() applies the turn scope to the WHOLE callback body", () => {
  const map = new DeliveryCarrierMap()
  const turns = new ConversationTurns(map)
  map.set("d1", carrier(0xa))
  turns.noteDeliveries(CONV, E1, ["d1"])

  const observed: Array<string | undefined> = []
  const cb = turns.scoped((_conversationId: string, _tag: string) => {
    observed.push(getTraceparent())
  })
  cb(CONV, "first")
  cb(CONV, "second")
  assert.deepEqual(observed, [tp(0xa), tp(0xa)])

  // A different conversation with no turn ⇒ masked.
  const observedOther: Array<string | undefined> = []
  const cb2 = turns.scoped((_conversationId: string) => {
    observedOther.push(getTraceparent())
  })
  cb2("conv-2")
  assert.deepEqual(observedOther, [undefined])
})

test("completion-style pending reclamation does NOT clear the turn snapshot (R2 lifetime separation)", () => {
  // The turn snapshot survives when a delivery is 'completed' (reclaimed from
  // the functional pending set) — here modelled by leaving the ConversationTurns
  // snapshot untouched: only end() clears it.
  const map = new DeliveryCarrierMap()
  const turns = new ConversationTurns(map)
  map.set("driving", carrier(0xa))
  turns.noteDeliveries(CONV, E1, ["driving"])
  // Simulate a mid-turn completion of the driving delivery: index.ts drops it
  // from pendingDeliveryIds ONLY (not from turns/carriers), so the turn's origin
  // still resolves for the same turn's later user_input POST.
  assert.deepEqual(turns.scope(CONV), carrier(0xa))
  assert.deepEqual(turns.originCarriers(CONV), [carrier(0xa)])
})

test("FIFO: a queued turn B's origins never leak into the running turn A (R3 cross-trace fix)", () => {
  const map = new DeliveryCarrierMap()
  const turns = new ConversationTurns(map)
  // Turn A is running (front); turn B is dispatched-but-queued behind it. Each
  // owns its own epoch bucket, so the FRONT (running A) reads resolve to A only.
  map.set("dA", carrier(0xa))
  map.set("dB", carrier(0xb))
  turns.noteDeliveries(CONV, E1, ["dA"])
  turns.noteDeliveries(CONV, E2, ["dB"])

  assert.equal(turns.frontEpoch(CONV), E1)
  assert.deepEqual(turns.scope(CONV), carrier(0xa)) // A's single origin, NOT mixed
  assert.deepEqual(turns.originCarriers(CONV), [carrier(0xa)])

  // A completes: its bucket ends, the front advances to the queued B, whose own
  // origin now scopes the (now-running) turn.
  turns.end(CONV, E1)
  assert.equal(turns.frontEpoch(CONV), E2)
  assert.deepEqual(turns.scope(CONV), carrier(0xb))
})

test("end() of the running turn advances the front; end() of a queued turn leaves the front intact", () => {
  const map = new DeliveryCarrierMap()
  const turns = new ConversationTurns(map)
  map.set("dA", carrier(0xa))
  map.set("dB", carrier(0xb))
  turns.noteDeliveries(CONV, E1, ["dA"])
  turns.noteDeliveries(CONV, E2, ["dB"])

  // Dropping the QUEUED turn B (e.g. evicted from a full queue) must not disturb
  // the running turn A at the front.
  turns.end(CONV, E2)
  assert.equal(turns.frontEpoch(CONV), E1)
  assert.deepEqual(turns.scope(CONV), carrier(0xa))
})

test("endConversation() drops every turn of a conversation (session-death backstop)", () => {
  const map = new DeliveryCarrierMap()
  const turns = new ConversationTurns(map)
  map.set("dA", carrier(0xa))
  map.set("dB", carrier(0xb))
  turns.noteDeliveries(CONV, E1, ["dA"])
  turns.noteDeliveries(CONV, E2, ["dB"])

  turns.endConversation(CONV)
  assert.equal(turns.frontEpoch(CONV), null)
  assert.equal(turns.scope(CONV), undefined)
  assert.deepEqual(turns.originCarriers(CONV), [])
})
