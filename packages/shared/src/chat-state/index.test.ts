import { test } from "node:test"
import assert from "node:assert/strict"
import { assertIsoInstant } from "../datetime/instant.js"

import {
  clearDeliveredOutbox,
  createEmptyCanonicalChatState,
  mergeChatItems,
  nextOptimisticSequence,
  shouldIncrementUnreadCount,
  sortChatConversations,
  sortChatItems,
  upsertChatConversation,
} from "./index.js"
import type {
  ChatConversationItem,
  ChatConversationView,
} from "../types/index.js"
import type { PendingOutboxMessage } from "../chat-queue/index.js"
import type { Timestamp } from "../types/index.js"

const iso = (value: string): Timestamp => assertIsoInstant(value)

// --- minimal builders (only the fields the pure helpers read) --------------

function item(partial: {
  id: string
  sequence: number
  conversationId?: string
  itemType?: string
  scope?: string
  surface?: string
  createdAt?: Timestamp
  content?: string
  clientMessageId?: string
  authorParticipantId?: string
}): ChatConversationItem {
  return {
    id: partial.id,
    conversationId: partial.conversationId ?? "c1",
    sequence: partial.sequence,
    itemType: partial.itemType ?? "message",
    role: "user",
    scope: partial.scope ?? "shared",
    surface: partial.surface ?? "visible",
    subtype: "text",
    content: partial.content ?? "",
    contentBlocks: [],
    metadata: {},
    createdAt: partial.createdAt ?? iso("2026-01-01T00:00:00.000Z"),
    clientMessageId: partial.clientMessageId,
    authorParticipantId: partial.authorParticipantId,
  } as unknown as ChatConversationItem
}

function view(
  partial: Partial<ChatConversationView> & { conversationId: string }
): ChatConversationView {
  return {
    conversationId: partial.conversationId,
    workspaceId: "ws1",
    title: partial.conversationId,
    kind: "group",
    isIm: false,
    status: "active",
    unreadCount: 0,
    muted: false,
    archived: false,
    pinnedSortKey: partial.pinnedSortKey,
    updatedAt: partial.updatedAt ?? iso("2026-01-01T00:00:00.000Z"),
    createdAt: partial.createdAt ?? iso("2026-01-01T00:00:00.000Z"),
    participants: [],
    presentation: { chatType: "group", avatarParticipantIds: [] },
    permissions: {
      canManageConversation: false,
      canManageParticipants: false,
      canRename: false,
    },
    viewerParticipantId: partial.viewerParticipantId,
    lastItem: partial.lastItem,
  } as ChatConversationView
}

function outboxEntry(clientMessageId: string): PendingOutboxMessage {
  return {
    clientMessageId,
    conversationId: "c1",
    contentBlocks: [],
    createdAt: iso("2026-01-01T00:00:00.000Z"),
    optimisticSequence: 1,
    status: "sending",
    attemptCount: 0,
  }
}

// --- mergeChatItems / sortChatItems ----------------------------------------

test("mergeChatItems sorts by sequence then createdAt", () => {
  const merged = mergeChatItems(
    [item({ id: "b", sequence: 2 })],
    [item({ id: "a", sequence: 1 }), item({ id: "c", sequence: 3 })]
  )
  assert.deepEqual(
    merged.map((i) => i.id),
    ["a", "b", "c"]
  )
})

test("mergeChatItems is order-independent (arrival order does not matter)", () => {
  const a = item({ id: "a", sequence: 1 })
  const b = item({ id: "b", sequence: 2 })
  const c = item({ id: "c", sequence: 3 })
  const forward = mergeChatItems([], [a, b, c]).map((i) => i.id)
  const reverse = mergeChatItems([], [c, b, a]).map((i) => i.id)
  assert.deepEqual(forward, reverse)
  assert.deepEqual(forward, ["a", "b", "c"])
})

test("mergeChatItems dedupes by id with incoming winning, and is idempotent", () => {
  const existing = [item({ id: "a", sequence: 1, content: "old" })]
  const incoming = [item({ id: "a", sequence: 1, content: "new" })]
  const once = mergeChatItems(existing, incoming)
  assert.equal(once.length, 1)
  assert.equal((once[0] as { content: string }).content, "new")
  // replaying the same merge is stable
  const twice = mergeChatItems(once, incoming)
  assert.deepEqual(twice, once)
})

test("sortChatItems ties broken by createdAt", () => {
  const sorted = sortChatItems([
    item({
      id: "late",
      sequence: 5,
      createdAt: iso("2026-01-02T00:00:00.000Z"),
    }),
    item({
      id: "early",
      sequence: 5,
      createdAt: iso("2026-01-01T00:00:00.000Z"),
    }),
  ])
  assert.deepEqual(
    sorted.map((i) => i.id),
    ["early", "late"]
  )
})

// --- sortChatConversations / upsert ----------------------------------------

test("sortChatConversations puts pinned first then by recency", () => {
  const sorted = sortChatConversations([
    view({ conversationId: "old", updatedAt: iso("2026-01-01T00:00:00.000Z") }),
    view({ conversationId: "new", updatedAt: iso("2026-01-03T00:00:00.000Z") }),
    view({
      conversationId: "pinned",
      updatedAt: iso("2026-01-02T00:00:00.000Z"),
      pinnedSortKey: iso("2026-01-02T00:00:00.000Z"),
    }),
  ])
  assert.deepEqual(
    sorted.map((c) => c.conversationId),
    ["pinned", "new", "old"]
  )
})

