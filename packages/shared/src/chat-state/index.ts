/**
 * Shared, framework-agnostic chat state primitives.
 *
 * Surgical extraction of the pure logic that web (`stores/chat-store.ts`) and
 * mobile (`lib/chat-runtime.ts` + `lib/chat-data.ts`) had each implemented
 * separately, byte-for-byte. These functions operate on plain snapshot objects —
 * no React, no persistence, no platform globals — so they can be unit-tested in
 * isolation and shared across both frontends.
 *
 * The `CanonicalChatState` shape mirrors mobile's existing `ChatWorkspaceSnapshot`
 * (the richer of the two: per-conversation item + meta maps), and is a superset of
 * the shared `StoredChatQueueState` (outbox / pendingReads / cursor). It is an
 * IN-MEMORY adapter shape: each frontend converts to/from its own on-disk format
 * (mobile expo-sqlite v4 snapshot, web idb queue state) at the persistence
 * boundary — this module never persists and never bumps an on-disk version.
 *
 * Pure ES2022, no zod, no DOM. On its own subpath; NOT re-exported from the root
 * barrel (keeps the service-worker-reachable barrel surface tight).
 */

import type {
  ChatConversationItem,
  ChatConversationView,
} from "../types/index.js"
import type {
  PendingConversationRead,
  PendingOutboxMessage,
} from "../chat-queue/index.js"

/** Per-conversation load/read bookkeeping (mirrors mobile ChatConversationMeta). */
export interface CanonicalChatConversationMeta {
  readWatermarkSequence: number
  hasMoreBefore: boolean
  hasLoadedLatest: boolean
  loadingLatest: boolean
  lastFetchedAt?: string
  latestLoadError?: string
}

/**
 * Canonical in-memory chat state. Superset of StoredChatQueueState plus the
 * materialized conversation list + per-conversation item/meta maps.
 */
export interface CanonicalChatState {
  workspaceId: string
  workspaceMemberId?: string
  clientInstanceId?: string
  inboxCursor: number
  lastBootstrappedAt?: string
  conversations: ChatConversationView[]
  itemsByConversationId: Record<string, ChatConversationItem[]>
  metaByConversationId: Record<string, CanonicalChatConversationMeta>
  pendingReads: Record<string, PendingConversationRead>
  outbox: Record<string, PendingOutboxMessage>
}

export function createEmptyCanonicalChatState(
  workspaceId: string
): CanonicalChatState {
  return {
    workspaceId,
    inboxCursor: 0,
    conversations: [],
    itemsByConversationId: {},
    metaByConversationId: {},
    pendingReads: {},
    outbox: {},
  }
}

// ---------------------------------------------------------------------------
// Pure item-merge / conversation-sort helpers.
// Behaviour preserved byte-for-byte from mobile chat-data.ts (the canonical side).
// ---------------------------------------------------------------------------

/** Sort by (sequence, createdAt). Mirrors mobile `sortChatItems`. */
export function sortChatItems<
  T extends Pick<ChatConversationItem, "sequence" | "createdAt">,
>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence
    }
    return (
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    )
  })
}

/**
 * Merge incoming items into existing, de-duping by id (incoming wins) then
 * sorting by (sequence, createdAt). Idempotent: merging the same items twice
 * yields deep-equal output. Mirrors mobile `mergeChatItems`.
 */
export function mergeChatItems(
  existing: ChatConversationItem[],
  incoming: ChatConversationItem[]
): ChatConversationItem[] {
  const byKey = new Map<string, ChatConversationItem>()
  for (const item of existing) byKey.set(item.id, item)
  for (const item of incoming) byKey.set(item.id, item)
  return sortChatItems([...byKey.values()])
}

/**
 * Replace/insert a conversation by id, then re-sort. Mirrors mobile
 * `upsertChatConversation`.
 */
export function upsertChatConversation(
  conversations: ChatConversationView[],
  incoming: ChatConversationView
): ChatConversationView[] {
  const next = conversations.filter(
    (conversation) => conversation.conversationId !== incoming.conversationId
  )
  next.push(incoming)
  return sortChatConversations(next)
}

/** Fold a batch of conversations through `upsertChatConversation`. */
export function upsertChatConversations(
  conversations: ChatConversationView[],
  incoming: ChatConversationView[]
): ChatConversationView[] {
  return incoming.reduce(upsertChatConversation, conversations)
}

/**
 * Sort conversations pinned-first (by pinnedSortKey desc), then by most-recent
 * activity (lastItem.createdAt -> updatedAt -> createdAt). Mirrors mobile
 * `sortChatConversations`.
 */
export function sortChatConversations(
  conversations: ChatConversationView[]
): ChatConversationView[] {
  return [...conversations].sort((left, right) => {
    const leftPinned = left.pinnedSortKey
      ? new Date(left.pinnedSortKey).getTime()
      : 0
    const rightPinned = right.pinnedSortKey
      ? new Date(right.pinnedSortKey).getTime()
      : 0
    if (leftPinned !== rightPinned) {
      return rightPinned - leftPinned
    }

    const leftAt = left.lastItem?.createdAt ?? left.updatedAt ?? left.createdAt
    const rightAt =
      right.lastItem?.createdAt ?? right.updatedAt ?? right.createdAt
    return new Date(rightAt).getTime() - new Date(leftAt).getTime()
  })
}

// ---------------------------------------------------------------------------
// Pure outbox + unread helpers (byte-identical across both clients today).
// ---------------------------------------------------------------------------

/**
 * Remove any outbox entries whose clientMessageId now appears among delivered
 * items. Returns the same reference when nothing is delivered (no-op friendly).
 */
export function clearDeliveredOutbox(
  outbox: Record<string, PendingOutboxMessage>,
  items: ChatConversationItem[]
): Record<string, PendingOutboxMessage> {
  const deliveredClientIds = new Set(
    items
      .map((item) => item.clientMessageId)
      .filter((value): value is string => Boolean(value))
  )
  if (deliveredClientIds.size === 0) {
    return outbox
  }

  const nextOutbox = { ...outbox }
  for (const clientMessageId of deliveredClientIds) {
    delete nextOutbox[clientMessageId]
  }
  return nextOutbox
}

/** Whether a freshly-arrived item should bump a conversation's unread count. */
export function shouldIncrementUnreadCount(
  conversation: Pick<ChatConversationView, "viewerParticipantId">,
  item: ChatConversationItem
): boolean {
  return (
    item.itemType === "message" &&
    item.scope === "shared" &&
    item.surface === "visible" &&
    item.authorParticipantId !== conversation.viewerParticipantId
  )
}

/**
 * Compute the next optimistic sequence for a new outgoing message: strictly
 * greater than both a wall-clock-derived floor and any existing sequence, so
 * optimistic items always sort after everything currently known. Mirrors the
 * `Math.max(now*1000, ...existing) + 1` computation in both clients.
 */
export function nextOptimisticSequence(
  existingItems: ChatConversationItem[],
  nowMs: number
): number {
  let max = nowMs * 1000
  for (const item of existingItems) {
    if (typeof item.sequence === "number" && item.sequence >= max) {
      max = item.sequence
    }
  }
  return max + 1
}
