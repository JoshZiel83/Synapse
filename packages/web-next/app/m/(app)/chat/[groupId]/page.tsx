"use client"

import { startTransition, useEffect } from "react"
import { MessageSquare } from "lucide-react"
import { useParams, useRouter } from "next/navigation"
import { type CanonicalContentBlock } from "@synapse/shared"

import GroupChat, { GroupChatSkeleton } from "@/app/dashboard/chat/group-chat"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { Button } from "@/components/ui/button"
import { useChatStore } from "@/stores/chat-store"

export default function MobileChatDetailPage() {
  const params = useParams<{ groupId: string }>()
  const router = useRouter()
  const groupId = Array.isArray(params.groupId) ? params.groupId[0] : params.groupId
  const { workspaceId } = useWorkspace()

  const groups = useChatStore((state) => state.groups)
  const messages = useChatStore((state) => state.messages)
  const loadingGroups = useChatStore((state) => state.loadingGroups)
  const loadingMessages = useChatStore((state) => state.loadingMessages)
  const runtimeMap = useChatStore((state) => state.runtimeMap)
  const loadGroups = useChatStore((state) => state.loadGroups)
  const loadMessages = useChatStore((state) => state.loadMessages)
  const selectGroup = useChatStore((state) => state.selectGroup)
  const sendMessage = useChatStore((state) => state.sendMessage)
  const markRead = useChatStore((state) => state.markRead)

  useEffect(() => {
    if (!groupId) return
    selectGroup(groupId)
  }, [groupId, selectGroup])

  useEffect(() => {
    if (!workspaceId || !groupId) return
    void loadMessages(workspaceId, groupId)
    void markRead(workspaceId, groupId)
  }, [groupId, loadMessages, markRead, workspaceId])

  const selectedGroup = groups.find((group) => group.id === groupId)

  async function handleSend(
    contentBlocks: CanonicalContentBlock[],
    targetParticipantIds?: string[]
  ) {
    if (!workspaceId || !groupId) return
    try {
      await sendMessage(workspaceId, groupId, contentBlocks, targetParticipantIds)
    } catch (error) {
      console.error("Failed to send:", error)
    }
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
    <div className="flex h-[100dvh] min-h-0 w-full min-w-0 max-w-full flex-1 flex-col overflow-hidden">
      {selectedGroup ? (
        <GroupChat
          group={selectedGroup}
          messages={messages}
          loading={loadingMessages}
          actorRuntimes={runtimeMap[groupId]}
          onSend={handleSend}
          onBack={handleBack}
          workspaceId={workspaceId}
          onRefreshGroup={() => loadGroups(workspaceId)}
          viewportLocked
          mobileMentionPickerWorkspaceId={workspaceId}
          contactBasePath="/m/contacts"
        />
      ) : loadingGroups ? (
        <GroupChatSkeleton mobile />
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
