import {
  clearStoredChatWorkerAuthContext,
  createEmptyStoredChatWorkspaceQueueState,
  loadStoredChatWorkerAuthContext,
  loadStoredChatWorkspaceQueueState,
  sameStoredChatQueueState,
  saveStoredChatWorkerAuthContext,
  saveStoredChatWorkspaceQueueState,
  type MobileChatWorkerAuthContext,
} from "../lib/chat-web-queue-storage"
import { mergeQueueStateForSave } from "@shared"
import {
  CHAT_WEB_SERVICE_WORKER_BROADCAST_CHANNEL,
  CHAT_WEB_SERVICE_WORKER_PERIODIC_SYNC_TAG,
  CHAT_WEB_SERVICE_WORKER_SYNC_TAG,
} from "../lib/storage-keys"

type ChatWorkerMessage =
  | {
      type: "chat:set-auth-context"
      payload: MobileChatWorkerAuthContext
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
      type: "chat:sync-failed"
      payload?: {
        reason?: string
      }
    }
  | {
      type: "chat:auth-expired"
    }

type ExtendableEventLike = Event & {
  waitUntil: (promise: Promise<unknown>) => void
}

type BackgroundSyncEventLike = ExtendableEventLike & {
  tag?: string
}

type ErrorWithStatus = Error & {
  status?: number
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
  addEventListener: (type: string, listener: (event: any) => void) => void
}

type ExtendableMessageEventLike = ExtendableEventLike & {
  data: unknown
}

const scope = self as unknown as ServiceWorkerScopeLike

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
        saveStoredChatWorkerAuthContext(message.payload).then(() =>
          runSyncPass(message.payload.workspaceId, "auth-context")
        )
      )
      break
    case "chat:clear-auth-context":
      event.waitUntil(clearStoredChatWorkerAuthContext())
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
  auth: MobileChatWorkerAuthContext,
  path: string,
  options?: RequestInit
) {
  const response = await fetch(`${auth.apiBase}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  })

  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(
      (data && data.error) || "Request failed"
    ) as ErrorWithStatus
    error.status = response.status
    throw error
  }

  return data
}

async function flushPendingReads(
  auth: MobileChatWorkerAuthContext,
  queueState: ReturnType<typeof createEmptyStoredChatWorkspaceQueueState>
) {
  if (!queueState.clientInstanceId) {
    return queueState
  }

  let next = queueState
  const entries = Object.values(queueState.pendingReads).sort(
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
            clientInstanceId: queueState.clientInstanceId,
            readUpToSequence: entry.readUpToSequence,
            lastVisibleSequence: entry.lastVisibleSequence,
          }),
        }
      )

      const pendingReads = { ...next.pendingReads }
      const queued = pendingReads[entry.conversationId]
      if (queued && queued.readUpToSequence <= response.readWatermarkSequence) {
        delete pendingReads[entry.conversationId]
      }

      next = {
        ...next,
        pendingReads,
      }
    } catch {
      break
    }
  }

  return next
}

async function flushOutbox(
  auth: MobileChatWorkerAuthContext,
  queueState: ReturnType<typeof createEmptyStoredChatWorkspaceQueueState>
) {
  if (!queueState.clientInstanceId) {
    return queueState
  }

  let next = queueState
  const entries = Object.values(queueState.outbox).sort(
    (left, right) => left.optimisticSequence - right.optimisticSequence
  )

  for (const entry of entries) {
    if (!next.outbox[entry.clientMessageId]) {
      continue
    }

    next = {
      ...next,
      outbox: {
        ...next.outbox,
        [entry.clientMessageId]: {
          ...next.outbox[entry.clientMessageId],
          attemptCount:
            (next.outbox[entry.clientMessageId].attemptCount || 0) + 1,
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
            clientInstanceId: queueState.clientInstanceId,
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
      const currentEntry = next.outbox[entry.clientMessageId]
      if (!currentEntry) {
        break
      }

      next = {
        ...next,
        outbox: {
          ...next.outbox,
          [entry.clientMessageId]: {
            ...currentEntry,
            status: "retrying",
            firstFailedAt:
              currentEntry.firstFailedAt || new Date().toISOString(),
            lastErrorMessage:
              error instanceof Error ? error.message : "发送失败",
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
    const auth = await loadStoredChatWorkerAuthContext()
    if (
      !auth ||
      !auth.token ||
      !(workspaceIdOverride || auth.workspaceId) ||
      !auth.apiBase
    ) {
      return
    }

    const effectiveAuth = {
      ...auth,
      workspaceId: workspaceIdOverride || auth.workspaceId,
    }

    const baseQueueState =
      (await loadStoredChatWorkspaceQueueState(effectiveAuth.workspaceId)) ||
      createEmptyStoredChatWorkspaceQueueState(effectiveAuth.workspaceId)
    let processedQueueState = baseQueueState
    processedQueueState = await flushPendingReads(
      effectiveAuth,
      processedQueueState
    )
    processedQueueState = await flushOutbox(effectiveAuth, processedQueueState)

    const latestQueueState =
      (await loadStoredChatWorkspaceQueueState(effectiveAuth.workspaceId)) ||
      createEmptyStoredChatWorkspaceQueueState(effectiveAuth.workspaceId)
    const nextQueueState = mergeQueueStateForSave(
      baseQueueState,
      latestQueueState,
      processedQueueState
    )

    if (sameStoredChatQueueState(latestQueueState, nextQueueState)) {
      return
    }

    await saveStoredChatWorkspaceQueueState(nextQueueState)
    await broadcast({
      type: "chat:queue-updated",
      payload: {
        workspaceId: effectiveAuth.workspaceId,
        reason: reason || "sync-pass",
      },
    })
  } catch (error) {
    if ((error as ErrorWithStatus | null)?.status === 401) {
      await broadcast({
        type: "chat:auth-expired",
      })
      return
    }

    await broadcast({
      type: "chat:sync-failed",
      payload: {
        reason: reason || "sync-pass",
      },
    })
  }
}
