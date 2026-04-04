"use client"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { useChatRealtimeSync } from "@/hooks/use-chat-realtime-sync"
import { useChatStore } from "@/stores/chat-store"

export function ChatSyncClient() {
  const { workspaceId } = useWorkspace()
  const selectedConversationId = useChatStore(
    (state) => state.selectedConversationId
  )

  useChatRealtimeSync({
    workspaceId,
    selectedConversationId,
  })

  return null
}
