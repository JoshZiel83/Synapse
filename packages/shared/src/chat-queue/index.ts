import type {
  CanonicalContentBlock,
  ConversationReplyRef,
  Timestamp,
} from "../types/index.js"
import deepEqual from "fast-deep-equal"

export const CHAT_QUEUE_DB_NAME = "synapse-chat-queue"
export const CHAT_QUEUE_DB_VERSION = 1
export const CHAT_QUEUE_STATE_STORE = "workspace_queue_states"
export const CHAT_QUEUE_BROADCAST_CHANNEL = "synapse-chat-queue"

// Web/mobile SW background-sync registration tags. Sharing the names
// means the SW reaches the same tag regardless of which client
// installed it, and any future "sync tag X means flush the chat queue"
// listener can live in one place.
export const CHAT_SERVICE_WORKER_SYNC_TAG = "synapse-chat-sync"
export const CHAT_SERVICE_WORKER_PERIODIC_SYNC_TAG =
  "synapse-chat-periodic-sync"

export interface PendingConversationRead {
  conversationId: string
  readUpToSequence: number
  lastVisibleSequence: number
  updatedAt: Timestamp
}

export interface PendingOutboxMessage {
  clientMessageId: string
  conversationId: string
  contentBlocks: CanonicalContentBlock[]
  replyToItemId?: string
  replyTo?: ConversationReplyRef
  createdAt: Timestamp
  optimisticSequence: number
  status: "sending" | "retrying"
  attemptCount: number
  lastAttemptAt?: Timestamp
  firstFailedAt?: Timestamp
  lastErrorMessage?: string
}

/**
 * A locally-recorded "this conversation was removed at member_seq=removedSeq"
 * marker. Persisted so that, after a removal (membership.updated{removed} or a
 * bootstrap prune), a LATER-arriving but lower-seq stale `conversation.upsert`
 * cannot resurrect the conversation: the upsert reducer drops any frame whose
 * memberSeq <= removedSeq. Cleared by membership.updated{active} or by bootstrap
 * returning the conversation as live (legitimate re-add).
 */
export interface ConversationTombstone {
  conversationId: string
  removedSeq: number
}

export interface StoredChatQueueState {
  version: 4
  workspaceId: string
  workspaceMemberId?: string
  clientInstanceId?: string
  inboxCursor: number
  lastBootstrappedAt?: Timestamp
  pendingReads: Record<string, PendingConversationRead>
  outbox: Record<string, PendingOutboxMessage>
  /** conversationId -> tombstone. See ConversationTombstone. */
  tombstones: Record<string, ConversationTombstone>
}

export function createEmptyStoredChatQueueState(
  workspaceId: string
): StoredChatQueueState {
  return {
    version: 4,
    workspaceId,
    inboxCursor: 0,
    pendingReads: {},
    outbox: {},
    tombstones: {},
  }
}

function isUuidLike(value: unknown): value is string {
  if (typeof value !== "string") return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value
  )
}

