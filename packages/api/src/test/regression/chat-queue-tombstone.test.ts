/**
 * Chat multi-client broadcast: lock in the new shared chat-queue contracts
 * introduced for reliable reconnect + removal correctness.
 *
 *  - v3 -> v4 migration is NON-destructive: outbox/pendingReads preserved,
 *    inboxCursor RESET to 0 (the old global sync_seq is meaningless under the
 *    new per-member member_seq cursor), tombstones added empty.
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

function v4(
  overrides: Partial<StoredChatQueueState> = {}
): StoredChatQueueState {
  return { ...createEmptyStoredChatQueueState(WS), ...overrides }
}

test("normalize migrates a v3 payload non-destructively, resetting cursor", () => {
  const legacyV3 = {
    version: 3,
    workspaceId: WS,
    workspaceMemberId: "m-1",
    inboxCursor: 9876, // old global sync_seq — must be discarded
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

  const migrated = normalizeStoredChatQueueState(WS, legacyV3)

  assert.equal(migrated.version, 4, "bumped to v4")
  assert.equal(migrated.inboxCursor, 0, "cursor reset (member_seq semantics)")
  assert.deepEqual(Object.keys(migrated.outbox), ["m1"], "outbox preserved")
  assert.deepEqual(
    Object.keys(migrated.pendingReads),
    ["c1"],
    "pendingReads preserved"
  )
  assert.deepEqual(migrated.tombstones, {}, "tombstones initialized empty")
})

test("normalize accepts a v4 payload incl. tombstones and keeps cursor", () => {
  const stored = v4({
    inboxCursor: 42,
    tombstones: { c9: { conversationId: "c9", removedSeq: 17 } },
  })
  const normalized = normalizeStoredChatQueueState(WS, stored)
  assert.equal(normalized.inboxCursor, 42, "v4 cursor preserved")
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
  assert.equal(normalized.version, 4)
})

test("merge preserves tombstones added in next (service-worker round-trip safe)", () => {
  const previous = v4()
  const current = v4()
  const next = v4({
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
  const previous = v4()
  const current = v4({
    tombstones: { c1: { conversationId: "c1", removedSeq: 5 } },
  })
  const next = v4({
    tombstones: { c1: { conversationId: "c1", removedSeq: 12 } },
  })
  const merged = mergeStoredQueueTransition(current, previous, next)
  assert.equal(merged.tombstones.c1.removedSeq, 12, "monotonic removedSeq")
})

test("merge honors tombstone CLEAR as a real change (re-add not resurrected)", () => {
  // previous had the tombstone; next dropped it (legitimate re-add cleared it).
  const previous = v4({
    tombstones: { c1: { conversationId: "c1", removedSeq: 8 } },
  })
  const current = v4({
    tombstones: { c1: { conversationId: "c1", removedSeq: 8 } },
  })
  const next = v4({ tombstones: {} })
  const merged = mergeStoredQueueTransition(current, previous, next)
  assert.deepEqual(
    merged.tombstones,
    {},
    "cleared tombstone is not merged back from current"
  )
})
