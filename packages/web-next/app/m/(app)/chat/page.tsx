"use client"

import { startTransition, useState } from "react"
import { useRouter } from "next/navigation"

import GroupList from "@/app/dashboard/chat/group-list"
import NewGroupDialog from "@/app/dashboard/chat/new-group-dialog"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { useChatStore } from "@/stores/chat-store"

export default function MobileChatListPage() {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const groups = useChatStore((state) => state.groups)
  const selectedGroupId = useChatStore((state) => state.selectedGroupId)
  const runtimeMap = useChatStore((state) => state.runtimeMap)
  const createGroup = useChatStore((state) => state.createGroup)
  const selectGroup = useChatStore((state) => state.selectGroup)

  const [dialogOpen, setDialogOpen] = useState(false)

  async function handleCreateGroup(actorIds: string[]) {
    if (!workspaceId) return
    try {
      const groupId = await createGroup(workspaceId, actorIds)
      selectGroup(groupId)
      startTransition(() => {
        router.push(`/m/chat/${groupId}`)
      })
    } catch (error) {
      console.error("Failed to create group:", error)
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
      <div className="flex min-h-0 flex-1 flex-col pt-[calc(env(safe-area-inset-top)+0.25rem)]">
        <GroupList
          groups={groups}
          selectedId={selectedGroupId}
          runtimeMap={runtimeMap}
          onSelect={(groupId) => {
            selectGroup(groupId)
            startTransition(() => {
              router.push(`/m/chat/${groupId}`)
            })
          }}
          onNewConversation={() => setDialogOpen(true)}
          className="border-r-0 bg-background"
        />
      </div>

      <NewGroupDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        workspaceId={workspaceId}
        onCreateGroup={handleCreateGroup}
      />
    </>
  )
}
