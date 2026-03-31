"use client"

import { startTransition } from "react"
import { useRouter } from "next/navigation"

import ConversationList from "@/app/dashboard/chat/conversation-list"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { MobileHeaderActions } from "@/components/mobile-header-actions"
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
  const selectConversation = useChatStore((state) => state.selectConversation)

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
          onNewConversation={() => router.push("/m/contacts/group/new")}
          className="border-r-0 bg-background"
          headerVariant="mobile"
          title="Messages"
          headerAction={
            <MobileHeaderActions
              onSearch={() => router.push("/m/search")}
              onStartGroup={() => router.push("/m/contacts/group/new")}
              onAddFriend={() => router.push("/m/contacts/add")}
              onScan={() => router.push("/m/scan?intent=relationship")}
            />
          }
          showSearchInput={false}
        />
      </div>
    </>
  )
}