test("upsertChatConversation replaces by id and re-sorts", () => {
  const initial = [
    view({ conversationId: "a", updatedAt: iso("2026-01-01T00:00:00.000Z") }),
  ]
  const next = upsertChatConversation(
    initial,
    view({ conversationId: "a", updatedAt: iso("2026-01-05T00:00:00.000Z") })
  )
  assert.equal(next.length, 1)
  assert.equal(next[0]!.updatedAt, iso("2026-01-05T00:00:00.000Z"))
})

// --- clearDeliveredOutbox --------------------------------------------------

test("clearDeliveredOutbox removes entries whose clientMessageId was delivered", () => {
  const outbox = { m1: outboxEntry("m1"), m2: outboxEntry("m2") }
  const next = clearDeliveredOutbox(outbox, [
    item({ id: "x", sequence: 1, clientMessageId: "m1" }),
  ])
  assert.deepEqual(Object.keys(next), ["m2"])
})

test("clearDeliveredOutbox returns the same reference when nothing delivered", () => {
  const outbox = { m1: outboxEntry("m1") }
  const next = clearDeliveredOutbox(outbox, [item({ id: "x", sequence: 1 })])
  assert.equal(next, outbox)
})

// --- shouldIncrementUnreadCount -------------------------------------------

test("shouldIncrementUnreadCount only for shared visible messages from others", () => {
  const conv = { viewerParticipantId: "me" }
  assert.equal(
    shouldIncrementUnreadCount(
      conv,
      item({ id: "1", sequence: 1, authorParticipantId: "other" })
    ),
    true
  )
  // own message
  assert.equal(
    shouldIncrementUnreadCount(
      conv,
      item({ id: "2", sequence: 2, authorParticipantId: "me" })
    ),
    false
  )
  // internal surface (not user-visible)
  assert.equal(
    shouldIncrementUnreadCount(
      conv,
      item({
        id: "3",
        sequence: 3,
        authorParticipantId: "other",
        surface: "internal",
      })
    ),
    false
  )
})

// --- nextOptimisticSequence ------------------------------------------------

test("nextOptimisticSequence exceeds wall-clock floor and existing max", () => {
  const now = 1_700_000_000_000
  // no items -> floor*1000 + 1
  assert.equal(nextOptimisticSequence([], now), now * 1000 + 1)
  // existing larger than floor -> existing + 1
  const big = now * 1000 + 50
  assert.equal(
    nextOptimisticSequence([item({ id: "x", sequence: big })], now),
    big + 1
  )
})

test("createEmptyCanonicalChatState yields empty maps", () => {
  const state = createEmptyCanonicalChatState("ws1")
  assert.equal(state.workspaceId, "ws1")
  assert.equal(state.inboxCursor, 0)
  assert.deepEqual(state.conversations, [])
  assert.deepEqual(state.itemsByConversationId, {})
  assert.deepEqual(state.outbox, {})
})

// --- outbox transitions ----------------------------------------------------

import {
  createEmptyCanonicalChatState as emptyState,
  markOutboxAttemptStarted,
  markOutboxDelivered,
  markOutboxFailed,
} from "./index.js"

function stateWithOutbox(clientMessageId: string, conversationId = "c1") {
  const s = emptyState("ws1")
  s.conversations = [view({ conversationId })]
  s.itemsByConversationId = { [conversationId]: [] }
  s.outbox = {
    [clientMessageId]: {
      clientMessageId,
      conversationId,
      contentBlocks: [],
      createdAt: iso("2026-01-01T00:00:00.000Z"),
      optimisticSequence: 1,
      status: "sending",
      attemptCount: 0,
    },
  }
  return s
}

test("markOutboxAttemptStarted bumps attemptCount + lastAttemptAt deterministically", () => {
  const s = stateWithOutbox("m1")
  const next = markOutboxAttemptStarted(
    s,
    "m1",
    iso("2026-02-02T00:00:00.000Z")
  )
  assert.equal(next.outbox.m1!.attemptCount, 1)
  assert.equal(next.outbox.m1!.lastAttemptAt, iso("2026-02-02T00:00:00.000Z"))
  // unknown id -> same reference
  assert.equal(markOutboxAttemptStarted(s, "nope", "x"), s)
})

test("markOutboxDelivered removes the entry, merges the item, updates lastItem", () => {
  const s = stateWithOutbox("m1")
  const serverItem = item({
    id: "srv1",
    sequence: 10,
    clientMessageId: "m1",
    content: "hi",
  })
  const next = markOutboxDelivered(s, "m1", serverItem)
  assert.equal(next.outbox.m1, undefined)
  assert.deepEqual(
    next.itemsByConversationId.c1!.map((i) => i.id),
    ["srv1"]
  )
  assert.equal(next.conversations[0]!.lastItem?.itemId, "srv1")
  assert.equal(next.conversations[0]!.updatedAt, serverItem.createdAt)
})

test("markOutboxFailed sets retrying + firstFailedAt (sticky) + error", () => {
  const s = stateWithOutbox("m1")
  const failed = markOutboxFailed(
    s,
    "m1",
    iso("2026-03-03T00:00:00.000Z"),
    "boom"
  )
  assert.equal(failed.outbox.m1!.status, "retrying")
  assert.equal(failed.outbox.m1!.firstFailedAt, iso("2026-03-03T00:00:00.000Z"))
  assert.equal(failed.outbox.m1!.lastErrorMessage, "boom")
  // firstFailedAt is sticky across subsequent failures
  const again = markOutboxFailed(
    failed,
    "m1",
    iso("2026-03-04T00:00:00.000Z"),
    "boom2"
  )
  assert.equal(again.outbox.m1!.firstFailedAt, iso("2026-03-03T00:00:00.000Z"))
  assert.equal(again.outbox.m1!.lastErrorMessage, "boom2")
})
