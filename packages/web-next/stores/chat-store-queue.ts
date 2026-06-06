import {
  mergeStoredQueueTransition,
  type StoredChatQueueState,
} from "@synapse/shared"

export interface ChatQueueWorkspaceSnapshot<
  TConversation extends { conversationId: string } = { conversationId: string },
> extends StoredChatQueueState {
  conversations: TConversation[]
}

export function toStoredChatQueueState(
  snapshot: Pick<
    StoredChatQueueState,
    | "workspaceId"
    | "workspaceMemberId"
    | "clientInstanceId"
    | "inboxCursor"
    | "lastBootstrappedAt"
    | "pendingReads"
    | "outbox"
    | "tombstones"
  > | null
): StoredChatQueueState | null {
  if (!snapshot) {
    return null
  }

  return {
    version: 4,
    workspaceId: snapshot.workspaceId,
    workspaceMemberId: snapshot.workspaceMemberId,
    clientInstanceId: snapshot.clientInstanceId,
    inboxCursor: snapshot.inboxCursor,
    lastBootstrappedAt: snapshot.lastBootstrappedAt,
    pendingReads: snapshot.pendingReads,
    outbox: snapshot.outbox,
    tombstones: snapshot.tombstones,
  }
}

/**
 * Clear a conversation's tombstone. Seq-guarded clears are used for live/sync
 * membership.updated{active}; an undefined seq is reserved for bootstrap, whose
 * current liveness view is authoritative.
 */
export function clearConversationTombstone<
  TSnapshot extends ChatQueueWorkspaceSnapshot,
>(snapshot: TSnapshot, conversationId: string, memberSeq?: number): TSnapshot {
  const tombstone = snapshot.tombstones[conversationId]
  if (!tombstone) {
    return snapshot
  }
  if (typeof memberSeq === "number" && memberSeq <= tombstone.removedSeq) {
    return snapshot
  }
  const nextTombstones = { ...snapshot.tombstones }
  delete nextTombstones[conversationId]
  return { ...snapshot, tombstones: nextTombstones }
}

export function upsertConversationWithTombstoneGuard<
  TConversation extends { conversationId: string },
  TSnapshot extends ChatQueueWorkspaceSnapshot<TConversation>,
>(
  snapshot: TSnapshot,
  incoming: TConversation,
  memberSeq: number | undefined,
  upsert: (
    conversations: TConversation[],
    incoming: TConversation
  ) => TConversation[]
): TSnapshot {
  const tombstone = snapshot.tombstones[incoming.conversationId]
  if (
    tombstone &&
    typeof memberSeq === "number" &&
    memberSeq <= tombstone.removedSeq
  ) {
    return snapshot
  }
  // Re-add can deliver conversation.upsert before membership.updated{active}.
  // Treat a fresh upsert as liveness so queued reads/outbox are not filtered.
  const tombstones =
    tombstone && typeof memberSeq === "number"
      ? { ...snapshot.tombstones }
      : snapshot.tombstones
  if (tombstones !== snapshot.tombstones) {
    delete tombstones[incoming.conversationId]
  }
  return {
    ...snapshot,
    tombstones,
    conversations: upsert(snapshot.conversations, incoming),
  }
}

/**
 * HTTP sync drains should skip events already applied by the live path. Replaying
 * old frames is not just wasteful: stale membership/upsert frames can otherwise
 * race newer removal tombstones.
 */
export function shouldApplyDrainedSyncEvent(
  eventMemberSeq: number,
  liveBase: number
): boolean {
  return eventMemberSeq > liveBase
}

/**
 * Reconcile the result of an async queue operation back onto the latest live
 * snapshot with the same base-aware merge semantics as the IndexedDB writer.
 */
export function rebaseQueueFieldsOntoLatest<
  TSnapshot extends ChatQueueWorkspaceSnapshot,
>(base: TSnapshot, latest: TSnapshot, processed: TSnapshot): TSnapshot {
  const baseQueue = toStoredChatQueueState(base)
  const latestQueue = toStoredChatQueueState(latest)
  const processedQueue = toStoredChatQueueState(processed)
  if (!baseQueue || !latestQueue || !processedQueue) {
    return latest
  }
  const mergedQueue = mergeStoredQueueTransition(
    latestQueue,
    baseQueue,
    processedQueue
  )

  const tombstoned = mergedQueue.tombstones
  const pendingReads = Object.fromEntries(
    Object.entries(mergedQueue.pendingReads).filter(([cid]) => !tombstoned[cid])
  )
  const outbox = Object.fromEntries(
    Object.entries(mergedQueue.outbox).filter(
      ([, entry]) => !tombstoned[entry.conversationId]
    )
  )
  return {
    ...latest,
    pendingReads,
    outbox,
    tombstones: mergedQueue.tombstones,
    inboxCursor: mergedQueue.inboxCursor,
    lastBootstrappedAt: mergedQueue.lastBootstrappedAt,
  }
}
