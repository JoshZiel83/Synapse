import assert from "node:assert/strict"
import { test } from "node:test"

import {
  TurnCarrierCache,
  beginTurnForConversation,
  registerTurnCarrierCache,
} from "./turn-carriers.js"

function traceparentFor(n: number): string {
  return `00-${n.toString(16).padStart(32, "0")}-000000000000000f-01`
}

// ─── the cache's dedupe/cap primitives (moved from mcp-endpoint.test.ts) ─────

test("extend dedupes by trace id, rejects invalid values, and reports only new origins", () => {
  const cache = new TurnCarrierCache()
  const tpA = traceparentFor(0xa)
  const tpASibling = `00-${(0xa).toString(16).padStart(32, "0")}-00000000000000aa-01`
  const tpB = traceparentFor(0xb)

  assert.deepEqual(cache.extend([tpA, "garbage", null, undefined]), [tpA])
  // Same trace id (different span) is not new; a new trace is.
  assert.deepEqual(cache.extend([tpASibling, tpB]), [tpB])
  assert.deepEqual(cache.list(), [tpA, tpB])
})

test("extend caps at 20 origins, evicting oldest first", () => {
  const cache = new TurnCarrierCache()
  const all = Array.from({ length: 25 }, (_, i) => traceparentFor(i + 1))
  cache.extend(all)
  const kept = cache.list()
  assert.equal(kept.length, 20)
  assert.equal(kept[0], traceparentFor(6))
  assert.equal(kept[19], traceparentFor(25))
})

// ─── the turn epoch (F3 reverse-MCP half) ────────────────────────────────────

test("two beginTurn calls before any consumption MERGE (coalesced batches of one wake)", () => {
  const cache = new TurnCarrierCache()
  cache.beginTurn([traceparentFor(0x1)])
  cache.beginTurn([traceparentFor(0x2)])
  // No tools/call consumed the epoch between the two dispatches ⇒ both origins
  // belong to the one running turn.
  assert.deepEqual(cache.list(), [traceparentFor(0x1), traceparentFor(0x2)])
})

test("beginTurn after originsForToolCall() CLEARS (a new wake resets the turn)", () => {
  const cache = new TurnCarrierCache()
  cache.beginTurn([traceparentFor(0x1)])
  // A tools/call reads (and thereby consumes) the epoch.
  assert.deepEqual(cache.originsForToolCall(), [traceparentFor(0x1)])
  // The next dispatched wake opens a fresh turn — the prior origin is gone, so a
  // later tools/call links only the new turn's origins.
  cache.beginTurn([traceparentFor(0x2)])
  assert.deepEqual(cache.list(), [traceparentFor(0x2)])
})

// ─── the process-local registry the api's dispatch uses ──────────────────────

test("registry routes beginTurnForConversation to every live cache, and unregister stops it", () => {
  const AGENT = "00000000-0000-4000-8000-0000000000a0"
  const CONV = "00000000-0000-4000-8000-0000000000a1"
  const a = new TurnCarrierCache()
  const b = new TurnCarrierCache()
  const unregisterA = registerTurnCarrierCache(AGENT, CONV, a)
  const unregisterB = registerTurnCarrierCache(AGENT, CONV, b)

  // A conversation can have more than one live transport — a wake reaches all.
  beginTurnForConversation(AGENT, CONV, [traceparentFor(0x1)])
  assert.deepEqual(a.list(), [traceparentFor(0x1)])
  assert.deepEqual(b.list(), [traceparentFor(0x1)])

  // A different conversation is untouched (no-op when nothing is registered).
  beginTurnForConversation(AGENT, "other-conv", [traceparentFor(0x9)])
  assert.deepEqual(a.list(), [traceparentFor(0x1)])

  // Consume both epochs so the next wake would reset a live cache.
  a.originsForToolCall()
  b.originsForToolCall()
  unregisterB()
  beginTurnForConversation(AGENT, CONV, [traceparentFor(0x2)])
  assert.deepEqual(
    a.list(),
    [traceparentFor(0x2)],
    "still-registered cache resets to the new wake"
  )
  assert.deepEqual(
    b.list(),
    [traceparentFor(0x1)],
    "unregistered cache receives no further wake"
  )

  unregisterA()
  // No live cache under (AGENT, CONV) now — a further wake reaches nobody and
  // must not throw.
  beginTurnForConversation(AGENT, CONV, [traceparentFor(0x3)])
  assert.deepEqual(a.list(), [traceparentFor(0x2)])
})
