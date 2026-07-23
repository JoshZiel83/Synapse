import assert from "node:assert/strict"
import { test } from "node:test"

import {
  TurnCarrierCache,
  beginTurnForConversation,
  reconcileTurnForConversation,
  registerTurnCarrierCache,
} from "./turn-carriers.js"

function traceparentFor(n: number): string {
  return `00-${n.toString(16).padStart(32, "0")}-000000000000000f-01`
}

// ─── the cache's dedupe/cap primitives ───────────────────────────────────────
// Reads/extends target the daemon-confirmed RUNNING epoch, so a test that wants
// to observe origins first `reconcile`s to the epoch it is populating.

test("extend dedupes by trace id, rejects invalid values, and reports only new origins", () => {
  const cache = new TurnCarrierCache()
  cache.reconcile("E1")
  const tpA = traceparentFor(0xa)
  const tpASibling = `00-${(0xa).toString(16).padStart(32, "0")}-00000000000000aa-01`
  const tpB = traceparentFor(0xb)

  assert.deepEqual(cache.extend([tpA, "garbage", null, undefined]), [tpA])
  // Same trace id (different span) is not new; a new trace is.
  assert.deepEqual(cache.extend([tpASibling, tpB]), [tpB])
  assert.deepEqual(cache.list(), [tpA, tpB])
})

test("extend is a no-op returning [] when no turn is confirmed running", () => {
  const cache = new TurnCarrierCache()
  assert.deepEqual(cache.extend([traceparentFor(0xa)]), [])
  assert.deepEqual(cache.originsForToolCall(), [])
  assert.equal(cache.frontEpoch(), null)
})

test("a bucket caps at 20 origins, evicting oldest first", () => {
  const cache = new TurnCarrierCache()
  cache.reconcile("E1")
  const all = Array.from({ length: 25 }, (_, i) => traceparentFor(i + 1))
  cache.extend(all)
  const kept = cache.list()
  assert.equal(kept.length, 20)
  assert.equal(kept[0], traceparentFor(6))
  assert.equal(kept[19], traceparentFor(25))
})

// ─── the epoch model: reads follow the daemon-confirmed running epoch ─────────

test("originsForToolCall reads the running epoch, is stable and non-consuming", () => {
  const cache = new TurnCarrierCache()
  cache.beginTurn("E1", [traceparentFor(0x1), traceparentFor(0x2)])
  cache.reconcile("E1")
  // Repeated reads within the turn return the same origins (front advances only
  // via reconcile, never via a read).
  assert.deepEqual(cache.originsForToolCall(), [
    traceparentFor(0x1),
    traceparentFor(0x2),
  ])
  assert.deepEqual(cache.originsForToolCall(), [
    traceparentFor(0x1),
    traceparentFor(0x2),
  ])
})

test("beginTurn on a queued epoch does NOT change the running turn's reads (R3 interleave)", () => {
  const cache = new TurnCarrierCache()
  cache.beginTurn("E1", [traceparentFor(0x1)])
  cache.reconcile("E1")
  // A successor wake is dispatched (E2) while E1 is still the running turn: its
  // origins are buffered but MUST NOT leak into E1's reads.
  cache.beginTurn("E2", [traceparentFor(0x2)])
  assert.equal(cache.frontEpoch(), "E1")
  assert.deepEqual(cache.originsForToolCall(), [traceparentFor(0x1)])

  // Once the daemon fronts E2, reads follow — and E1's origin does not leak.
  cache.reconcile("E2")
  assert.equal(cache.frontEpoch(), "E2")
  assert.deepEqual(cache.originsForToolCall(), [traceparentFor(0x2)])
})

test("reconcile(string) drops NOTHING — a queued bucket behind a daemon-minted epoch survives to be fronted (finding B)", () => {
  const cache = new TurnCarrierCache()
  // The api dispatches E1 (bucket {tp1}). Before E1 runs, the daemon fronts a
  // bootstrap epoch the api opened no bucket for (agent:start before deliver).
  cache.beginTurn("E1", [traceparentFor(0x1)])
  cache.reconcile("daemon-bootstrap")
  // The bootstrap turn reads its own (empty) bucket — NOT E1's origin.
  assert.equal(cache.frontEpoch(), "daemon-bootstrap")
  assert.deepEqual(cache.originsForToolCall(), [])
  // The bootstrap turn ends; the daemon fronts E1. Its origin was never dropped.
  cache.reconcile("E1")
  assert.deepEqual(cache.originsForToolCall(), [traceparentFor(0x1)])
})

test("reconcile(null) points reads at nothing and never links a completed turn's origin (finding C)", () => {
  const cache = new TurnCarrierCache()
  cache.beginTurn("E1", [traceparentFor(0x1)])
  cache.reconcile("E1")
  assert.deepEqual(cache.originsForToolCall(), [traceparentFor(0x1)])

  // E1 completes; the daemon reports idle. A new wake E2 is dispatched but not
  // yet confirmed — a tools/call racing the next status must link NOTHING (never
  // the completed E1's origin).
  cache.reconcile(null)
  cache.beginTurn("E2", [traceparentFor(0x2)])
  assert.equal(cache.frontEpoch(), null)
  assert.deepEqual(cache.originsForToolCall(), [])

  // The daemon fronts E2; reads follow it (and E2's queued origin survived the
  // idle window).
  cache.reconcile("E2")
  assert.deepEqual(cache.originsForToolCall(), [traceparentFor(0x2)])
})

