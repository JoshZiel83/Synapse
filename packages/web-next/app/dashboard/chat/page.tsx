"use client"

import { useEffect, useRef, useState } from "react"
import { type CanonicalContentBlock } from "@synapse/shared"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useWorkspace } from "../workspace-provider"
import { useChatRealtimeSync } from "@/hooks/use-chat-realtime-sync"
import { useChatStore } from "@/stores/chat-store"
import ConversationList from "./conversation-list"
import ConversationChat, {
  ConversationChatSkeleton,
} from "./conversation-chat"
import NewConversationDialog from "./new-conversation-dialog"
import { MessageSquare } from "lucide-react"

export default function ChatPage() {
  const { workspaceId } = useWorkspace()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const actorParam = searchParams.get("actor")
  const conversationParam = searchParams.get("conversation")

  const {
    conversations,
    selectedConversationId,
    messages,
    loadingConversations,
    loadingMessages,
    runtimeMap,
    loadConversations,
    selectConversation,
    loadMessages,
    sendMessage,
    createWorkspaceThread,
    markConversationRead,
  } = useChatStore()

  const [dialogOpen, setDialogOpen] = useState(false)
  const lastReportedReadRef = useRef<string>("")
  useChatRealtimeSync({ workspaceId, selectedConversationId })

  useEffect(() => {
    if (!conversationParam) return
    if (!conversations.some((conversation) => conversation.id === conversationParam)) return
    selectConversation(conversationParam)
  }, [conversationParam, conversations, selectConversation])

  useEffect(() => {
    if (workspaceId && selectedConversationId) {
      loadMessages(workspaceId, selectedConversationId)
    }
  }, [
    workspaceId,
    selectedConversationId,
    loadMessages,
  ])

  useEffect(() => {
    if (!selectedConversationId || loadingMessages || messages.length === 0) {
      return
    }

    const maxSequence = messages.reduce(
      (max, message) => Math.max(max, message.sequence),
      0
    )
    if (maxSequence <= 0) {
      return
    }

    const nextKey = `${selectedConversationId}:${maxSequence}`
    if (lastReportedReadRef.current === nextKey) {
      return
    }
    lastReportedReadRef.current = nextKey
    void markConversationRead(selectedConversationId, maxSequence)
  }, [loadingMessages, markConversationRead, messages, selectedConversationId])

  const selectedConversation = conversations.find(
    (conversation) => conversation.id === selectedConversationId
  )

  function updateConversationRoute(conversationId: string) {
    const nextParams = new URLSearchParams(searchParams.toString())
    nextParams.set("conversation", conversationId)
    nextParams.delete("actor")
    router.replace(`${pathname}?${nextParams.toString()}`, { scroll: false })
  }

  function handleSelectConversation(id: string) {
    updateConversationRoute(id)
  }

  async function handleSend(
    contentBlocks: CanonicalContentBlock[],
    targetParticipantIds?: string[],
    targetActorIds?: string[]
  ) {
    if (!workspaceId || !selectedConversationId) return
    await sendMessage(
      workspaceId,
      selectedConversationId,
      contentBlocks,
      targetParticipantIds,
      targetActorIds
    )
  }

  async function handleCreateConversation(actorIds: string[]) {
    if (!workspaceId) return
    try {
      const conversationId = await createWorkspaceThread(
        workspaceId,
        "group",
        actorIds
      )
      updateConversationRoute(conversationId)
    } catch (err) {
      console.error("Failed to create conversation:", err)
    }
  }

  function handleNewConversation() {
    setDialogOpen(true)
  }

  function handleDialogOpenChange(open: boolean) {
    setDialogOpen(open)
    if (open || !actorParam) return

    const nextParams = new URLSearchParams(searchParams.toString())
    nextParams.delete("actor")
    const nextQuery = nextParams.toString()
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, {
      scroll: false,
    })
  }

  function handleBackToList() {
    const nextParams = new URLSearchParams(searchParams.toString())
    nextParams.delete("conversation")
    const nextQuery = nextParams.toString()
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, {
      scroll: false,
    })
  }

  const mobileView = conversationParam ? "chat" : "list"

  if (!workspaceId) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <p className="text-muted-foreground">No workspace selected.</p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full max-w-full min-w-0 overflow-hidden">
      {/* Desktop: side-by-side. Mobile: toggle */}

      {/* Conversation List */}
      <div
        className={`w-[22rem] shrink-0 ${mobileView === "list" ? "flex" : "hidden"} min-h-0 min-w-0 flex-col lg:flex`}
      >
        <ConversationList
          conversations={conversations}
          loading={loadingConversations}
          selectedId={selectedConversationId}
          runtimeMap={runtimeMap}
          onSelect={handleSelectConversation}
          onNewConversation={handleNewConversation}
        />
      </div>

      {/* Chat Area */}
      <div
        className={`flex-1 ${mobileView === "chat" ? "flex" : "hidden"} min-h-0 min-w-0 flex-col lg:flex`}
      >
        {selectedConversation ? (
          <ConversationChat
            conversation={selectedConversation}
            messages={messages}
            loading={loadingMessages}
            actorRuntimes={
              selectedConversationId
                ? runtimeMap[selectedConversationId]
                : undefined
            }
            onSend={handleSend}
            onBack={handleBackToList}
            workspaceId={workspaceId}
            onRefreshConversation={() => loadConversations(workspaceId)}
            contactBasePath="/dashboard/contacts"
          />
        ) : loadingConversations &&
          (conversationParam || selectedConversationId) ? (
          <ConversationChatSkeleton />
        ) : (
          <div className="flex h-full flex-col items-center justify-center space-y-4 p-8 text-center">
            <div className="flex h-24 w-24 items-center justify-center rounded-3xl bg-gray-100 dark:bg-white/5">
              <MessageSquare className="h-12 w-12 text-muted-foreground/30" />
            </div>
            <div>
              <h3 className="mb-2 text-lg font-semibold text-foreground">
                Select a Conversation
              </h3>
              <p className="max-w-sm text-sm text-muted-foreground">
                Choose an existing conversation or start a new one to begin
                chatting with your digital employees.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* New Conversation Dialog */}
      <NewConversationDialog
        open={dialogOpen || Boolean(actorParam && workspaceId)}
        onOpenChange={handleDialogOpenChange}
        workspaceId={workspaceId}
        onCreateConversation={handleCreateConversation}
        preselectedActorId={actorParam || undefined}
      />
    </div>
  )
}
