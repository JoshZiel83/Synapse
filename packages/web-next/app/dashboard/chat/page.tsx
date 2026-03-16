"use client"

import { useEffect, useState, useCallback } from "react"
import {
  extractText,
  type CanonicalContentBlock,
  type ChatSocketEvent,
} from "@synapse/shared"
import { useSearchParams } from "next/navigation"
import { useWorkspace } from "../workspace-provider"
import { useWebSocket } from "@/hooks/use-websocket"
import { useNotifications } from "@/hooks/use-notifications"
import { useChatStore } from "@/stores/chat-store"
import GroupList from "./group-list"
import GroupChat from "./group-chat"
import NewGroupDialog from "./new-group-dialog"
import { MessageSquare } from "lucide-react"

export default function ChatPage() {
  const { workspaceId } = useWorkspace()
  const searchParams = useSearchParams()
  const actorParam = searchParams.get("actor")

  const {
    groups,
    selectedGroupId,
    messages,
    loadingGroups,
    loadingMessages,
    runtimeMap,
    loadGroups,
    selectGroup,
    loadMessages,
    sendMessage,
    hydrateOutbox,
    flushOutbox,
    createGroup,
    markRead,
    handleFeedItemCreated,
    handleRuntimeUpdated,
    handleConversationUpdated,
  } = useChatStore()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [preselectedActorId, setPreselectedActorId] = useState<
    string | undefined
  >()
  const [mobileView, setMobileView] = useState<"list" | "chat">("list")
  const { notify } = useNotifications()

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
        case "conversation.updated":
          handleConversationUpdated(
            (event as ChatSocketEvent<"conversation.updated">).payload
          )
          if (
            workspaceId &&
            (event as ChatSocketEvent<"conversation.updated">).payload
              .action === "created"
          ) {
            loadGroups(workspaceId)
          }
          break
        case "feed.resync.required":
          if (workspaceId) {
            loadGroups(workspaceId)
            if (selectedGroupId) {
              loadMessages(workspaceId, selectedGroupId)
            }
          }
          break
        case "actor.action":
        case "secretary.response":
          if (workspaceId) loadGroups(workspaceId)
          break
        default:
          break
      }
    },
    [
      handleConversationUpdated,
      handleFeedItemCreated,
      handleRuntimeUpdated,
      loadGroups,
      loadMessages,
      notify,
      selectedGroupId,
      workspaceId,
    ]
  )

  const handleSocketConnected = useCallback(
    (payload: { workspaceId: string; lastWorkspaceSequence: number }) => {
      loadGroups(payload.workspaceId)
      flushOutbox(payload.workspaceId)
    },
    [flushOutbox, loadGroups]
  )

  useWebSocket({ workspaceId, onEvent, onConnected: handleSocketConnected })

  // Load groups on mount
  useEffect(() => {
    if (workspaceId) {
      hydrateOutbox(workspaceId)
      loadGroups(workspaceId)
    }
  }, [workspaceId, hydrateOutbox, loadGroups])

  // Handle ?actor= query param (from org tree)
  useEffect(() => {
    if (actorParam && workspaceId) {
      setPreselectedActorId(actorParam)
      setDialogOpen(true)
    }
  }, [actorParam, workspaceId])

  // Load messages when selecting a group
  useEffect(() => {
    if (workspaceId && selectedGroupId) {
      loadMessages(workspaceId, selectedGroupId)
      markRead(workspaceId, selectedGroupId)
    }
  }, [workspaceId, selectedGroupId, loadMessages, markRead])

  const selectedGroup = groups.find((g) => g.id === selectedGroupId)

  function handleSelectGroup(id: string) {
    selectGroup(id)
    setMobileView("chat")
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
      selectGroup(groupId)
      setMobileView("chat")
    } catch (err) {
      console.error("Failed to create group:", err)
    }
  }

  function handleNewConversation() {
    setPreselectedActorId(undefined)
    setDialogOpen(true)
  }

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
            onBack={() => setMobileView("list")}
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
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        workspaceId={workspaceId}
        onCreateGroup={handleCreateGroup}
        preselectedActorId={preselectedActorId}
      />
    </div>
  )
}
