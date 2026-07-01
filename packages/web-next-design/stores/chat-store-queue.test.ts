import { describe, expect, it } from "vitest"
import { assertIsoInstant } from "@synapse/shared/datetime"

import type {
  PendingConversationRead,
  PendingOutboxMessage,
} from "@synapse/shared"
import {
  clearConversationTombstone,
  rebaseQueueFieldsOntoLatest,
  shouldApplyDrainedSyncEvent,
  upsertConversationWithTombstoneGuard,
  type ChatQueueWorkspaceSnapshot,
} from "./chat-store-queue"

type Conversation = { conversationId: string; title?: string }
type Snapshot = ChatQueueWorkspaceSnapshot<Conversation>

const WS = "11111111-1111-1111-1111-111111111111"
const iso = (value: string) => assertIsoInstant(value)

function read(
  conversationId: string,
  readUpToSequence: number
): PendingConversationRead {
  return {
    conversationId,
    readUpToSequence,
    lastVisibleSequence: readUpToSequence,
    updatedAt: iso("2026-06-06T00:00:00.000Z"),
  }
}

function outbox(
  clientMessageId: string,
  conversationId = "c1"
): PendingOutboxMessage {
  return {
    clientMessageId,
    conversationId,
    contentBlocks: [],
    createdAt: iso("2026-06-06T00:00:00.000Z"),
    optimisticSequence: 1,
    status: "sending",
    attemptCount: 0,
  }
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    version: 4,
    workspaceId: WS,
    workspaceMemberId: "wm-1",
    clientInstanceId: "22222222-2222-4222-8222-222222222222",
    inboxCursor: 0,
    pendingReads: {},
    outbox: {},
    tombstones: {},
    conversations: [{ conversationId: "c1", title: "one" }],
    ...overrides,
  }
}

function upsert(conversations: Conversation[], incoming: Conversation) {
  return [
    ...conversations.filter(
      (conversation) => conversation.conversationId !== incoming.conversationId
    ),
    incoming,
  ]
}

describe("chat store queue race guards", () => {
  it("preserves outbox messages queued while a flush result is in flight", () => {
    const base = snapshot({
      outbox: {
        old: outbox("old"),
      },
    })
    const latest = snapshot({
      outbox: {
        old: outbox("old"),
        fresh: outbox("fresh"),
      },
    })
    const processed = snapshot({
      outbox: {},
    })

    const merged = rebaseQueueFieldsOntoLatest(base, latest, processed)

    expect(Object.keys(merged.outbox)).toEqual(["fresh"])
  })

  it("persists read ACK deletions as a previous-to-next transition", () => {
    const previous = snapshot({
      pendingReads: {
        c1: read("c1", 10),
      },
    })
    const afterAck = snapshot({
      pendingReads: {},
    })

    const merged = rebaseQueueFieldsOntoLatest(previous, previous, afterAck)

    expect(merged.pendingReads).toEqual({})
  })

  it("keeps a newer pending read queued while an older ACK is merged", () => {
    const base = snapshot({
      pendingReads: {
        c1: read("c1", 10),
      },
    })
    const latest = snapshot({
      pendingReads: {
        c1: read("c1", 20),
      },
    })
    const processed = snapshot({
      pendingReads: {},
    })

    const merged = rebaseQueueFieldsOntoLatest(base, latest, processed)

    expect(merged.pendingReads.c1?.readUpToSequence).toBe(20)
  })

  it("rebases the latest bootstrap timestamp from queue transitions", () => {
    const base = snapshot({
      lastBootstrappedAt: iso("2026-06-06T00:00:00.000Z"),
    })
    const latest = snapshot({
      lastBootstrappedAt: iso("2026-06-06T00:00:00.000Z"),
    })
    const processed = snapshot({
      lastBootstrappedAt: iso("2026-06-06T00:01:00.000Z"),
    })

    const merged = rebaseQueueFieldsOntoLatest(base, latest, processed)

    expect(merged.lastBootstrappedAt).toBe("2026-06-06T00:01:00.000Z")
  })

  it("drops queued reads and outbox entries for a tombstoned conversation", () => {
    const base = snapshot({
      pendingReads: { c1: read("c1", 10) },
      outbox: { old: outbox("old", "c1") },
    })
    const latest = snapshot({
      pendingReads: { c1: read("c1", 10) },
      outbox: { old: outbox("old", "c1") },
      tombstones: { c1: { conversationId: "c1", removedSeq: 12 } },
    })
    const processed = snapshot({
      pendingReads: { c1: read("c1", 10) },
      outbox: { old: outbox("old", "c1") },
    })

    const merged = rebaseQueueFieldsOntoLatest(base, latest, processed)

    expect(merged.pendingReads).toEqual({})
    expect(merged.outbox).toEqual({})
    expect(merged.tombstones.c1?.removedSeq).toBe(12)
  })

  it("skips HTTP-drained sync events already applied by the live cursor", () => {
    expect(shouldApplyDrainedSyncEvent(9, 10)).toBe(false)
    expect(shouldApplyDrainedSyncEvent(10, 10)).toBe(false)
    expect(shouldApplyDrainedSyncEvent(11, 10)).toBe(true)
  })

  it("does not clear a removal tombstone with stale active membership", () => {
    const removed = snapshot({
      tombstones: { c1: { conversationId: "c1", removedSeq: 12 } },
    })

    const stale = clearConversationTombstone(removed, "c1", 10)
    const fresh = clearConversationTombstone(removed, "c1", 13)

    expect(stale.tombstones.c1?.removedSeq).toBe(12)
    expect(fresh.tombstones).toEqual({})
  })

  it("does not upsert a conversation from a stale event behind a tombstone", () => {
    const removed = snapshot({
      conversations: [],
      tombstones: { c1: { conversationId: "c1", removedSeq: 12 } },
    })

    const stale = upsertConversationWithTombstoneGuard(
      removed,
      { conversationId: "c1", title: "stale" },
      10,
      upsert
    )
    const fresh = upsertConversationWithTombstoneGuard(
      removed,
      { conversationId: "c1", title: "fresh" },
      13,
      upsert
    )

    expect(stale.conversations).toEqual([])
    expect(stale.tombstones.c1?.removedSeq).toBe(12)
    expect(fresh.conversations).toEqual([
      { conversationId: "c1", title: "fresh" },
    ])
    expect(fresh.tombstones).toEqual({})
  })

  it("preserves queued outbox and reads after a fresh upsert re-adds a conversation", () => {
    const removed = snapshot({
      conversations: [],
      tombstones: { c1: { conversationId: "c1", removedSeq: 12 } },
    })
    const readded = upsertConversationWithTombstoneGuard(
      removed,
      { conversationId: "c1", title: "fresh" },
      13,
      upsert
    )
    const latest = {
      ...readded,
      pendingReads: { c1: read("c1", 20) },
      outbox: { fresh: outbox("fresh", "c1") },
    }

    const merged = rebaseQueueFieldsOntoLatest(readded, latest, readded)

    expect(merged.tombstones).toEqual({})
    expect(merged.pendingReads.c1?.readUpToSequence).toBe(20)
    expect(merged.outbox.fresh?.conversationId).toBe("c1")
  })
})