export function normalizeStoredChatQueueState(
  workspaceId: string,
  value: unknown
): StoredChatQueueState {
  if (!value || typeof value !== "object") {
    return createEmptyStoredChatQueueState(workspaceId)
  }

  const snapshot = value as Partial<StoredChatQueueState> & { version?: number }
  if (snapshot.workspaceId !== workspaceId) {
    return createEmptyStoredChatQueueState(workspaceId)
  }
  // v3 (pre-member_seq) is migratable: the OLD inboxCursor was a global sync_seq
  // and is meaningless under the new member_seq cursor, so RESET it to 0 (forces
  // one full bootstrap+sync). Outbox/pendingReads are preserved (no data loss),
  // tombstones start empty. Any other version is wiped.
  const version: number = snapshot.version ?? 0
  const isV3 = version === 3
  const isV4 = version === 4
  if (!isV3 && !isV4) {
    return createEmptyStoredChatQueueState(workspaceId)
  }

  const pendingReads =
    snapshot.pendingReads && typeof snapshot.pendingReads === "object"
      ? Object.fromEntries(
          Object.entries(snapshot.pendingReads).filter(
            ([conversationId, entry]) =>
              Boolean(
                conversationId &&
                entry &&
                typeof entry === "object" &&
                typeof (entry as PendingConversationRead).conversationId ===
                  "string"
              )
          )
        )
      : {}

  const outbox =
    snapshot.outbox && typeof snapshot.outbox === "object"
      ? Object.fromEntries(
          Object.entries(snapshot.outbox).filter(([, entry]) =>
            Boolean(
              entry &&
              typeof entry === "object" &&
              typeof (entry as PendingOutboxMessage).clientMessageId ===
                "string" &&
              typeof (entry as PendingOutboxMessage).conversationId === "string"
            )
          )
        )
      : {}

  // tombstones only exist from v4 onward; v3 migrates to an empty set.
  const tombstones =
    isV4 && snapshot.tombstones && typeof snapshot.tombstones === "object"
      ? Object.fromEntries(
          Object.entries(snapshot.tombstones).filter(
            ([conversationId, entry]) =>
              Boolean(
                conversationId &&
                entry &&
                typeof entry === "object" &&
                typeof (entry as ConversationTombstone).conversationId ===
                  "string" &&
                typeof (entry as ConversationTombstone).removedSeq === "number"
              )
          )
        )
      : {}

  return {
    version: 4,
    workspaceId,
    workspaceMemberId:
      typeof snapshot.workspaceMemberId === "string"
        ? snapshot.workspaceMemberId
        : undefined,
    clientInstanceId: isUuidLike(snapshot.clientInstanceId)
      ? snapshot.clientInstanceId
      : undefined,
    inboxCursor:
      isV4 &&
      typeof snapshot.inboxCursor === "number" &&
      Number.isFinite(snapshot.inboxCursor)
        ? snapshot.inboxCursor
        : 0,
    lastBootstrappedAt:
      typeof snapshot.lastBootstrappedAt === "string"
        ? snapshot.lastBootstrappedAt
        : undefined,
    pendingReads,
    outbox,
    tombstones,
  }
}

export function sameStoredChatQueueState(
  left: StoredChatQueueState,
  right: StoredChatQueueState
) {
  return deepEqual(left, right)
}

function latestIsoTimestamp(
  currentValue?: Timestamp,
  nextValue?: Timestamp
): Timestamp | undefined {
  if (!currentValue) return nextValue
  if (!nextValue) return currentValue
  return new Date(currentValue).getTime() >= new Date(nextValue).getTime()
    ? currentValue
    : nextValue
}

function sameStoredEntry(left: unknown, right: unknown) {
  return deepEqual(left, right)
}

