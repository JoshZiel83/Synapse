"use client"

import { useCallback, useEffect, useMemo } from "react"
import { extractText, type ChatSocketEvent } from "@synapse/shared"

import { useNotifications } from "@/hooks/use-notifications"
import {
  useWebSocket,
  type WebSocketSubscription,
} from "@/hooks/use-websocket"
import { flushPendingConversationReads } from "@/lib/read-watermark-queue"
import { useChatStore } from "@/stores/chat-store"

export function useChatRealtimeSync({
  workspaceId,
  selectedConversationId,
}: {
  workspaceId: string | null
  selectedConversationId?: string | null
}) {
  const { notify } = useNotifications()
  const loadConversations = useChatStore((state) => state.loadConversations)
  const loadMessages = useChatStore((state) => state.loadMessages)
  const hydrateOutbox = useChatStore((state) => state.hydrateOutbox)
  const flushOutbox = useChatStore((state) => state.flushOutbox)
  const handleConversationItemCreated = useChatStore(
    (state) => state.handleConversationItemCreated
  )
  const handleRuntimeUpdated = useChatStore(
    (state) => state.handleRuntimeUpdated
  )
  const handleConversationUpdated = useChatStore(
    (state) => state.handleConversationUpdated
  )
  const handleInteractionUpdated = useChatStore(
    (state) => state.handleInteractionUpdated
  )

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
        case "conversation.item.created": {
          const payload = (event as ChatSocketEvent<"conversation.item.created">)
            .payload
          handleConversationItemCreated(payload)
          if (payload.kind === "message" && payload.role === "assistant") {
            const name = payload.author?.name || "Synapse"
            const content = extractText(payload.contentBlocks || [])
            notify(name, content, payload.conversationId)
          }
          break
        }
        case "runtime.updated":
          handleRuntimeUpdated(
            (event as ChatSocketEvent<"runtime.updated">).payload
          )
          break
        case "conversation.updated": {
          const payload = (event as ChatSocketEvent<"conversation.updated">)
            .payload
          handleConversationUpdated(payload)
          if (workspaceId && payload.action === "created") {
            void loadConversations(workspaceId)
          }
          break
        }
        case "conversation.read.updated":
          if (workspaceId) {
            void loadConversations(workspaceId)
          }
          break
        case "interaction.updated":
          handleInteractionUpdated(
            (event as ChatSocketEvent<"interaction.updated">).payload
          )
          break
        case "actor.action":
          if (workspaceId) {
            void loadConversations(workspaceId)
          }
          break
        default:
          break
      }
    },
    [
      handleConversationUpdated,
      handleConversationItemCreated,
      handleInteractionUpdated,
      handleRuntimeUpdated,
      loadConversations,
      notify,
      workspaceId,
    ]
  )

  const subscriptions = useMemo<WebSocketSubscription[]>(() => {
    const next: WebSocketSubscription[] = []
    if (workspaceId) {
      next.push({
        key: `inbox:${workspaceId}`,
        topic: "inbox" as const,
        workspaceId,
      })
    }
    if (selectedConversationId) {
      next.push({
        key: `conversation:${selectedConversationId}`,
        topic: "conversation" as const,
        conversationId: selectedConversationId,
      })
    }
    return next
  }, [selectedConversationId, workspaceId])

  const handleSocketConnected = useCallback(() => {
    if (!workspaceId) return
    void (async () => {
      await flushPendingConversationReads()
      void loadConversations(workspaceId)
      if (selectedConversationId) {
        void loadMessages(workspaceId, selectedConversationId)
      }
      flushOutbox(workspaceId)
    })()
  }, [flushOutbox, loadConversations, loadMessages, selectedConversationId, workspaceId])

  useWebSocket({
    subscriptions,
    onEvent,
    onConnected: handleSocketConnected,
  })

  useEffect(() => {
    if (!workspaceId) return
    void flushPendingConversationReads()
    hydrateOutbox(workspaceId)
    void loadConversations(workspaceId)
  }, [workspaceId, hydrateOutbox, loadConversations])
}
