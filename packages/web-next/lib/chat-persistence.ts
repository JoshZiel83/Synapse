"use client"

import { openDB, type DBSchema, type IDBPDatabase } from "idb"

import {
  CHAT_QUEUE_DB_NAME,
  CHAT_QUEUE_DB_VERSION,
  CHAT_QUEUE_STATE_STORE,
  createEmptyStoredChatQueueState,
  mergeStoredQueueTransition,
  normalizeStoredChatQueueState,
  sameStoredChatQueueState,
  type PendingConversationRead,
  type PendingOutboxMessage,
  type StoredChatQueueState,
} from "@synapse/shared"

export {
  CHAT_QUEUE_DB_NAME,
  CHAT_QUEUE_DB_VERSION,
  CHAT_QUEUE_STATE_STORE,
  createEmptyStoredChatQueueState,
  mergeStoredQueueTransition,
  normalizeStoredChatQueueState,
  sameStoredChatQueueState,
}
export type {
  PendingConversationRead,
  PendingOutboxMessage,
  StoredChatQueueState,
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
