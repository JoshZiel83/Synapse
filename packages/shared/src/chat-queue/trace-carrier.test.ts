import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { dateToIsoInstant } from "../datetime/index.js"
import type { Timestamp } from "../types/index.js"
import {
  CHAT_QUEUE_TRACE_CARRIER_MAX_AGE_MS,
  createEmptyStoredChatQueueState,
  normalizeStoredChatQueueState,
  replayTraceHeaders,
  sanitizeQueueEntryCarrier,
  type PendingConversationRead,
  type PendingOutboxMessage,
  type StoredChatQueueState,
} from "./index.js"

const WS = "11111111-1111-1111-1111-111111111111"
const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
// Timestamp is a branded IsoInstantString — brand it via the canonical converter.
const CREATED: Timestamp = dateToIsoInstant(
  new Date("2026-07-21T00:00:00.000Z")
)
const NOW = new Date(CREATED).getTime()

describe("replayTraceHeaders", () => {
  it("replays a fresh, valid carrier as the traceparent header", () => {
    assert.deepEqual(replayTraceHeaders(VALID, CREATED, NOW + 60_000), {
      traceparent: VALID,
    })
  })

  it("drops a carrier at/over the 24h cap", () => {
    const stale = NOW + CHAT_QUEUE_TRACE_CARRIER_MAX_AGE_MS
    assert.deepEqual(replayTraceHeaders(VALID, CREATED, stale), {})
    assert.deepEqual(replayTraceHeaders(VALID, CREATED, stale + 1), {})
    // one ms under the cap still parents
    assert.deepEqual(replayTraceHeaders(VALID, CREATED, stale - 1), {
      traceparent: VALID,
    })
  })

  it("drops a malformed / all-zero / absent carrier", () => {
    assert.deepEqual(replayTraceHeaders("not-a-traceparent", CREATED, NOW), {})
    assert.deepEqual(
      replayTraceHeaders(
        "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
        CREATED,
        NOW
      ),
      {}
    )
    assert.deepEqual(replayTraceHeaders(undefined, CREATED, NOW), {})
  })

  it("drops a carrier with a missing or unparseable timestamp", () => {
    assert.deepEqual(replayTraceHeaders(VALID, undefined, NOW), {})
    // A persisted timestamp that survived IDB corrupt (typed Timestamp, but not
    // a real instant at runtime) — the finite-check guard drops it.
    assert.deepEqual(
      replayTraceHeaders(VALID, "garbage" as unknown as Timestamp, NOW),
      {}
    )
  })
})

describe("sanitizeQueueEntryCarrier", () => {
  const baseOutbox: PendingOutboxMessage = {
    clientMessageId: "m1",
    conversationId: "c1",
    contentBlocks: [],
    createdAt: CREATED,
    optimisticSequence: 1,
    status: "sending",
    attemptCount: 0,
  }

  it("preserves a valid carrier", () => {
    const entry = { ...baseOutbox, traceparent: VALID }
    assert.equal(sanitizeQueueEntryCarrier(entry).traceparent, VALID)
  })

  it("strips a malformed carrier and leaves the rest intact", () => {
    const entry = { ...baseOutbox, traceparent: "bogus" }
    const sanitized = sanitizeQueueEntryCarrier(entry)
    assert.equal(sanitized.traceparent, undefined)
    assert.equal(sanitized.clientMessageId, "m1")
  })

  it("is a no-op for an entry without a carrier", () => {
    const entry: PendingConversationRead = {
      conversationId: "c1",
      readUpToSequence: 3,
      lastVisibleSequence: 3,
      updatedAt: CREATED,
    }
    assert.equal(sanitizeQueueEntryCarrier(entry), entry)
  })
})

describe("normalizeStoredChatQueueState carrier handling", () => {
  it("wipes a non-v5 snapshot wholesale (clean break)", () => {
    const v4 = {
      version: 4,
      workspaceId: WS,
      inboxCursor: 7,
      pendingReads: {},
      outbox: { m1: { clientMessageId: "m1", conversationId: "c1" } },
      tombstones: {},
    }
    assert.deepEqual(
      normalizeStoredChatQueueState(WS, v4),
      createEmptyStoredChatQueueState(WS)
    )
  })

  it("keeps a valid carrier and strips a malformed one inside a v5 snapshot", () => {
    const v5: StoredChatQueueState = {
      version: 5,
      workspaceId: WS,
      inboxCursor: 0,
      pendingReads: {},
      outbox: {
        good: {
          clientMessageId: "good",
          conversationId: "c1",
          contentBlocks: [],
          createdAt: CREATED,
          optimisticSequence: 1,
          status: "sending",
          attemptCount: 0,
          traceparent: VALID,
        },
        bad: {
          clientMessageId: "bad",
          conversationId: "c1",
          contentBlocks: [],
          createdAt: CREATED,
          optimisticSequence: 2,
          status: "sending",
          attemptCount: 0,
          traceparent: "nope",
        },
      },
      tombstones: {},
    }

    const normalized = normalizeStoredChatQueueState(WS, v5)
    assert.equal(normalized.outbox.good?.traceparent, VALID)
    assert.equal(normalized.outbox.bad?.traceparent, undefined)
    assert.equal(normalized.outbox.bad?.clientMessageId, "bad")
  })
})
