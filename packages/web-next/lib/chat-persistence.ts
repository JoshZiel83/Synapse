"use client"

import { isUuid } from "@/lib/uuid"
import type { ConversationReplyRef, CanonicalContentBlock } from "@synapse/shared"

export const CHAT_SNAPSHOT_DB_NAME = "synapse-web-next-chat"
export const CHAT_SNAPSHOT_DB_VERSION = 1
export const CHAT_SNAPSHOT_STORE = "workspace_snapshots"

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

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(
      CHAT_SNAPSHOT_DB_NAME,
      CHAT_SNAPSHOT_DB_VERSION
    )

    request.onerror = () => reject(request.error)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(CHAT_SNAPSHOT_STORE)) {
        database.createObjectStore(CHAT_SNAPSHOT_STORE, {
          keyPath: "workspaceId",
        })
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}

function requestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T> | T
) {
  const database = await openDatabase()
  const transaction = database.transaction(CHAT_SNAPSHOT_STORE, mode)
  const store = transaction.objectStore(CHAT_SNAPSHOT_STORE)

  try {
    const result = await run(store)
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    return result
  } finally {
    database.close()
  }
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
          Object.entries(snapshot.outbox).filter(
            ([, entry]) =>
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
  const row = await withStore("readonly", (store) =>
    requestToPromise<
      { workspaceId: string; payload: StoredChatQueueState } | undefined
    >(store.get(workspaceId))
  )

  if (!row?.payload) {
    return null
  }

  return normalizeStoredChatQueueState(workspaceId, row.payload)
}

export async function updateStoredChatQueueState(
  workspaceId: string,
  updater: (current: StoredChatQueueState) => StoredChatQueueState
) {
  await withStore("readwrite", async (store) => {
    const currentRow = await requestToPromise<
      { workspaceId: string; payload: StoredChatQueueState } | undefined
    >(store.get(workspaceId))

    const next = updater(
      normalizeStoredChatQueueState(workspaceId, currentRow?.payload)
    )

    await requestToPromise(
      store.put({
        workspaceId,
        payload: normalizeStoredChatQueueState(workspaceId, next),
        updatedAt: new Date().toISOString(),
      })
    )
  })
}

export async function deleteStoredChatQueueState(workspaceId: string) {
  await withStore("readwrite", (store) =>
    requestToPromise(store.delete(workspaceId))
  )
}
