"use client"

import { useEffect, useState } from "react"
import { type CanonicalContentBlock } from "@synapse/shared"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useWorkspace } from "../workspace-provider"
import { useChatRealtimeSync } from "@/hooks/use-chat-realtime-sync"
import { useChatStore } from "@/stores/chat-store"
import GroupList from "./group-list"
import GroupChat from "./group-chat"
import NewGroupDialog from "./new-group-dialog"
import { MessageSquare } from "lucide-react"

export default function ChatPage() {
  const { workspaceId } = useWorkspace()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const actorParam = searchParams.get("actor")
  const groupParam = searchParams.get("group")

  const {
    groups,
    selectedGroupId,
    messages,
    loadingMessages,
    runtimeMap,
    loadGroups,
    selectGroup,
    loadMessages,
    sendMessage,
    createGroup,
    markRead,
  } = useChatStore()

  const [dialogOpen, setDialogOpen] = useState(false)
  useChatRealtimeSync({ workspaceId, selectedGroupId })

  useEffect(() => {
    if (!groupParam) return
    if (!groups.some((group) => group.id === groupParam)) return
    selectGroup(groupParam)
  }, [groupParam, groups, selectGroup])

  // Load messages when selecting a group
  useEffect(() => {
    if (workspaceId && selectedGroupId) {
      loadMessages(workspaceId, selectedGroupId)
      markRead(workspaceId, selectedGroupId)
    }
  }, [workspaceId, selectedGroupId, loadMessages, markRead])

  const selectedGroup = groups.find((g) => g.id === selectedGroupId)

  function updateGroupRoute(groupId: string) {
    const nextParams = new URLSearchParams(searchParams.toString())
    nextParams.set("group", groupId)
    nextParams.delete("actor")
    router.replace(`${pathname}?${nextParams.toString()}`, { scroll: false })
  }

  function handleSelectGroup(id: string) {
    updateGroupRoute(id)
  }

  async function handleSend(
    contentBlocks: CanonicalContentBlock[],
    targetActorIds?: string[]
  ) {
    if (!workspaceId || !selectedGroupId) return
    try {
      await sendMessage(
        workspaceId,
        selectedGroupId,
        contentBlocks,
        targetActorIds
      )
    } catch (err) {
      console.error("Failed to send:", err)
    }
  }

  async function handleCreateGroup(actorIds: string[]) {
    if (!workspaceId) return
    try {
      const groupId = await createGroup(workspaceId, actorIds)
      updateGroupRoute(groupId)
    } catch (err) {
      console.error("Failed to create group:", err)
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
    nextParams.delete("group")
    const nextQuery = nextParams.toString()
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, {
      scroll: false,
    })
  }

  const mobileView = groupParam ? "chat" : "list"

  if (!workspaceId) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <p className="text-muted-foreground">No workspace selected.</p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* Desktop: side-by-side. Mobile: toggle */}

      {/* Group List */}
      <div
        className={`w-[22rem] shrink-0 ${mobileView === "list" ? "flex" : "hidden"} min-h-0 flex-col lg:flex`}
      >
        <GroupList
          groups={groups}
          selectedId={selectedGroupId}
          runtimeMap={runtimeMap}
          onSelect={handleSelectGroup}
          onNewConversation={handleNewConversation}
        />
      </div>

      {/* Chat Area */}
      <div
        className={`flex-1 ${mobileView === "chat" ? "flex" : "hidden"} min-h-0 min-w-0 flex-col lg:flex`}
      >
        {selectedGroup ? (
          <GroupChat
            group={selectedGroup}
            messages={messages}
            loading={loadingMessages}
            actorRuntimes={
              selectedGroupId ? runtimeMap[selectedGroupId] : undefined
            }
            onSend={handleSend}
            onBack={handleBackToList}
            workspaceId={workspaceId}
            onRefreshGroup={() => loadGroups(workspaceId)}
          />
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

      {/* New Group Dialog */}
      <NewGroupDialog
        open={dialogOpen || Boolean(actorParam && workspaceId)}
        onOpenChange={handleDialogOpenChange}
        workspaceId={workspaceId}
        onCreateGroup={handleCreateGroup}
        preselectedActorId={actorParam || undefined}
      />
    </div>
  )
}
