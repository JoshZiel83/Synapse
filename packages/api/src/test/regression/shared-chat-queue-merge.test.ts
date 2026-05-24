/**
 * S22 + S28: lock in the shared chat-queue merge behavior.
 *
 * Web's chat-store and the chat service worker both call
 * mergeStoredQueueTransition() to fold a queue-state snapshot from the
 * other thread back into the active state. Pre-S22 the implementation
 * lived in packages/web-next/lib/chat-persistence.ts and the worker
 * copied it; if the two drifted, the worker could silently overwrite
 * client-side pending reads/outbox entries. S22 moved the merger to
 * @synapse/shared so both consumers import the same function.
 *
 * These tests pin the semantics that matter for that contract:
 *  - workspace change blows away the prior state (no cross-workspace
 *    leakage)
 *  - workspace-member change inside the same workspace also resets
 *  - outbox entries the worker has dropped (present in `previous`, absent
 *    in `next`) are removed from the current state
 *  - outbox entries the worker has added/updated overwrite the current
 *    entry
 *  - pendingReads with a higher readUpToSequence in current than in
 *    previous are preserved when next drops them (last-writer-wins is
 *    skipped if a newer local read already exists)
 *  - inboxCursor is monotonic (Math.max)
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createEmptyStoredChatQueueState,
  mergeQueueStateForSave,
  mergeStoredQueueTransition,
  type ChatQueueStateLike,
  type StoredChatQueueState,
} from "@synapse/shared"

function baseState(
  workspaceId: string,
  overrides: Partial<StoredChatQueueState> = {}
): StoredChatQueueState {
  return {
    ...createEmptyStoredChatQueueState(workspaceId),
    ...overrides,
  }
}

test("merge: workspace change resets state to a fresh snapshot", () => {
  const current = baseState("ws-a", {
    workspaceMemberId: "wm-a",
    inboxCursor: 42,
    outbox: {
      "cm-1": {
        clientMessageId: "cm-1",
        conversationId: "conv-1",
        contentBlocks: [],
        createdAt: "2026-05-22T00:00:00.000Z",
        optimisticSequence: 1,
        status: "sending",
        attemptCount: 1,
      },
    },
  })
  const next = baseState("ws-b", { workspaceMemberId: "wm-b", inboxCursor: 1 })

  const merged = mergeStoredQueueTransition(current, null, next)
  assert.equal(merged.workspaceId, "ws-b")
  assert.deepEqual(merged.outbox, {})
  assert.deepEqual(merged.pendingReads, {})
  assert.equal(merged.inboxCursor, 1)
})

test("merge: workspace-member change in same workspace resets state", () => {
  const current = baseState("ws-a", {
    workspaceMemberId: "wm-a",
    inboxCursor: 7,
    outbox: {
      "cm-1": {
        clientMessageId: "cm-1",
        conversationId: "conv-1",
        contentBlocks: [],
        createdAt: "2026-05-22T00:00:00.000Z",
        optimisticSequence: 1,
        status: "sending",
        attemptCount: 1,
      },
    },
  })
  const next = baseState("ws-a", { workspaceMemberId: "wm-b" })

  const merged = mergeStoredQueueTransition(current, null, next)
  assert.deepEqual(merged.outbox, {})
})

test("merge: worker-dropped outbox entries get cleared from current", () => {
  const previous = baseState("ws-a", {
    outbox: {
      "cm-1": {
        clientMessageId: "cm-1",
        conversationId: "conv-1",
        contentBlocks: [],
        createdAt: "2026-05-22T00:00:00.000Z",
        optimisticSequence: 1,
        status: "sending",
        attemptCount: 1,
      },
    },
  })
  const current = baseState("ws-a", {
    outbox: previous.outbox,
  })
  const next = baseState("ws-a") // worker says: cm-1 is done

  const merged = mergeStoredQueueTransition(current, previous, next)
  assert.deepEqual(merged.outbox, {})
})

test("merge: pendingRead with higher local readUpTo survives a worker drop", () => {
  const previous = baseState("ws-a", {
    pendingReads: {
      "conv-1": {
        conversationId: "conv-1",
        readUpToSequence: 10,
        lastVisibleSequence: 10,
        updatedAt: "2026-05-22T00:00:00.000Z",
      },
    },
  })
  // Local state advanced the readUpTo to 20 while the worker was flushing
  // the snapshot at sequence 10.
  const current = baseState("ws-a", {
    pendingReads: {
      "conv-1": {
        conversationId: "conv-1",
        readUpToSequence: 20,
        lastVisibleSequence: 20,
        updatedAt: "2026-05-22T00:01:00.000Z",
      },
    },
  })
  const next = baseState("ws-a") // worker flushed and cleared the pending read

  const merged = mergeStoredQueueTransition(current, previous, next)
  assert.ok(
    merged.pendingReads["conv-1"],
    "newer local read must NOT be dropped just because the worker cleared the old one"
  )
  assert.equal(merged.pendingReads["conv-1"].readUpToSequence, 20)
})

test("merge: inboxCursor is monotonic across snapshots", () => {
  const current = baseState("ws-a", { inboxCursor: 100 })
  const next = baseState("ws-a", { inboxCursor: 50 })
  const merged = mergeStoredQueueTransition(current, null, next)
  assert.equal(merged.inboxCursor, 100)
})

// ----- S28: mergeQueueStateForSave (worker reconcile) -----

function mobileLike(
  workspaceId: string,
  overrides: Partial<ChatQueueStateLike> = {}
): ChatQueueStateLike {
  return {
    workspaceId,
    inboxCursor: 0,
    pendingReads: {},
    outbox: {},
    ...overrides,
  }
}

test("save-merge: worker-processed entries apply when UI hasn't touched them", () => {
  const base = mobileLike("ws-a", {
    pendingReads: {
      "conv-1": { conversationId: "conv-1", readUpToSequence: 5 },
    },
    outbox: {
      "cm-1": {
        clientMessageId: "cm-1",
        conversationId: "conv-1",
        status: "sending",
      },
    },
  })
  // Latest is identical to base — UI did not change anything during the
  // flush, so the processed result wins.
  const latest = mobileLike("ws-a", {
    pendingReads: base.pendingReads,
    outbox: base.outbox,
  })
  const processed = mobileLike("ws-a", {})

  const merged = mergeQueueStateForSave(base, latest, processed)
  assert.deepEqual(merged.pendingReads, {}, "worker cleared pending read")
  assert.deepEqual(merged.outbox, {}, "worker cleared outbox")
})

test("save-merge: locally-changed entry survives worker processing", () => {
  const base = mobileLike("ws-a", {
    pendingReads: {
      "conv-1": { conversationId: "conv-1", readUpToSequence: 5 },
    },
  })
  // UI advanced the read while the worker was flushing.
  const latest = mobileLike("ws-a", {
    pendingReads: {
      "conv-1": { conversationId: "conv-1", readUpToSequence: 12 },
    },
  })
  const processed = mobileLike("ws-a", {}) // worker cleared the old version

  const merged = mergeQueueStateForSave(base, latest, processed)
  assert.deepEqual(
    merged.pendingReads,
    { "conv-1": { conversationId: "conv-1", readUpToSequence: 12 } },
    "newer local read must survive the worker's drop"
  )
})

test("save-merge: inboxCursor is the max of latest and processed", () => {
  const base = mobileLike("ws-a")
  const latest = mobileLike("ws-a", { inboxCursor: 50 })
  const processed = mobileLike("ws-a", { inboxCursor: 120 })
  const merged = mergeQueueStateForSave(base, latest, processed)
  assert.equal(merged.inboxCursor, 120)
})
