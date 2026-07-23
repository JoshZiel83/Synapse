/**
 * Chat multi-client broadcast: lock in the shared chat-queue contracts for
 * reliable reconnect + removal correctness.
 *
 *  - NO back-compat: normalize accepts ONLY the current version (v5) and WIPES
 *    any earlier or unknown version wholesale (decisions ruling 9). The version
 *    bump is what guarantees no persisted entry predating the validated
 *    `traceparent` carrier field is ever read; the wipe of offline-queued
 *    messages is the documented consequence (R10 changelog).
 *  - tombstones survive the queue merge functions (so the service-worker
 *    round-trip can't strip them), and "clear" is honored as a real change.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createEmptyStoredChatQueueState,
  mergeStoredQueueTransition,
  normalizeStoredChatQueueState,
  type StoredChatQueueState,
} from "@synapse/shared"

const WS = "11111111-1111-1111-1111-111111111111"

// The current-version (v5) empty state with optional overrides.
function v5(
  overrides: Partial<StoredChatQueueState> = {}
): StoredChatQueueState {
  return { ...createEmptyStoredChatQueueState(WS), ...overrides }
}

test("normalize WIPES a pre-v5 (legacy) payload wholesale — no back-compat migration", () => {
  const legacyV3 = {
    version: 3,
    workspaceId: WS,
    workspaceMemberId: "m-1",
    inboxCursor: 9876,
    pendingReads: {
      c1: {
        conversationId: "c1",
        readUpToSequence: 5,
        lastVisibleSequence: 7,
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
    },
    outbox: {
      m1: {
        clientMessageId: "m1",
        conversationId: "c1",
        contentBlocks: [],
        createdAt: "2026-06-01T00:00:00.000Z",
        optimisticSequence: 1,
        status: "sending",
        attemptCount: 0,
      },
    },
  }

  const wiped = normalizeStoredChatQueueState(WS, legacyV3)

  // A persisted queue from any earlier version is discarded wholesale: an entry
  // predating the version bump may lack the validated `traceparent` field, and
  // the no-back-compat mandate forbids dual-shape reads.
  assert.deepEqual(
    wiped,
    createEmptyStoredChatQueueState(WS),
    "legacy payload is reset to a fresh v5 state"
  )
  assert.equal(wiped.version, 5)
  assert.equal(wiped.inboxCursor, 0)
  assert.deepEqual(wiped.outbox, {}, "legacy outbox is NOT preserved")
  assert.deepEqual(
    wiped.pendingReads,
    {},
    "legacy pendingReads is NOT preserved"
  )
  assert.deepEqual(wiped.tombstones, {})
})

test("normalize accepts a current (v5) payload incl. tombstones and keeps cursor", () => {
  const stored = v5({
    inboxCursor: 42,
    tombstones: { c9: { conversationId: "c9", removedSeq: 17 } },
  })
  const normalized = normalizeStoredChatQueueState(WS, stored)
  assert.equal(normalized.inboxCursor, 42, "v5 cursor preserved")
  assert.deepEqual(normalized.tombstones, {
    c9: { conversationId: "c9", removedSeq: 17 },
  })
})

test("normalize wipes an unknown version", () => {
  const normalized = normalizeStoredChatQueueState(WS, {
    version: 99,
    workspaceId: WS,
    inboxCursor: 5,
    pendingReads: {},
    outbox: {},
  })
  assert.equal(normalized.inboxCursor, 0)
  assert.equal(normalized.version, 5)
})

test("merge preserves tombstones added in next (service-worker round-trip safe)", () => {
  const previous = v5()
  const current = v5()
  const next = v5({
    tombstones: { c1: { conversationId: "c1", removedSeq: 10 } },
  })
  const merged = mergeStoredQueueTransition(current, previous, next)
  assert.deepEqual(
    merged.tombstones,
    { c1: { conversationId: "c1", removedSeq: 10 } },
    "tombstone written by next survives the merge"
  )
})

test("merge takes the higher removedSeq when both sides tombstone", () => {
  const previous = v5()
  const current = v5({
    tombstones: { c1: { conversationId: "c1", removedSeq: 5 } },
  })
  const next = v5({
    tombstones: { c1: { conversationId: "c1", removedSeq: 12 } },
  })
  const merged = mergeStoredQueueTransition(current, previous, next)
  assert.equal(merged.tombstones.c1.removedSeq, 12, "monotonic removedSeq")
})

test("merge honors tombstone CLEAR as a real change (re-add not resurrected)", () => {
  // previous had the tombstone; next dropped it (legitimate re-add cleared it).
  const previous = v5({
    tombstones: { c1: { conversationId: "c1", removedSeq: 8 } },
  })
  const current = v5({
    tombstones: { c1: { conversationId: "c1", removedSeq: 8 } },
  })
  const next = v5({ tombstones: {} })
  const merged = mergeStoredQueueTransition(current, previous, next)
  assert.deepEqual(
    merged.tombstones,
    {},
    "cleared tombstone is not merged back from current"
  )
})

test("a stale CLEAR does not delete a newer removal in current", () => {
  // current already holds a NEWER removal (seq 12, e.g. from another tab) than
  // the one this transition cleared (it cleared the seq-8 tombstone). The stale
  // clear must NOT delete the newer removal.
  const previous = v5({
    tombstones: { c1: { conversationId: "c1", removedSeq: 8 } },
  })
  const current = v5({
    tombstones: { c1: { conversationId: "c1", removedSeq: 12 } },
  })
  const next = v5({ tombstones: {} })
  const merged = mergeStoredQueueTransition(current, previous, next)
  assert.deepEqual(
    merged.tombstones,
    { c1: { conversationId: "c1", removedSeq: 12 } },
    "newer removal in current survives a stale clear"
  )
})
