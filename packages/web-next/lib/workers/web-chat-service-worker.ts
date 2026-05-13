import { openDB, type DBSchema, type IDBPDatabase } from "idb"

import {
  CHAT_WEB_SERVICE_WORKER_BROADCAST_CHANNEL,
  CHAT_WEB_SERVICE_WORKER_PERIODIC_SYNC_TAG,
  CHAT_WEB_SERVICE_WORKER_SYNC_TAG,
} from "../chat-service-worker-constants"
import {
  createEmptyStoredChatQueueState,
  loadStoredChatQueueState,
  sameStoredChatQueueState,
  saveStoredChatQueueState,
} from "../chat-persistence"

type ChatWorkerMessage =
  | {
      type: "chat:set-auth-context"
      payload: {
        workspaceId: string
        apiBase: string
      }
    }
  | {
      type: "chat:clear-auth-context"
    }
  | {
      type: "chat:run-sync"
      payload?: { reason?: string }
    }

type ChatWorkerBroadcast =
  | {
      type: "chat:queue-updated"
      payload: {
        workspaceId: string
        reason?: string
      }
    }
  | {
      type: "chat:queue-sync-failed"
      payload?: {
        reason?: string
      }
    }

type ChatWorkerAuthContext = {
  workspaceId: string
  apiBase: string
}

type BackgroundSyncEventLike = Event & {
  tag?: string
  waitUntil: (promise: Promise<unknown>) => void
}

interface WorkerAuthContextRow {
  key: "active"
  payload: ChatWorkerAuthContext
  updatedAt: string
}

interface WorkerDatabaseSchema extends DBSchema {
  auth_context: {
    key: string
    value: WorkerAuthContextRow
  }
}

const CHAT_WORKER_DB_NAME = "synapse-web-chat-worker"
const CHAT_WORKER_DB_VERSION = 1
const CHAT_WORKER_AUTH_CONTEXT_STORE = "auth_context"

type ExtendableEventLike = Event & {
  waitUntil: (promise: Promise<unknown>) => void
}

type WindowClientLike = {
  postMessage: (message: unknown) => void
}

type ServiceWorkerScopeLike = {
  skipWaiting: () => Promise<void>
  clients: {
    claim: () => Promise<void>
    matchAll: (options?: {
      includeUncontrolled?: boolean
      type?: "window"
    }) => Promise<WindowClientLike[]>
  }
  location: Location
  addEventListener: (type: string, listener: (event: any) => void) => void
}

type ExtendableMessageEventLike = ExtendableEventLike & {
  data: unknown
}

const scope = self as unknown as ServiceWorkerScopeLike

let workerDbPromise: Promise<IDBPDatabase<WorkerDatabaseSchema>> | null = null

function getWorkerDatabase() {
  if (!workerDbPromise) {
    workerDbPromise = openDB<WorkerDatabaseSchema>(
      CHAT_WORKER_DB_NAME,
      CHAT_WORKER_DB_VERSION,
      {
        upgrade(database) {
          if (
            !database.objectStoreNames.contains(CHAT_WORKER_AUTH_CONTEXT_STORE)
          ) {
            database.createObjectStore(CHAT_WORKER_AUTH_CONTEXT_STORE, {
              keyPath: "key",
            })
          }
        },
      }
    )
  }

  return workerDbPromise
}

async function loadAuthContext() {
  const database = await getWorkerDatabase()
  const row = await database.get(CHAT_WORKER_AUTH_CONTEXT_STORE, "active")
  return row?.payload ?? null
}

async function saveAuthContext(payload: ChatWorkerAuthContext) {
  const database = await getWorkerDatabase()
  await database.put(CHAT_WORKER_AUTH_CONTEXT_STORE, {
    key: "active",
    payload,
    updatedAt: new Date().toISOString(),
  })
}

async function clearAuthContext() {
  const database = await getWorkerDatabase()
  await database.delete(CHAT_WORKER_AUTH_CONTEXT_STORE, "active")
}

