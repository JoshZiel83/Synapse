import { openDB, type DBSchema, type IDBPDatabase } from "idb"

import {
  createEmptyChatWorkspaceQueueState,
  normalizeChatWorkspaceQueueState,
  type ChatWorkspaceQueueState,
} from "@/lib/chat-data"
import {
  CHAT_QUEUE_DB_NAME,
  CHAT_QUEUE_DB_VERSION,
  CHAT_QUEUE_STATE_STORE,
} from "@shared/chat-queue"
import type { Timestamp } from "@shared"
import { nowIsoInstant } from "@shared/datetime"

// Mobile keeps its historical constant names but derives the actual
// string values from @synapse/shared so web + mobile cannot diverge.
export const CHAT_WEB_QUEUE_DB_NAME = CHAT_QUEUE_DB_NAME
export const CHAT_WEB_QUEUE_DB_VERSION = CHAT_QUEUE_DB_VERSION
export const CHAT_WEB_QUEUE_STATE_STORE = CHAT_QUEUE_STATE_STORE

const CHAT_WEB_WORKER_DB_NAME = "synapse-chat-worker"
const CHAT_WEB_WORKER_DB_VERSION = 1
const CHAT_WEB_WORKER_AUTH_CONTEXT_STORE = "auth_context"

export interface MobileChatWorkerAuthContext {
  token: string
  workspaceId: string
  apiBase: string
}

interface ChatQueueStateRow {
  workspaceId: string
  payload: ChatWorkspaceQueueState
  updatedAt: Timestamp
}

interface ChatWorkerAuthContextRow {
  key: "active"
  payload: MobileChatWorkerAuthContext
  updatedAt: Timestamp
}

interface ChatWebQueueDatabaseSchema extends DBSchema {
  [CHAT_WEB_QUEUE_STATE_STORE]: {
    key: string
    value: ChatQueueStateRow
  }
}

interface ChatWorkerDatabaseSchema extends DBSchema {
  [CHAT_WEB_WORKER_AUTH_CONTEXT_STORE]: {
    key: string
    value: ChatWorkerAuthContextRow
  }
}

let queueDbPromise: Promise<IDBPDatabase<ChatWebQueueDatabaseSchema>> | null =
  null
let workerDbPromise: Promise<IDBPDatabase<ChatWorkerDatabaseSchema>> | null =
  null

function getQueueDatabase() {
  if (!queueDbPromise) {
    queueDbPromise = openDB<ChatWebQueueDatabaseSchema>(
      CHAT_WEB_QUEUE_DB_NAME,
      CHAT_WEB_QUEUE_DB_VERSION,
      {
        upgrade(database) {
          if (!database.objectStoreNames.contains(CHAT_WEB_QUEUE_STATE_STORE)) {
            database.createObjectStore(CHAT_WEB_QUEUE_STATE_STORE, {
              keyPath: "workspaceId",
            })
          }
        },
      }
    )
  }

  return queueDbPromise
}

function getWorkerDatabase() {
  if (!workerDbPromise) {
    workerDbPromise = openDB<ChatWorkerDatabaseSchema>(
      CHAT_WEB_WORKER_DB_NAME,
      CHAT_WEB_WORKER_DB_VERSION,
      {
        upgrade(database) {
          if (
            !database.objectStoreNames.contains(
              CHAT_WEB_WORKER_AUTH_CONTEXT_STORE
            )
          ) {
            database.createObjectStore(CHAT_WEB_WORKER_AUTH_CONTEXT_STORE, {
              keyPath: "key",
            })
          }
        },
      }
    )
  }

  return workerDbPromise
}

export function createEmptyStoredChatWorkspaceQueueState(
  workspaceId: string
): ChatWorkspaceQueueState {
  // Delegate to the canonical factory so the version + shape (incl. tombstones)
  // stay in lockstep with chat-data.ts — this web-queue shim must not fork it.
  return createEmptyChatWorkspaceQueueState(workspaceId)
}

export function normalizeStoredChatWorkspaceQueueState(
  workspaceId: string,
  value: unknown
): ChatWorkspaceQueueState {
  // Delegate to the canonical normalizer (handles v1→v2 migration + tombstones).
  return normalizeChatWorkspaceQueueState(workspaceId, value)
}

export async function loadStoredChatWorkspaceQueueState(workspaceId: string) {
  const database = await getQueueDatabase()
  const row = await database.get(CHAT_WEB_QUEUE_STATE_STORE, workspaceId)

  if (!row?.payload) {
    return null
  }

  return normalizeStoredChatWorkspaceQueueState(workspaceId, row.payload)
}

export async function saveStoredChatWorkspaceQueueState(
  queueState: ChatWorkspaceQueueState
) {
  const database = await getQueueDatabase()
  await database.put(CHAT_WEB_QUEUE_STATE_STORE, {
    workspaceId: queueState.workspaceId,
    payload: normalizeStoredChatWorkspaceQueueState(
      queueState.workspaceId,
      queueState
    ),
    updatedAt: nowIsoInstant(),
  })
}

export async function deleteStoredChatWorkspaceQueueState(workspaceId: string) {
  const database = await getQueueDatabase()
  await database.delete(CHAT_WEB_QUEUE_STATE_STORE, workspaceId)
}

export async function clearStoredChatWorkspaceQueueState() {
  const database = await getQueueDatabase()
  await database.clear(CHAT_WEB_QUEUE_STATE_STORE)
}

export async function loadStoredChatWorkerAuthContext() {
  const database = await getWorkerDatabase()
  const row = await database.get(CHAT_WEB_WORKER_AUTH_CONTEXT_STORE, "active")
  return row?.payload ?? null
}

export async function saveStoredChatWorkerAuthContext(
  payload: MobileChatWorkerAuthContext
) {
  const database = await getWorkerDatabase()
  await database.put(CHAT_WEB_WORKER_AUTH_CONTEXT_STORE, {
    key: "active",
    payload,
    updatedAt: nowIsoInstant(),
  })
}

export async function clearStoredChatWorkerAuthContext() {
  const database = await getWorkerDatabase()
  await database.delete(CHAT_WEB_WORKER_AUTH_CONTEXT_STORE, "active")
}

export function sameStoredChatQueueState(
  left: ChatWorkspaceQueueState,
  right: ChatWorkspaceQueueState
) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function sameStoredChatQueueEntry(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}