test("reconcile(undefined) is a no-op guard (malformed/foreign frame)", () => {
  const cache = new TurnCarrierCache()
  cache.beginTurn("E1", [traceparentFor(0x1)])
  cache.reconcile("E1")
  cache.reconcile(undefined)
  assert.equal(cache.frontEpoch(), "E1")
  assert.deepEqual(cache.originsForToolCall(), [traceparentFor(0x1)])
})

test("extend()'ing a queued successor's origin into the running bucket does NOT suppress its own future turn (dedup false-positive regression)", () => {
  const cache = new TurnCarrierCache()
  const tp1 = traceparentFor(0x1)
  const tp2 = traceparentFor(0x2)
  cache.beginTurn("E1", [tp1])
  cache.reconcile("E1")
  // The agent polls check_messages mid-turn and sees a newly-queued successor
  // delivery, so its origin is merged into the RUNNING (E1) bucket.
  cache.extend([tp2])
  // The api then dispatches that successor under its OWN epoch E2. E2 must open
  // its own bucket — the running bucket already holding tp2 is NOT proof of a
  // re-delivery, so no dedup may suppress it.
  cache.beginTurn("E2", [tp2])
  cache.reconcile("E2")
  assert.deepEqual(
    cache.originsForToolCall(),
    [tp2],
    "the successor's own turn links its origin — not lost to a false dedup"
  )
})

test("cap eviction drops COMPLETED turns before a never-fronted queued turn, and bounds memory", () => {
  const cache = new TurnCarrierCache()
  const tpQ = traceparentFor(0xffff)
  // A real successor turn is dispatched and QUEUED behind the running turn.
  cache.beginTurn("E-queued", [tpQ])
  // Churn: many turns run to completion (each fronted, then superseded by the
  // next) while E-queued waits — well past the 128 cap. Only finished turns are
  // evicted, so the still-queued turn survives to be fronted.
  for (let i = 0; i < 300; i++) {
    cache.beginTurn(`E-${i}`, [traceparentFor(0x10000 + i)])
    cache.reconcile(`E-${i}`)
  }
  cache.reconcile("E-queued")
  assert.deepEqual(
    cache.originsForToolCall(),
    [tpQ],
    "the queued turn's origin outlived the completed-turn churn"
  )
  // The whole point of the cap: retained buckets stay bounded (a leak in
  // eviction would ship green without this — there is no other size observer).
  assert.ok(
    cache.bucketCount() <= 129, // MAX_TURN_BUCKETS (128) + the transient pre-evict slot
    `retained buckets (${cache.bucketCount()}) stay within the memory bound`
  )
})

test("MAX_TURN_BUCKETS eviction never removes the confirmed running bucket (finding A)", () => {
  const cache = new TurnCarrierCache()
  cache.beginTurn("E0", [traceparentFor(0x1)])
  cache.reconcile("E0") // E0 is the (oldest) running bucket
  // Open 300 distinct-origin buckets — well past the 128 cap. Eviction must skip
  // the running E0 even though it is the oldest key.
  for (let i = 0; i < 300; i++) {
    cache.beginTurn(`E-${i}`, [traceparentFor(0x1000 + i)])
  }
  assert.equal(cache.frontEpoch(), "E0")
  assert.deepEqual(
    cache.originsForToolCall(),
    [traceparentFor(0x1)],
    "the running bucket survived overflow eviction"
  )
  assert.ok(
    cache.bucketCount() <= 129,
    `eviction bounds retained buckets (${cache.bucketCount()})`
  )
})

// ─── the process-local registry the api's dispatch + reconcile use ────────────

test("registry routes beginTurn/reconcile to every live cache, and unregister stops it", () => {
  const AGENT = "00000000-0000-4000-8000-0000000000a0"
  const CONV = "00000000-0000-4000-8000-0000000000a1"
  const a = new TurnCarrierCache()
  const b = new TurnCarrierCache()
  const unregisterA = registerTurnCarrierCache(AGENT, CONV, a)
  const unregisterB = registerTurnCarrierCache(AGENT, CONV, b)

  // A conversation can have more than one live transport — a wake + its reconcile
  // reach all of them.
  beginTurnForConversation(AGENT, CONV, "E1", [traceparentFor(0x1)])
  reconcileTurnForConversation(AGENT, CONV, "E1")
  assert.deepEqual(a.list(), [traceparentFor(0x1)])
  assert.deepEqual(b.list(), [traceparentFor(0x1)])

  // A different conversation is untouched (no-op when nothing is registered).
  beginTurnForConversation(AGENT, "other-conv", "E9", [traceparentFor(0x9)])
  reconcileTurnForConversation(AGENT, "other-conv", "E9")
  assert.deepEqual(a.list(), [traceparentFor(0x1)])

  // Unregister B, then dispatch + front a NEW turn: only the still-registered
  // cache advances.
  unregisterB()
  beginTurnForConversation(AGENT, CONV, "E2", [traceparentFor(0x2)])
  reconcileTurnForConversation(AGENT, CONV, "E2")
  assert.deepEqual(
    a.list(),
    [traceparentFor(0x2)],
    "still-registered cache follows the new running turn"
  )
  assert.deepEqual(
    b.list(),
    [traceparentFor(0x1)],
    "unregistered cache receives no further wake or reconcile"
  )

  unregisterA()
  // No live cache under (AGENT, CONV) now — a further wake/reconcile reaches
  // nobody and must not throw.
  beginTurnForConversation(AGENT, CONV, "E3", [traceparentFor(0x3)])
  reconcileTurnForConversation(AGENT, CONV, "E3")
  assert.deepEqual(a.list(), [traceparentFor(0x2)])
})
