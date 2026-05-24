import { openDB, type DBSchema, type IDBPDatabase } from "idb"

import { isUuid } from "@/lib/ids"
import type {
  ChatWorkspaceQueueState,
  PendingChatOutboxMessage,
  PendingChatRead,
} from "@/lib/chat-data"
import {
  CHAT_QUEUE_DB_NAME,
  CHAT_QUEUE_DB_VERSION,
  CHAT_QUEUE_STATE_STORE,
} from "@shared"

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
  updatedAt: string
}

interface ChatWorkerAuthContextRow {
  key: "active"
  payload: MobileChatWorkerAuthContext
  updatedAt: string
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
  return {
    version: 1,
    workspaceId,
    inboxCursor: 0,
    pendingReads: {},
    outbox: {},
  }
}

function normalizePendingReads(
  value: unknown
): Record<string, PendingChatRead> {
  if (!value || typeof value !== "object") {
    return {}
  }

  return Object.fromEntries(
    Object.values(value as Record<string, unknown>)
      .filter((entry): entry is PendingChatRead =>
        Boolean(
          entry &&
          typeof entry === "object" &&
          typeof (entry as { conversationId?: unknown }).conversationId ===
            "string" &&
          typeof (entry as { readUpToSequence?: unknown }).readUpToSequence ===
            "number" &&
          typeof (entry as { lastVisibleSequence?: unknown })
            .lastVisibleSequence === "number" &&
          typeof (entry as { updatedAt?: unknown }).updatedAt === "string"
        )
      )
      .map((entry) => [entry.conversationId, entry] as const)
  )
}

function normalizeOutbox(
  value: unknown
): Record<string, PendingChatOutboxMessage> {
  if (!value || typeof value !== "object") {
    return {}
  }

  return Object.fromEntries(
    Object.values(value as Record<string, unknown>)
      .filter((entry): entry is PendingChatOutboxMessage =>
        Boolean(
          entry &&
          typeof entry === "object" &&
          typeof (entry as { clientMessageId?: unknown }).clientMessageId ===
            "string" &&
          typeof (entry as { conversationId?: unknown }).conversationId ===
            "string" &&
          Array.isArray((entry as { contentBlocks?: unknown }).contentBlocks) &&
          typeof (entry as { createdAt?: unknown }).createdAt === "string" &&
          typeof (entry as { optimisticSequence?: unknown })
            .optimisticSequence === "number" &&
          typeof (entry as { status?: unknown }).status === "string" &&
          typeof (entry as { attemptCount?: unknown }).attemptCount === "number"
        )
      )
      .map((entry) => [entry.clientMessageId, entry] as const)
  )
}

export function normalizeStoredChatWorkspaceQueueState(
  workspaceId: string,
  value: unknown
): ChatWorkspaceQueueState {
  if (!value || typeof value !== "object") {
    return createEmptyStoredChatWorkspaceQueueState(workspaceId)
  }

  const queueState = value as Partial<ChatWorkspaceQueueState>
  if (queueState.version !== 1 || queueState.workspaceId !== workspaceId) {
    return createEmptyStoredChatWorkspaceQueueState(workspaceId)
  }

  return {
    version: 1,
    workspaceId,
    workspaceMemberId:
      typeof queueState.workspaceMemberId === "string"
        ? queueState.workspaceMemberId
        : undefined,
    clientInstanceId:
      typeof queueState.clientInstanceId === "string" &&
      isUuid(queueState.clientInstanceId)
        ? queueState.clientInstanceId
        : undefined,
    inboxCursor:
      typeof queueState.inboxCursor === "number" &&
      Number.isFinite(queueState.inboxCursor)
        ? queueState.inboxCursor
        : 0,
    lastBootstrappedAt:
      typeof queueState.lastBootstrappedAt === "string"
        ? queueState.lastBootstrappedAt
        : undefined,
    pendingReads: normalizePendingReads(queueState.pendingReads),
    outbox: normalizeOutbox(queueState.outbox),
  }
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
    updatedAt: new Date().toISOString(),
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
    updatedAt: new Date().toISOString(),
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
