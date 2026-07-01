"use client"

import { useCallback, useEffect, useMemo } from "react"
import {
  extractText,
  type ChatSocketEvent,
  type ChatSyncEvent,
} from "@synapse/shared"

import { useNotifications } from "@/hooks/use-notifications"
import { useWebSocket, type WebSocketSubscription } from "@/hooks/use-websocket"
import {
  ensureChatServiceWorkerRegistered,
  requestChatServiceWorkerSync,
  subscribeToChatServiceWorker,
  syncChatServiceWorkerAuthContext,
} from "@/lib/chat-service-worker"
import { useChatStore } from "@/stores/chat-store"

export function useChatRealtimeSync({
  workspaceId,
  selectedConversationId,
}: {
  workspaceId: string | null
  selectedConversationId?: string | null
}) {
  const { notify } = useNotifications()
  const outboxCount = useChatStore((state) => Object.keys(state.outbox).length)
  const pendingReadCount = useChatStore(
    (state) => Object.keys(state.pendingReads).length
  )
  const clientInstanceId = useChatStore((state) => state.clientInstanceId)
  const deactivate = useChatStore((state) => state.deactivate)
  const loadConversations = useChatStore((state) => state.loadConversations)
  const reloadPersistedSnapshot = useChatStore(
    (state) => state.reloadPersistedSnapshot
  )
  const flushOutbox = useChatStore((state) => state.flushOutbox)
  const syncFromServer = useChatStore((state) => state.syncFromServer)
  const handleSyncEvent = useChatStore((state) => state.handleSyncEvent)
  const handleRuntimeUpdated = useChatStore(
    (state) => state.handleRuntimeUpdated
  )
  const handleTypingEvent = useChatStore((state) => state.handleTypingEvent)

  const onEvent = useCallback(
    (event: ChatSocketEvent | Record<string, unknown>) => {
      if (
        !event ||
        typeof event !== "object" ||
        typeof event.type !== "string"
      ) {
        return
      }

      switch (event.type) {
        case "chat.sync.event": {
          const payload = (event as ChatSocketEvent<"chat.sync.event">).payload
          handleSyncEvent(payload)

          if (payload.eventType !== "conversation.item.created") {
            break
          }

          const syncPayload =
            payload.payload as ChatSyncEvent<"conversation.item.created">["payload"]
          const item = syncPayload.item
          if (item.itemType === "event" || item.role !== "assistant") {
            break
          }

          const content = extractText(item.contentBlocks || [])
          const name = item.author?.name || "Synapse"
          notify(name, content, payload.conversationId)
          break
        }
        case "runtime.updated":
          handleRuntimeUpdated(
            (event as ChatSocketEvent<"runtime.updated">).payload
          )
          break
        case "chat.typing":
          handleTypingEvent((event as ChatSocketEvent<"chat.typing">).payload)
          break
        default:
          break
      }
    },
    [handleRuntimeUpdated, handleSyncEvent, handleTypingEvent, notify]
  )

  const subscriptions = useMemo<WebSocketSubscription[]>(() => {
    const next: WebSocketSubscription[] = []
    if (workspaceId) {
      next.push({
        key: `inbox:${workspaceId}`,
        topic: "inbox",
      })
    }
    if (selectedConversationId) {
      next.push({
        key: `conversation:${selectedConversationId}`,
        topic: "conversation",
        conversationId: selectedConversationId,
      })
    }
    return next
  }, [selectedConversationId, workspaceId])

  const handleSocketConnected = useCallback(() => {
    if (!workspaceId) {
      return
    }

    void syncFromServer(workspaceId)
    void flushOutbox(workspaceId)
  }, [flushOutbox, syncFromServer, workspaceId])

  useWebSocket({
    enabled: Boolean(workspaceId),
    workspaceId,
    subscriptions,
    onEvent,
    onConnected: handleSocketConnected,
  })

  useEffect(() => {
    if (!workspaceId) {
      deactivate()
      void syncChatServiceWorkerAuthContext({ workspaceId: null })
      return
    }

    void ensureChatServiceWorkerRegistered()
    void syncChatServiceWorkerAuthContext({ workspaceId })
    void loadConversations(workspaceId)

    return () => {
      void syncChatServiceWorkerAuthContext({ workspaceId: null })
    }
  }, [deactivate, loadConversations, workspaceId])

  useEffect(() => {
    if (!workspaceId) {
      return
    }
    const activeWorkspaceId = workspaceId

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        void syncFromServer(activeWorkspaceId)
      }
    }

    function handleOnline() {
      void syncFromServer(activeWorkspaceId)
      void flushOutbox(activeWorkspaceId)
      void requestChatServiceWorkerSync("browser-online")
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener("online", handleOnline)
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("online", handleOnline)
    }
  }, [flushOutbox, syncFromServer, workspaceId])

  useEffect(() => {
    return subscribeToChatServiceWorker((message) => {
      if (
        workspaceId &&
        message.type === "chat:queue-updated" &&
        message.payload.workspaceId === workspaceId
      ) {
        void reloadPersistedSnapshot(workspaceId)
        void syncFromServer(workspaceId)
      }
    })
  }, [reloadPersistedSnapshot, syncFromServer, workspaceId])

  useEffect(() => {
    if (!workspaceId || (pendingReadCount === 0 && outboxCount === 0)) {
      return
    }

    void requestChatServiceWorkerSync("queue-updated")
  }, [outboxCount, pendingReadCount, workspaceId])

  useEffect(() => {
    if (!workspaceId || !clientInstanceId) {
      return
    }

    void requestChatServiceWorkerSync("client-instance-ready")
  }, [clientInstanceId, workspaceId])
}