export function mergeStoredQueueTransition(
  currentState: StoredChatQueueState,
  previousState: StoredChatQueueState | null,
  nextState: StoredChatQueueState
): StoredChatQueueState {
  const nextWorkspaceState =
    currentState.workspaceMemberId &&
    nextState.workspaceMemberId &&
    currentState.workspaceMemberId !== nextState.workspaceMemberId
      ? createEmptyStoredChatQueueState(nextState.workspaceId)
      : currentState.workspaceId === nextState.workspaceId
        ? currentState
        : createEmptyStoredChatQueueState(nextState.workspaceId)

  const previousOutbox = previousState?.outbox ?? {}
  const previousPendingReads = previousState?.pendingReads ?? {}
  const nextOutbox = { ...nextWorkspaceState.outbox }
  const nextPendingReads = { ...nextWorkspaceState.pendingReads }

  for (const clientMessageId of Object.keys(previousOutbox)) {
    if (!(clientMessageId in nextState.outbox)) {
      delete nextOutbox[clientMessageId]
    }
  }
  for (const [clientMessageId, entry] of Object.entries(nextState.outbox)) {
    if (!sameStoredEntry(previousOutbox[clientMessageId], entry)) {
      nextOutbox[clientMessageId] = entry
    }
  }

  for (const conversationId of Object.keys(previousPendingReads)) {
    if (!(conversationId in nextState.pendingReads)) {
      const currentEntry = nextPendingReads[conversationId]
      const previousEntry = previousPendingReads[conversationId]
      if (
        currentEntry &&
        previousEntry &&
        currentEntry.readUpToSequence > previousEntry.readUpToSequence
      ) {
        continue
      }
      delete nextPendingReads[conversationId]
    }
  }
  for (const [conversationId, entry] of Object.entries(
    nextState.pendingReads
  )) {
    if (!sameStoredEntry(previousPendingReads[conversationId], entry)) {
      nextPendingReads[conversationId] = entry
    }
  }

  // tombstones are a base-aware diff set, like outbox/pendingReads, but the
  // CLEAR must be sequenced. A clear (key in previous, absent in next) is a real
  // deletion ONLY when it supersedes what current holds — i.e. current is absent
  // or current.removedSeq <= previous.removedSeq. Otherwise current already has
  // a NEWER removal (e.g. another tab tombstoned at a higher seq after this
  // transition's base was captured) and a stale clear must NOT delete it.
  const previousTombstones = previousState?.tombstones ?? {}
  const nextTombstones = { ...(nextWorkspaceState.tombstones ?? {}) }
  for (const conversationId of Object.keys(previousTombstones)) {
    if (!(conversationId in nextState.tombstones)) {
      const current = nextTombstones[conversationId]
      const previous = previousTombstones[conversationId]
      if (current && previous && current.removedSeq > previous.removedSeq) {
        // current has a newer removal than the one this transition cleared —
        // keep it.
        continue
      }
      delete nextTombstones[conversationId]
    }
  }
  for (const [conversationId, entry] of Object.entries(nextState.tombstones)) {
    const current = nextTombstones[conversationId]
    // Monotonic: keep the highest removedSeq if both sides have one.
    if (!current || entry.removedSeq >= current.removedSeq) {
      nextTombstones[conversationId] = entry
    }
  }

  return {
    ...nextWorkspaceState,
    workspaceId: nextState.workspaceId,
    workspaceMemberId:
      nextState.workspaceMemberId ?? nextWorkspaceState.workspaceMemberId,
    clientInstanceId:
      nextState.clientInstanceId ?? nextWorkspaceState.clientInstanceId,
    inboxCursor: Math.max(
      nextWorkspaceState.inboxCursor,
      nextState.inboxCursor
    ),
    lastBootstrappedAt: latestIsoTimestamp(
      nextWorkspaceState.lastBootstrappedAt,
      nextState.lastBootstrappedAt
    ),
    pendingReads: nextPendingReads,
    outbox: nextOutbox,
    tombstones: nextTombstones,
  }
}

/**
 * Worker-side merge: reconcile a flush attempt back into the queue.
 *
 * Mental model: the worker took a snapshot `base`, processed it, and
 * produced `processed`. Meanwhile the UI thread may have written new
 * state into `latest`. For each entry the worker touched, if `latest`
 * still matches `base` (UI hasn't changed it during the flush) we
 * apply `processed`; otherwise we keep the newer `latest` to avoid
 * clobbering a concurrent write.
 *
 * Generic over the queue-state shape so it can serve both the v3 web
 * StoredChatQueueState and the v1 mobile ChatWorkspaceQueueState
 * without converging their version numbers (mobile would need a
 * destructive IDB migration to bump to v3).
 */
export interface ChatQueueStateLike {
  workspaceId: string
  workspaceMemberId?: string
  clientInstanceId?: string
  inboxCursor: number
  lastBootstrappedAt?: Timestamp
  pendingReads: Record<string, unknown>
  outbox: Record<string, unknown>
  tombstones?: Record<string, unknown>
}

function sameEntry(left: unknown, right: unknown) {
  return deepEqual(left ?? null, right ?? null)
}

