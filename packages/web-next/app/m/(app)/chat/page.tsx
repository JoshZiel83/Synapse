"use client"

import { startTransition, useState } from "react"
import { useRouter } from "next/navigation"

import ConversationList from "@/app/dashboard/chat/conversation-list"
import NewConversationDialog from "@/app/dashboard/chat/new-conversation-dialog"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { useChatStore } from "@/stores/chat-store"

export default function MobileChatListPage() {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const conversations = useChatStore((state) => state.conversations)
  const loadingConversations = useChatStore(
    (state) => state.loadingConversations
  )
  const selectedConversationId = useChatStore(
    (state) => state.selectedConversationId
  )
  const runtimeMap = useChatStore((state) => state.runtimeMap)
  const createWorkspaceThread = useChatStore(
    (state) => state.createWorkspaceThread
  )
  const selectConversation = useChatStore((state) => state.selectConversation)

  const [dialogOpen, setDialogOpen] = useState(false)

  async function handleCreateConversation(actorIds: string[]) {
    if (!workspaceId) return
    try {
      const conversationId = await createWorkspaceThread(
        workspaceId,
        "group",
        actorIds
      )
      selectConversation(conversationId)
      startTransition(() => {
        router.push(`/m/chat/${conversationId}`)
      })
    } catch (error) {
      console.error("Failed to create conversation:", error)
    }
  }

  if (!workspaceId) {
    return (
      <div className="flex min-h-svh items-center justify-center px-6">
        <p className="max-w-xs text-center text-sm text-muted-foreground">
          Select a workspace to view chats on mobile.
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <ConversationList
          conversations={conversations}
          loading={loadingConversations}
          selectedId={selectedConversationId}
          runtimeMap={runtimeMap}
          onSelect={(conversationId) => {
            selectConversation(conversationId)
            startTransition(() => {
              router.push(`/m/chat/${conversationId}`)
            })
          }}
          onNewConversation={() => setDialogOpen(true)}
          className="border-r-0 bg-background"
          headerVariant="mobile"
          title="Messages"
        />
      </div>

      <NewConversationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        workspaceId={workspaceId}
        onCreateConversation={handleCreateConversation}
      />
    </>
  )
}
