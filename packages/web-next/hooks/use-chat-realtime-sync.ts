"use client"

import { useCallback, useEffect } from "react"
import { extractText, type ChatSocketEvent } from "@synapse/shared"

import { useNotifications } from "@/hooks/use-notifications"
import { useWebSocket } from "@/hooks/use-websocket"
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
  const handleFeedItemCreated = useChatStore(
    (state) => state.handleFeedItemCreated
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
        case "feed.item.created": {
          const payload = (event as ChatSocketEvent<"feed.item.created">)
            .payload
          handleFeedItemCreated(payload)
          if (
            payload.item.kind === "message" &&
            payload.item.role === "assistant"
          ) {
            const name = payload.item.author?.name || "Synapse"
            const content = extractText(payload.item.contentBlocks || [])
            notify(name, content, payload.item.conversationId)
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
        case "interaction.updated":
          handleInteractionUpdated(
            (event as ChatSocketEvent<"interaction.updated">).payload
          )
          break
        case "feed.resync.required":
          if (workspaceId) {
            void loadConversations(workspaceId)
            if (selectedConversationId) {
              void loadMessages(workspaceId, selectedConversationId)
            }
          }
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
      handleFeedItemCreated,
      handleInteractionUpdated,
      handleRuntimeUpdated,
      loadConversations,
      loadMessages,
      notify,
      selectedConversationId,
      workspaceId,
    ]
  )

  const handleSocketConnected = useCallback(
    (payload: { workspaceId: string; lastWorkspaceSequence: number }) => {
      void loadConversations(payload.workspaceId)
      flushOutbox(payload.workspaceId)
    },
    [flushOutbox, loadConversations]
  )

  useWebSocket({ workspaceId, onEvent, onConnected: handleSocketConnected })

  useEffect(() => {
    if (!workspaceId) return
    hydrateOutbox(workspaceId)
    void loadConversations(workspaceId)
  }, [workspaceId, hydrateOutbox, loadConversations])
}