function sameStoredEntry(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function latestIsoTimestamp(currentValue?: string, nextValue?: string) {
  if (!currentValue) {
    return nextValue
  }
  if (!nextValue) {
    return currentValue
  }
  return new Date(currentValue).getTime() >= new Date(nextValue).getTime()
    ? currentValue
    : nextValue
}

function mergeStoredQueueTransition(
  currentState: ReturnType<typeof createEmptyStoredChatQueueState>,
  previousState: ReturnType<typeof createEmptyStoredChatQueueState> | null,
  nextState: ReturnType<typeof createEmptyStoredChatQueueState>
) {
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
      nextState.workspaceMemberId || nextWorkspaceState.workspaceMemberId,
    clientInstanceId:
      nextState.clientInstanceId || nextWorkspaceState.clientInstanceId,
    inboxCursor: Math.max(
      nextWorkspaceState.inboxCursor || 0,
      nextState.inboxCursor || 0
    ),
    lastBootstrappedAt: latestIsoTimestamp(
      nextWorkspaceState.lastBootstrappedAt,
      nextState.lastBootstrappedAt
    ),
    pendingReads: nextPendingReads,
    outbox: nextOutbox,
  }
}

function resolveApiUrl(apiBase: string, path: string) {
  const base =
    typeof apiBase === "string" && apiBase.trim() ? apiBase.trim() : "/api/v1"
  return new URL(
    `${base.replace(/\/$/, "")}${path}`,
    scope.location.origin
  ).toString()
}

scope.addEventListener("install", (event: ExtendableEventLike) => {
  event.waitUntil(scope.skipWaiting())
})

scope.addEventListener("activate", (event: ExtendableEventLike) => {
  event.waitUntil(scope.clients.claim())
})

scope.addEventListener("message", (event: ExtendableMessageEventLike) => {
  const message = (event.data || {}) as ChatWorkerMessage
  switch (message.type) {
    case "chat:set-auth-context":
      event.waitUntil(
        saveAuthContext(message.payload).then(() =>
          runSyncPass(message.payload.workspaceId, "auth-context")
        )
      )
      break
    case "chat:clear-auth-context":
      event.waitUntil(clearAuthContext())
      break
    case "chat:run-sync":
      event.waitUntil(runSyncPass(null, message.payload?.reason))
      break
  }
})

scope.addEventListener("sync", (event: Event) => {
  const syncEvent = event as BackgroundSyncEventLike
  if (syncEvent.tag === CHAT_WEB_SERVICE_WORKER_SYNC_TAG) {
    syncEvent.waitUntil(runSyncPass(null, "background-sync"))
  }
})

scope.addEventListener("periodicsync", (event: Event) => {
  const syncEvent = event as BackgroundSyncEventLike
  if (syncEvent.tag === CHAT_WEB_SERVICE_WORKER_PERIODIC_SYNC_TAG) {
    syncEvent.waitUntil(runSyncPass(null, "periodic-sync"))
  }
})

async function fetchJson(
  auth: ChatWorkerAuthContext,
  path: string,
  options?: RequestInit
) {
  const response = await fetch(resolveApiUrl(auth.apiBase, path), {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  })

  const data = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error((data && data.error) || "Request failed")
  }

  return data
}

function applyReadWatermarkAck(
  snapshot: ReturnType<typeof createEmptyStoredChatQueueState>,
  response: {
    conversationId: string
    readWatermarkSequence: number
  }
) {
  const pendingReads = { ...snapshot.pendingReads }
  const queued = pendingReads[response.conversationId]
  if (queued && queued.readUpToSequence <= response.readWatermarkSequence) {
    delete pendingReads[response.conversationId]
  }

  return {
    ...snapshot,
    pendingReads,
  }
}

