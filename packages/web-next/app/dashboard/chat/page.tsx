"use client"

import { useEffect, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useWorkspace } from "../workspace-provider"
import { useChatStore } from "@/stores/chat-store"
import ConversationList from "./conversation-list"
import ConversationChat, { ConversationChatSkeleton } from "./conversation-chat"
import NewConversationDialog from "./new-conversation-dialog"
import type { ChatComposerSubmitPayload } from "@/components/chat-composer"
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
    clientInstanceId,
    messages,
    loadingConversations,
    loadingMessages,
    runtimeMap,
    remoteAgentRuntimeMap,
    loadConversations,
    selectConversation,
    loadMessages,
    sendMessage,
    createWorkspaceThread,
    markConversationRead,
    setVisibleConversation,
  } = useChatStore()

  const [dialogOpen, setDialogOpen] = useState(false)
  const lastReportedReadRef = useRef<string>("")

  useEffect(() => {
    if (!conversationParam) return
    const currentSelection = useChatStore.getState().selectedConversationId
    if (currentSelection === conversationParam) return
    if (
      !conversations.some(
        (conversation) => conversation.id === conversationParam
      )
    )
      return
    selectConversation(conversationParam)
  }, [conversationParam, conversations, selectConversation])

  useEffect(() => {
    setVisibleConversation(selectedConversationId)
    return () => {
      setVisibleConversation(null)
    }
  }, [selectedConversationId, setVisibleConversation])

  useEffect(() => {
    if (workspaceId && selectedConversationId && clientInstanceId) {
      loadMessages(workspaceId, selectedConversationId)
    }
  }, [clientInstanceId, workspaceId, selectedConversationId, loadMessages])

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
  const composerDisabled = loadingConversations || !clientInstanceId
  const conversationLoading =
    loadingConversations || loadingMessages || !clientInstanceId

  function updateConversationRoute(conversationId: string) {
    const nextParams = new URLSearchParams(searchParams.toString())
    nextParams.set("conversation", conversationId)
    nextParams.delete("actor")
    router.replace(`${pathname}?${nextParams.toString()}`, { scroll: false })
  }

  function handleSelectConversation(id: string) {
    selectConversation(id)
    updateConversationRoute(id)
  }

  async function handleSend({
    contentBlocks,
    replyToItemId,
    replyTo,
  }: ChatComposerSubmitPayload) {
    if (!workspaceId || !selectedConversationId) return
    await sendMessage(workspaceId, selectedConversationId, {
      contentBlocks,
      replyToItemId,
      replyTo,
    })
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

  if (!workspaceId) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <p className="text-muted-foreground">No workspace selected.</p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full max-w-full min-w-0 overflow-hidden">
      <div className="flex min-h-0 w-[22rem] min-w-0 shrink-0 flex-col">
        <ConversationList
          conversations={conversations}
          loading={loadingConversations}
          selectedId={selectedConversationId}
          runtimeMap={runtimeMap}
          onSelect={handleSelectConversation}
          onNewConversation={handleNewConversation}
        />
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selectedConversation ? (
          <ConversationChat
            conversation={selectedConversation}
            messages={messages}
            loading={conversationLoading}
            composerDisabled={composerDisabled}
            actorRuntimes={
              selectedConversationId
                ? runtimeMap[selectedConversationId]
                : undefined
            }
            remoteAgentRuntimes={remoteAgentRuntimeMap}
            onSend={handleSend}
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
