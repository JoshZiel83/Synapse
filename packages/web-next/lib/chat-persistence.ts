"use client"

import { openDB, type DBSchema, type IDBPDatabase } from "idb"

import { isUuid } from "@/lib/uuid"
import type {
  ConversationReplyRef,
  CanonicalContentBlock,
} from "@synapse/shared"

export const CHAT_QUEUE_DB_NAME = "synapse-web-chat-queue"
export const CHAT_QUEUE_DB_VERSION = 1
export const CHAT_QUEUE_STATE_STORE = "workspace_queue_states"

export interface PendingConversationRead {
  conversationId: string
  readUpToSequence: number
  lastVisibleSequence: number
  updatedAt: string
}

export interface PendingOutboxMessage {
  clientMessageId: string
  conversationId: string
  contentBlocks: CanonicalContentBlock[]
  replyToItemId?: string
  replyTo?: ConversationReplyRef
  createdAt: string
  optimisticSequence: number
  status: "sending" | "retrying"
  attemptCount: number
  lastAttemptAt?: string
  firstFailedAt?: string
  lastErrorMessage?: string
}

export interface StoredChatQueueState {
  version: 3
  workspaceId: string
  workspaceMemberId?: string
  clientInstanceId?: string
  inboxCursor: number
  lastBootstrappedAt?: string
  pendingReads: Record<string, PendingConversationRead>
  outbox: Record<string, PendingOutboxMessage>
}

interface ChatQueueStateRow {
  workspaceId: string
  payload: StoredChatQueueState
  updatedAt: string
}

interface ChatQueueDatabaseSchema extends DBSchema {
  [CHAT_QUEUE_STATE_STORE]: {
    key: string
    value: ChatQueueStateRow
  }
}

let queueDbPromise: Promise<IDBPDatabase<ChatQueueDatabaseSchema>> | null = null

function getQueueDatabase() {
  if (!queueDbPromise) {
    queueDbPromise = openDB<ChatQueueDatabaseSchema>(
      CHAT_QUEUE_DB_NAME,
      CHAT_QUEUE_DB_VERSION,
      {
        upgrade(database) {
          if (!database.objectStoreNames.contains(CHAT_QUEUE_STATE_STORE)) {
            database.createObjectStore(CHAT_QUEUE_STATE_STORE, {
              keyPath: "workspaceId",
            })
          }
        },
      }
    )
  }

  return queueDbPromise
}

export function createEmptyStoredChatQueueState(
  workspaceId: string
): StoredChatQueueState {
  return {
    version: 3,
    workspaceId,
    inboxCursor: 0,
    pendingReads: {},
    outbox: {},
  }
}

export function normalizeStoredChatQueueState(
  workspaceId: string,
  value: unknown
): StoredChatQueueState {
  if (!value || typeof value !== "object") {
    return createEmptyStoredChatQueueState(workspaceId)
  }

  const snapshot = value as Partial<StoredChatQueueState>
  if (snapshot.version !== 3 || snapshot.workspaceId !== workspaceId) {
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
                typeof entry.conversationId === "string"
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
              typeof entry.clientMessageId === "string" &&
              typeof entry.conversationId === "string"
            )
          )
        )
      : {}

  return {
    version: 3,
    workspaceId,
    workspaceMemberId:
      typeof snapshot.workspaceMemberId === "string"
        ? snapshot.workspaceMemberId
        : undefined,
    clientInstanceId:
      typeof snapshot.clientInstanceId === "string" &&
      isUuid(snapshot.clientInstanceId)
        ? snapshot.clientInstanceId
        : undefined,
    inboxCursor:
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
  }
}

export async function loadStoredChatQueueState(workspaceId: string) {
  const database = await getQueueDatabase()
  const row = await database.get(CHAT_QUEUE_STATE_STORE, workspaceId)

  if (!row?.payload) {
    return null
  }

  return normalizeStoredChatQueueState(workspaceId, row.payload)
}

export async function saveStoredChatQueueState(
  queueState: StoredChatQueueState
) {
  const database = await getQueueDatabase()
  await database.put(CHAT_QUEUE_STATE_STORE, {
    workspaceId: queueState.workspaceId,
    payload: normalizeStoredChatQueueState(queueState.workspaceId, queueState),
    updatedAt: new Date().toISOString(),
  })
}

export async function updateStoredChatQueueState(
  workspaceId: string,
  updater: (current: StoredChatQueueState) => StoredChatQueueState
) {
  const database = await getQueueDatabase()
  const transaction = database.transaction(CHAT_QUEUE_STATE_STORE, "readwrite")
  const store = transaction.objectStore(CHAT_QUEUE_STATE_STORE)

  const currentRow = await store.get(workspaceId)
  const next = updater(
    normalizeStoredChatQueueState(workspaceId, currentRow?.payload)
  )

  await store.put({
    workspaceId,
    payload: normalizeStoredChatQueueState(workspaceId, next),
    updatedAt: new Date().toISOString(),
  })
  await transaction.done
}

export async function deleteStoredChatQueueState(workspaceId: string) {
  const database = await getQueueDatabase()
  await database.delete(CHAT_QUEUE_STATE_STORE, workspaceId)
}

export function sameStoredChatQueueState(
  left: StoredChatQueueState,
  right: StoredChatQueueState
) {
  return JSON.stringify(left) === JSON.stringify(right)
}

// ---- Shared queue-transition merge (used by both chat-store and the
// service worker so the two cannot drift) ----

function latestIsoTimestamp(
  currentValue?: string,
  nextValue?: string
): string | undefined {
  if (!currentValue) return nextValue
  if (!nextValue) return currentValue
  return new Date(currentValue).getTime() >= new Date(nextValue).getTime()
    ? currentValue
    : nextValue
}

function sameStoredEntry(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
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
  }
}