async function flushPendingReads(
  auth: ChatWorkerAuthContext,
  snapshot: ReturnType<typeof createEmptyStoredChatQueueState>
) {
  if (!snapshot.clientInstanceId) {
    return snapshot
  }

  let next = snapshot
  const entries = Object.values(snapshot.pendingReads).sort(
    (left, right) => left.readUpToSequence - right.readUpToSequence
  )

  for (const entry of entries) {
    try {
      const response = await fetchJson(
        auth,
        `/workspaces/${auth.workspaceId}/chat/conversations/${entry.conversationId}/read-watermark`,
        {
          method: "POST",
          body: JSON.stringify({
            clientInstanceId: snapshot.clientInstanceId,
            readUpToSequence: entry.readUpToSequence,
            lastVisibleSequence: entry.lastVisibleSequence,
          }),
        }
      )
      next = applyReadWatermarkAck(next, response)
    } catch {
      break
    }
  }

  return next
}

async function flushOutbox(
  auth: ChatWorkerAuthContext,
  snapshot: ReturnType<typeof createEmptyStoredChatQueueState>
) {
  if (!snapshot.clientInstanceId) {
    return snapshot
  }

  let next = snapshot
  const entries = Object.values(snapshot.outbox).sort(
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
          lastAttemptAt: new Date().toISOString(),
        },
      },
    }

    try {
      await fetchJson(
        auth,
        `/workspaces/${auth.workspaceId}/chat/conversations/${entry.conversationId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            clientInstanceId: snapshot.clientInstanceId,
            clientMessageId: entry.clientMessageId,
            contentBlocks: entry.contentBlocks,
            replyToItemId: entry.replyToItemId,
          }),
        }
      )

      const nextOutbox = { ...next.outbox }
      delete nextOutbox[entry.clientMessageId]

      next = {
        ...next,
        outbox: nextOutbox,
      }
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
            firstFailedAt:
              failedEntry.firstFailedAt || new Date().toISOString(),
            lastErrorMessage:
              error instanceof Error ? error.message : "Failed to send message",
          },
        },
      }
      break
    }
  }

  return next
}

async function broadcast(message: ChatWorkerBroadcast) {
  try {
    if ("BroadcastChannel" in scope) {
      const channel = new BroadcastChannel(
        CHAT_WEB_SERVICE_WORKER_BROADCAST_CHANNEL
      )
      channel.postMessage(message)
      channel.close()
    }
  } catch {
    // Ignore channel failures and fall back to window clients below.
  }

  const clients = await scope.clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  })

  for (const client of clients) {
    client.postMessage(message)
  }
}

async function runSyncPass(
  workspaceIdOverride: string | null,
  reason?: string
) {
  try {
    const auth = await loadAuthContext()
    if (!auth || !auth.workspaceId || !auth.apiBase) {
      return
    }

    const effectiveAuth = {
      ...auth,
      workspaceId: workspaceIdOverride || auth.workspaceId,
    }

    const startingSnapshot =
      (await loadStoredChatQueueState(effectiveAuth.workspaceId)) ||
      createEmptyStoredChatQueueState(effectiveAuth.workspaceId)
    if (!startingSnapshot.clientInstanceId) {
      return
    }

    let nextSnapshot = await flushPendingReads(effectiveAuth, startingSnapshot)
    nextSnapshot = await flushOutbox(effectiveAuth, nextSnapshot)

    if (!sameStoredChatQueueState(startingSnapshot, nextSnapshot)) {
      await saveStoredChatQueueState(
        mergeStoredQueueTransition(
          (await loadStoredChatQueueState(effectiveAuth.workspaceId)) ||
            createEmptyStoredChatQueueState(effectiveAuth.workspaceId),
          startingSnapshot,
          nextSnapshot
        )
      )
    }

    await broadcast({
      type: "chat:queue-updated",
      payload: {
        workspaceId: effectiveAuth.workspaceId,
        reason: reason || "queue-sync",
      },
    })
  } catch {
    await broadcast({
      type: "chat:queue-sync-failed",
      payload: {
        reason: reason || "queue-sync",
      },
    })
  }
}
