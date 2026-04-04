"use client"

import type {
  CanonicalContentBlock,
  ChatConversationView,
  ConversationReplyRef,
} from "@synapse/shared"

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

export interface StoredChatSnapshot {
  version: 1
  workspaceId: string
  workspaceMemberId?: string
  clientInstanceId?: string
  inboxCursor: number
  lastBootstrappedAt?: string
  conversations: ChatConversationView[]
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

export function createEmptyStoredChatSnapshot(
  workspaceId: string
): StoredChatSnapshot {
  return {
    version: 1,
    workspaceId,
    inboxCursor: 0,
    conversations: [],
    pendingReads: {},
    outbox: {},
  }
}

export function normalizeStoredChatSnapshot(
  workspaceId: string,
  value: unknown
): StoredChatSnapshot {
  if (!value || typeof value !== "object") {
    return createEmptyStoredChatSnapshot(workspaceId)
  }

  const snapshot = value as Partial<StoredChatSnapshot>
  if (snapshot.version !== 1 || snapshot.workspaceId !== workspaceId) {
    return createEmptyStoredChatSnapshot(workspaceId)
  }

  const conversations = Array.isArray(snapshot.conversations)
    ? snapshot.conversations.filter(
        (conversation): conversation is ChatConversationView =>
          Boolean(
            conversation &&
              typeof conversation === "object" &&
              typeof conversation.conversationId === "string" &&
              typeof conversation.workspaceId === "string"
          )
      )
    : []

  const validConversationIds = new Set(
    conversations.map((conversation) => conversation.conversationId)
  )

  const pendingReads =
    snapshot.pendingReads && typeof snapshot.pendingReads === "object"
      ? Object.fromEntries(
          Object.entries(snapshot.pendingReads).filter(
            ([conversationId, entry]) =>
              validConversationIds.has(conversationId) &&
              entry &&
              typeof entry === "object" &&
              typeof entry.conversationId === "string"
          )
        )
      : {}

  const outbox =
    snapshot.outbox && typeof snapshot.outbox === "object"
      ? Object.fromEntries(
          Object.entries(snapshot.outbox).filter(
            ([, entry]) =>
              entry &&
              typeof entry === "object" &&
              typeof entry.conversationId === "string" &&
              validConversationIds.has(entry.conversationId)
          )
        )
      : {}

  return {
    version: 1,
    workspaceId,
    workspaceMemberId:
      typeof snapshot.workspaceMemberId === "string"
        ? snapshot.workspaceMemberId
        : undefined,
    clientInstanceId:
      typeof snapshot.clientInstanceId === "string"
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
    conversations,
    pendingReads,
    outbox,
  }
}

export async function loadStoredChatSnapshot(workspaceId: string) {
  const row = await withStore("readonly", (store) =>
    requestToPromise<{ workspaceId: string; payload: StoredChatSnapshot } | undefined>(
      store.get(workspaceId)
    )
  )

  if (!row?.payload) {
    return null
  }

  return normalizeStoredChatSnapshot(workspaceId, row.payload)
}

export async function saveStoredChatSnapshot(snapshot: StoredChatSnapshot) {
  await withStore("readwrite", (store) =>
    requestToPromise(
      store.put({
        workspaceId: snapshot.workspaceId,
        payload: snapshot,
        updatedAt: new Date().toISOString(),
      })
    )
  )
}

export async function deleteStoredChatSnapshot(workspaceId: string) {
  await withStore("readwrite", (store) =>
    requestToPromise(store.delete(workspaceId))
  )
}
