"use client"

import { startTransition, useEffect } from "react"
import { MessageSquare } from "lucide-react"
import { useParams, useRouter } from "next/navigation"
import { type CanonicalContentBlock } from "@synapse/shared"

import ConversationChat, {
  ConversationChatSkeleton,
} from "@/app/dashboard/chat/conversation-chat"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { Button } from "@/components/ui/button"
import { useChatStore } from "@/stores/chat-store"

export default function MobileChatDetailPage() {
  const params = useParams<{ conversationId: string }>()
  const router = useRouter()
  const conversationId = Array.isArray(params.conversationId)
    ? params.conversationId[0]
    : params.conversationId
  const { workspaceId } = useWorkspace()

  const conversations = useChatStore((state) => state.conversations)
  const messages = useChatStore((state) => state.messages)
  const loadingConversations = useChatStore(
    (state) => state.loadingConversations
  )
  const loadingMessages = useChatStore((state) => state.loadingMessages)
  const runtimeMap = useChatStore((state) => state.runtimeMap)
  const loadConversations = useChatStore((state) => state.loadConversations)
  const loadMessages = useChatStore((state) => state.loadMessages)
  const selectConversation = useChatStore((state) => state.selectConversation)
  const sendMessage = useChatStore((state) => state.sendMessage)
  const markConversationRead = useChatStore(
    (state) => state.markConversationRead
  )

  useEffect(() => {
    if (!conversationId) return
    selectConversation(conversationId)
  }, [conversationId, selectConversation])

  useEffect(() => {
    if (!workspaceId || !conversationId) return
    void loadMessages(workspaceId, conversationId)
    void markConversationRead(workspaceId, conversationId)
  }, [conversationId, loadMessages, markConversationRead, workspaceId])

  const selectedConversation = conversations.find(
    (conversation) => conversation.id === conversationId
  )

  async function handleSend(
    contentBlocks: CanonicalContentBlock[],
    targetParticipantIds?: string[],
    targetActorIds?: string[]
  ) {
    if (!workspaceId || !conversationId) return
    await sendMessage(
      workspaceId,
      conversationId,
      contentBlocks,
      targetParticipantIds,
      targetActorIds
    )
  }

  function handleBack() {
    startTransition(() => {
      router.push("/m/chat")
    })
  }

  if (!workspaceId) {
    return (
      <div className="flex min-h-svh items-center justify-center px-6">
        <p className="max-w-xs text-center text-sm text-muted-foreground">
          Select a workspace to view this conversation.
        </p>
      </div>
    )
  }

  return (
      <div className="flex h-[100dvh] min-h-0 w-full max-w-full min-w-0 flex-1 flex-col overflow-hidden">
      {selectedConversation ? (
        <ConversationChat
          conversation={selectedConversation}
          messages={messages}
          loading={loadingMessages}
          actorRuntimes={conversationId ? runtimeMap[conversationId] : undefined}
          onSend={handleSend}
          onBack={handleBack}
          workspaceId={workspaceId}
          onRefreshConversation={() => loadConversations(workspaceId)}
          viewportLocked
          mobileMentionPickerWorkspaceId={workspaceId}
          contactBasePath="/m/contacts"
        />
      ) : loadingConversations ? (
        <ConversationChatSkeleton mobile />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <div className="mb-4 flex size-16 items-center justify-center rounded-3xl bg-muted">
            <MessageSquare className="size-7 text-muted-foreground/50" />
          </div>
          <h1 className="text-lg font-semibold text-foreground">
            Conversation unavailable
          </h1>
          <p className="mt-2 max-w-xs text-sm text-muted-foreground">
            This conversation could not be found in the current workspace.
          </p>
          <Button className="mt-5 rounded-full" onClick={handleBack}>
            Back to chats
          </Button>
        </div>
      )}
    </div>
  )
}