export function mergeQueueStateForSave<T extends ChatQueueStateLike>(
  baseQueueState: T,
  latestQueueState: T,
  processedQueueState: T
): T {
  const next = {
    ...latestQueueState,
    workspaceId: latestQueueState.workspaceId,
    workspaceMemberId:
      latestQueueState.workspaceMemberId ||
      processedQueueState.workspaceMemberId,
    clientInstanceId:
      latestQueueState.clientInstanceId || processedQueueState.clientInstanceId,
    inboxCursor: Math.max(
      latestQueueState.inboxCursor || 0,
      processedQueueState.inboxCursor || 0
    ),
    lastBootstrappedAt:
      latestQueueState.lastBootstrappedAt ||
      processedQueueState.lastBootstrappedAt,
    pendingReads: { ...latestQueueState.pendingReads },
    outbox: { ...latestQueueState.outbox },
    // The SW never mutates tombstones (it only flushes outbox/reads), so
    // preserve whatever the latest UI-thread state holds. Carried through so the
    // round-trip save doesn't strip the field.
    tombstones: latestQueueState.tombstones
      ? { ...latestQueueState.tombstones }
      : processedQueueState.tombstones
        ? { ...processedQueueState.tombstones }
        : undefined,
  } as T

  for (const conversationId of Object.keys(baseQueueState.pendingReads)) {
    const baseEntry = baseQueueState.pendingReads[conversationId]
    const latestEntry = next.pendingReads[conversationId]
    const processedEntry = processedQueueState.pendingReads[conversationId]
    if (!sameEntry(latestEntry, baseEntry)) continue
    if (processedEntry) {
      next.pendingReads[conversationId] = processedEntry
    } else {
      delete next.pendingReads[conversationId]
    }
  }

  for (const clientMessageId of Object.keys(baseQueueState.outbox)) {
    const baseEntry = baseQueueState.outbox[clientMessageId]
    const latestEntry = next.outbox[clientMessageId]
    const processedEntry = processedQueueState.outbox[clientMessageId]
    if (!sameEntry(latestEntry, baseEntry)) continue
    if (processedEntry) {
      next.outbox[clientMessageId] = processedEntry
    } else {
      delete next.outbox[clientMessageId]
    }
  }

  return next
}

/**
 * Shared service-worker outbox flush loop.
 *
 * Extracted from the near-verbatim `flushOutbox` implementations in
 * web-chat-service-worker.ts and the mobile chat-service-worker.ts. Both operate
 * on the flat queue state (outbox only — no item merge; that happens on the main
 * thread). The platform bits are injected:
 *  - `send`: performs the POST for one entry (throws on failure)
 *  - `now`: returns an ISO timestamp (injectable for tests)
 *  - `failureMessage`: fallback error string (locale differs per client)
 *
 * Behaviour preserved exactly: entries are flushed in optimisticSequence order;
 * each attempt bumps attemptCount + lastAttemptAt; on success the entry is
 * removed; on failure it is marked "retrying" (sticky firstFailedAt) and the loop
 * STOPS (matching both SWs, which break on first failure to preserve ordering).
 */
export interface FlushOutboxQueueDeps {
  send: (entry: PendingOutboxMessage) => Promise<void>
  now: () => Timestamp
  failureMessage?: string
}

export async function flushOutboxQueue<
  S extends {
    clientInstanceId?: string
    outbox: Record<string, PendingOutboxMessage>
  },
>(state: S, deps: FlushOutboxQueueDeps): Promise<S> {
  if (!state.clientInstanceId) {
    return state
  }

  let next = state
  const entries = Object.values(state.outbox).sort(
    (left, right) => left.optimisticSequence - right.optimisticSequence
  )

  for (const entry of entries) {
    const currentEntry = next.outbox[entry.clientMessageId]
    if (!currentEntry) {
      continue
    }

    next = {
      ...next,
      outbox: {
        ...next.outbox,
        [entry.clientMessageId]: {
          ...currentEntry,
          attemptCount: (currentEntry.attemptCount || 0) + 1,
          lastAttemptAt: deps.now(),
        },
      },
    }

    try {
      await deps.send(entry)

      const nextOutbox = { ...next.outbox }
      delete nextOutbox[entry.clientMessageId]
      next = { ...next, outbox: nextOutbox }
    } catch (error) {
      const failedEntry = next.outbox[entry.clientMessageId]
      if (!failedEntry) {
        break
      }
      next = {
        ...next,
        outbox: {
          ...next.outbox,
          [entry.clientMessageId]: {
            ...failedEntry,
            status: "retrying",
            firstFailedAt: failedEntry.firstFailedAt || deps.now(),
            lastErrorMessage:
              error instanceof Error
                ? error.message
                : (deps.failureMessage ?? "Failed to send message"),
          },
        },
      }
      break
    }
  }

  return next
}
