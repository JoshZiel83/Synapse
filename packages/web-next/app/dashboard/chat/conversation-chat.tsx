"use client"

import type {
  Actor,
  ActorRuntimeState,
  InteractionRequestSummary,
} from "@synapse/shared"
import { useEffect, useMemo, useRef, useState } from "react"
import { type CanonicalContentBlock } from "@synapse/shared"
import { toast } from "sonner"
import ChatComposer, {
  type ChatComposerParticipant,
  type ChatComposerSubmitPayload,
} from "@/components/chat-composer"
import { normalizeChiefActorOption } from "@/app/dashboard/chief-actor-picker-shared"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { ArrowDown, Pencil, Check, MoreHorizontal } from "lucide-react"
import MessageBubble from "./message-bubble"
import type {
  ConversationMember,
  ConversationSummary,
  FeedMessage,
} from "@/stores/chat-store"
import { api } from "@/lib/api"
import ChatAvatar from "./chat-avatar"
import ChatMemberStrip from "./chat-member-strip"
import ChatParticipantDetailDialog from "./chat-participant-detail-dialog"
import ConversationMemberPickerDialog from "./conversation-member-picker-dialog"
import MobileConversationDetailsDialog from "./mobile-conversation-details-dialog"
import TransportKindIcon from "./transport-kind-icon"
import { useChatStore } from "@/stores/chat-store"
import { useWorkspace } from "@/app/dashboard/workspace-provider"

interface ConversationChatProps {
  conversation: ConversationSummary
  messages: FeedMessage[]
  loading: boolean
  actorRuntimes?: Record<string, ActorRuntimeState>
  onSend: (
    contentBlocks: CanonicalContentBlock[],
    targetParticipantIds?: string[],
    targetActorIds?: string[]
  ) => Promise<void> | void
  onBack?: () => void
  workspaceId?: string
  onRefreshConversation?: () => Promise<void> | void
  viewportLocked?: boolean
  mobileMentionPickerWorkspaceId?: string
  contactBasePath?: string
}

function summarizeMemberCounts(conversation: ConversationSummary) {
  const workspaceMemberCount = conversation.members.filter(
    (member) => member.type === "workspace_member"
  ).length
  const actorCount = conversation.members.filter(
    (member) => member.type === "actor"
  ).length
  const externalCount = conversation.members.filter(
    (member) => member.type === "external"
  ).length
  const workspaceMemberLabel = `${workspaceMemberCount} member${workspaceMemberCount === 1 ? "" : "s"}`
  const actorLabel = `${actorCount} actor${actorCount === 1 ? "" : "s"}`
  if (externalCount === 0) return `${workspaceMemberLabel} · ${actorLabel}`
  const externalLabel = `${externalCount} external${externalCount === 1 ? "" : "s"}`
  return `${workspaceMemberLabel} · ${actorLabel} · ${externalLabel}`
}

function getRuntimePriority(runtime: ActorRuntimeState) {
  if (runtime.health === "error" || runtime.laneState === "blocked") return 0
  if (runtime.laneState === "running") return 1
  if (runtime.laneState === "queued") return 2
  return 3
}

function summarizeCurrentUserProcessingActors(runtimes: ActorRuntimeState[]) {
  const names = runtimes.map((runtime) => runtime.actorName)
  if (names.length === 0) return null
  if (names.length === 1) return `${names[0]} is processing your message`
  if (names.length === 2)
    return `${names[0]} and ${names[1]} are processing your messages`
  return `${names[0]}, ${names[1]} +${names.length - 2} are processing your messages`
}

function buildMentionSearchTerms(
  member: ConversationSummary["members"][number]
) {
  return Array.from(
    new Set(
      [
        member.name,
        member.title,
        member.role,
        member.linkedWorkspaceMemberName,
        member.externalUserKey,
      ].filter((value): value is string => Boolean(value && value.trim()))
    )
  )
}

function ChatThreadSkeleton() {
  return (
    <div className="flex min-h-full w-full max-w-full min-w-0 flex-col gap-4">
      {Array.from({ length: 5 }, (_, index) => {
        const isUser = index % 3 === 1

        return (
          <div
            key={index}
            className={cn(
              "flex w-full max-w-full min-w-0 gap-3",
              isUser ? "flex-row-reverse" : "flex-row"
            )}
          >
            <Skeleton className="mt-1 size-8 shrink-0 rounded-full" />
            <div
              className={cn(
                "flex w-full max-w-[75%] min-w-0 flex-col gap-2",
                isUser ? "items-end" : "items-start"
              )}
            >
              {isUser ? null : (
                <Skeleton className="ml-1 h-3 w-20 rounded-full" />
              )}
              <div
                className={cn(
                  "flex w-full max-w-full min-w-0",
                  isUser ? "justify-end" : "justify-start"
                )}
              >
                <div
                  className={cn(
                    "flex max-w-full min-w-[10rem] flex-col gap-2 rounded-3xl border px-4 py-3",
                    isUser
                      ? "rounded-tr-sm border-primary/10 bg-primary/5"
                      : "rounded-tl-sm border-border bg-background"
                  )}
                >
                  <Skeleton className="h-4 w-full rounded-full" />
                  <Skeleton
                    className={cn(
                      "h-4 rounded-full",
                      index % 2 === 0 ? "w-[85%]" : "w-[65%]"
                    )}
                  />
                  {isUser ? null : (
                    <Skeleton className="h-20 w-full rounded-2xl" />
                  )}
                </div>
              </div>
              <Skeleton className="h-3 w-24 rounded-full" />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function ConversationChatSkeleton({
  mobile = false,
}: {
  mobile?: boolean
}) {
  return (
    <div
      className={cn(
        "grid h-full min-h-0 w-full max-w-full min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-background",
        mobile ? "h-[100dvh]" : "h-full"
      )}
    >
      <div
        className={cn(
          "sticky top-0 z-20 border-b border-border bg-background",
          mobile
            ? "px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3"
            : "px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-4 lg:px-6 lg:py-4"
        )}
      >
        {mobile ? (
          <div className="relative flex items-center justify-between">
            <Skeleton className="size-8 rounded-full" />
            <div className="pointer-events-none absolute inset-x-12 left-1/2 -translate-x-1/2">
              <Skeleton className="mx-auto h-4 w-28 rounded-full" />
            </div>
            <Skeleton className="size-8 rounded-full" />
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Skeleton className="size-12 shrink-0 rounded-full" />
              <div className="flex min-w-0 flex-col gap-2">
                <Skeleton className="h-4 w-36 rounded-full" />
                <Skeleton className="h-3 w-24 rounded-full" />
              </div>
            </div>
            <Skeleton className="h-10 w-28 rounded-full" />
          </div>
        )}
      </div>

      <div className="relative min-h-0 max-w-full min-w-0 bg-muted/20">
        <div className="h-full max-w-full min-w-0 overflow-hidden px-4 py-5 lg:px-6">
          <ChatThreadSkeleton />
        </div>
      </div>

      <div className="sticky bottom-0 z-20 border-t border-border bg-muted/20 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="rounded-3xl border border-border bg-background px-4 py-4 shadow-sm">
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-1/2 rounded-full" />
            <Skeleton className="h-4 w-full rounded-full" />
            <div className="flex items-center justify-between gap-3 pt-1">
              <Skeleton className="size-8 rounded-full" />
              <Skeleton className="h-8 w-24 rounded-full" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ConversationChat({
  conversation,
  messages,
  loading,
  actorRuntimes,
  onSend,
  onBack,
  workspaceId,
  onRefreshConversation,
  viewportLocked = false,
  mobileMentionPickerWorkspaceId,
  contactBasePath = "/dashboard/contacts",
}: ConversationChatProps) {
  const { currentWorkspaceMemberId } = useWorkspace()
  const handleInteractionUpdated = useChatStore(
    (state) => state.handleInteractionUpdated
  )
  const currentViewerWorkspaceMemberId = currentWorkspaceMemberId || ""
  const [titleDraft, setTitleDraft] = useState(conversation.title || "")
  const [editingTitle, setEditingTitle] = useState(false)
  const [savingTitle, setSavingTitle] = useState(false)
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [memberDialogOpen, setMemberDialogOpen] = useState(false)
  const conversationAvatarInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const initialScrollPendingRef = useRef(true)
  const hasObservedLoadingForConversationRef = useRef(false)
  const [showJumpButton, setShowJumpButton] = useState(false)
  const [conversationDetailsOpen, setConversationDetailsOpen] =
    useState(false)
  const [participantDetailOpen, setParticipantDetailOpen] = useState(false)
  const [selectedParticipantMember, setSelectedParticipantMember] =
    useState<ConversationMember | null>(null)
  const [retryingMessageIds, setRetryingMessageIds] = useState<string[]>([])
  const [workspaceActors, setWorkspaceActors] = useState<Actor[]>([])
  const prevMsgCount = useRef(messages.length)
  const mentionableParticipants = useMemo<ChatComposerParticipant[]>(() => {
    const inConversationActorIds = new Set(
      conversation.members
        .filter((member) => member.type === "actor")
        .map((member) => member.id)
    )
    const inConversationActors = conversation.members
      .filter((member) => member.type === "actor")
      .map((member) => ({
        id: member.id,
        name: member.name,
        type: "actor" as const,
        targetType: "actor" as const,
        memberId: member.memberId,
        participantId: member.participantId,
        actorId: member.id,
        inGroup: true,
        role: member.role,
        title: member.title,
        avatarUrl: member.avatarUrl,
        emoji: member.emoji,
        description: `${member.title || member.role || "Actor"} · In this conversation`,
        searchTerms: buildMentionSearchTerms(member),
      }))
    const inConversationParticipants = conversation.members
      .filter((member) => member.type !== "actor")
      .map((member) => ({
        id: member.participantId,
        name: member.name,
        type: member.type,
        targetType: "participant" as const,
        memberId: member.memberId,
        participantId: member.participantId,
        actorId: member.type === "actor" ? member.id : undefined,
        workspaceMemberId:
          member.type === "workspace_member" ? member.id : undefined,
        externalUserKey:
          member.type === "external" ? member.externalUserKey : undefined,
        transportAddressId: member.transportAddressId,
        transportKind: member.transportKind,
        inGroup: true,
        role: member.role,
        title: member.title,
        avatarUrl: member.avatarUrl,
        emoji: member.emoji,
        description:
          member.type === "external"
            ? member.linkedWorkspaceMemberName
              ? `External participant · linked to ${member.linkedWorkspaceMemberName}`
              : "External participant"
            : "Workspace user",
        searchTerms: buildMentionSearchTerms(member),
      }))
    const outOfConversationActors = workspaceActors
      .filter((actor) => !inConversationActorIds.has(actor.id))
      .map((actor) => {
        const normalized = normalizeChiefActorOption(actor)
        return {
          id: normalized.id,
          name: normalized.name,
          type: "actor" as const,
          targetType: "actor" as const,
          actorId: normalized.id,
          inGroup: false,
          role: normalized.role,
          title: normalized.title,
          avatarUrl: normalized.avatarUrl,
          emoji: normalized.emoji,
          description: `${normalized.title || normalized.role} · Not in this conversation`,
          searchTerms: [
            normalized.name,
            normalized.title,
            normalized.role,
            normalized.summary || "",
          ],
        } satisfies ChatComposerParticipant
      })

    return [
      ...inConversationActors,
      ...inConversationParticipants,
      ...outOfConversationActors,
    ]
  }, [conversation.members, workspaceActors])
  const actorMemberMap = useMemo(
    () =>
      Object.fromEntries(
        conversation.members
          .filter((member) => member.type === "actor")
          .map((member) => [member.id, member])
      ),
    [conversation.members]
  )
  const workspaceActorDirectory = useMemo(
    () => workspaceActors.map((actor) => normalizeChiefActorOption(actor)),
    [workspaceActors]
  )
  const activeRuntimes = useMemo(
    () =>
      Object.values(actorRuntimes || {})
        .filter(
          (runtime) =>
            runtime.laneState !== "idle" && runtime.laneState !== "closed"
        )
        .sort(
          (left, right) => getRuntimePriority(left) - getRuntimePriority(right)
        ),
    [actorRuntimes]
  )
  const myProcessingRuntimes = useMemo(
    () =>
      activeRuntimes.filter(
        (runtime) =>
          runtime.laneState === "running" &&
          runtime.activeWakeups.some(
            (wakeup) =>
              wakeup.status === "attached" &&
              wakeup.sourceMemberType === "workspace_member" &&
              wakeup.sourceMemberId === currentViewerWorkspaceMemberId
          )
      ),
    [activeRuntimes, currentViewerWorkspaceMemberId]
  )
  const workingHint = useMemo(
    () => summarizeCurrentUserProcessingActors(myProcessingRuntimes),
    [myProcessingRuntimes]
  )
  const usesExternalMentionPicker = Boolean(mobileMentionPickerWorkspaceId)
  const participantInteractionHandler = usesExternalMentionPicker
    ? openParticipantDetails
    : undefined

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (messages.length > prevMsgCount.current) {
      const el = scrollRef.current
      if (el) {
        const isNearBottom =
          el.scrollHeight - el.scrollTop - el.clientHeight < 150
        if (isNearBottom) {
          bottomRef.current?.scrollIntoView({ behavior: "smooth" })
        } else {
          setShowJumpButton(true)
        }
      }
    }
    prevMsgCount.current = messages.length
  }, [messages.length])

  // Initial scroll to bottom
  useEffect(() => {
    initialScrollPendingRef.current = true
    hasObservedLoadingForConversationRef.current = false
    setShowJumpButton(false)
  }, [conversation.id])

  useEffect(() => {
    if (!initialScrollPendingRef.current) return

    if (loading) {
      hasObservedLoadingForConversationRef.current = true
      return
    }

    if (
      !hasObservedLoadingForConversationRef.current &&
      messages.length === 0
    ) {
      return
    }

    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView()
      setShowJumpButton(false)
      initialScrollPendingRef.current = false
    })
  }, [loading, messages.length])

  useEffect(() => {
    setTitleDraft(conversation.title || "")
    setEditingTitle(false)
  }, [conversation.id, conversation.title])

  useEffect(() => {
    setParticipantDetailOpen(false)
    setSelectedParticipantMember(null)
    setConversationDetailsOpen(false)
  }, [conversation.id])

  useEffect(() => {
    if (!workspaceId) {
      setWorkspaceActors([])
      return
    }

    let cancelled = false

    void api
      .getActors(workspaceId)
      .then((response) => {
        if (cancelled) return
        const nextActors = Array.isArray(response)
          ? (response as Actor[])
          : ((response?.actors || []) as Actor[])
        setWorkspaceActors(
          nextActors.filter((actor) => actor.isActive !== false)
        )
      })
      .catch((error) => {
        if (cancelled) return
        console.error(
          "Failed to load workspace actors for chat mentions:",
          error
        )
        setWorkspaceActors([])
      })

    return () => {
      cancelled = true
    }
  }, [workspaceId])

  // Track scroll position
  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150
    if (isNearBottom) setShowJumpButton(false)
  }

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    setShowJumpButton(false)
  }

  async function handleRetryModelError(itemId: string) {
    setRetryingMessageIds((current) =>
      current.includes(itemId) ? current : [...current, itemId]
    )
    try {
      if (!workspaceId) {
        throw new Error("Workspace context is required to retry a message.")
      }
      await api.retryConversationMessage(workspaceId, conversation.id, itemId)
      toast.success("已请求重试")
    } catch (error) {
      const message = error instanceof Error ? error.message : "重试失败"
      toast.error(message)
      throw error
    } finally {
      setRetryingMessageIds((current) =>
        current.filter((currentItemId) => currentItemId !== itemId)
      )
    }
  }

  function openParticipantDetails(member: ConversationMember) {
    setSelectedParticipantMember(member)
    setParticipantDetailOpen(true)
  }

  function openParticipantDetailsFromConversationSheet(
    member: ConversationMember
  ) {
    setConversationDetailsOpen(false)
    requestAnimationFrame(() => {
      openParticipantDetails(member)
    })
  }

  const title =
    conversation.title ||
    conversation.participants.map((participant) => participant.name).join(", ")
  const memberSummary = summarizeMemberCounts(conversation)

  async function handleSaveTitle() {
    if (!workspaceId || !conversation.permissions?.canManage) {
      setEditingTitle(false)
      setTitleDraft(conversation.title || "")
      return
    }

    const nextTitle = titleDraft.trim()
    if (!nextTitle || nextTitle === (conversation.title || "").trim()) {
      setEditingTitle(false)
      setTitleDraft(conversation.title || "")
      return
    }

    setSavingTitle(true)
    try {
      await api.updateThread(workspaceId, conversation.id, {
        title: nextTitle,
      })
      await onRefreshConversation?.()
      setEditingTitle(false)
    } catch (error) {
      console.error("Failed to update conversation title:", error)
      setTitleDraft(conversation.title || "")
    } finally {
      setSavingTitle(false)
    }
  }

  async function handleConversationAvatarFile(file: File | null) {
    if (!file || !workspaceId || !conversation.permissions?.canManage) return
    setAvatarUploading(true)
    try {
      const uploaded = await api.uploadFile(workspaceId, file)
      await api.updateThread(workspaceId, conversation.id, {
        avatarFileId: uploaded.id,
      })
      await onRefreshConversation?.()
    } catch (error) {
      console.error("Failed to update conversation avatar:", error)
    } finally {
      setAvatarUploading(false)
    }
  }

  async function handleResolveInteraction(
    interactionId: string,
    data: {
      answers?: {
        fieldId: string
        selectedOptionIds?: string[]
        otherText?: string
        text?: string
      }[]
      selectedOptionId?: string
      decision?: "approve" | "reject"
      preset?: "once" | "actor" | "conversation" | "workspace"
      note?: string
    }
  ): Promise<InteractionRequestSummary> {
    if (!workspaceId) {
      throw new Error(
        "Workspace context is required to respond to interactions."
      )
    }

    const result = await api.resolveThreadInteraction(
      workspaceId,
      conversation.id,
      interactionId,
      data
    )
    handleInteractionUpdated({
      conversationId: conversation.id,
      interactionId,
      itemId: result.interaction.itemId,
      interaction: result.interaction,
    })
    return result.interaction
  }

  async function handleComposerSubmit({
    contentBlocks,
    targetParticipantIds,
    targetActorIds,
  }: ChatComposerSubmitPayload) {
    await onSend(contentBlocks, targetParticipantIds, targetActorIds)
    setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    }, 50)
  }

  return (
    <div
      className={cn(
        "grid h-full min-h-0 w-full max-w-full min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-background",
        viewportLocked ? "h-[100dvh]" : "h-full"
      )}
    >
      {/* Header */}
      {usesExternalMentionPicker ? (
        <div className="sticky top-0 z-20 border-b border-border bg-background px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
          <div className="relative flex items-center justify-between">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex h-8 w-8 items-center justify-center text-foreground transition-colors hover:text-primary"
              aria-label="Back"
            >
              <ArrowDown className="size-4 rotate-90" />
            </button>
            <div className="pointer-events-none absolute inset-x-12 left-1/2 -translate-x-1/2 text-center">
              <h2 className="truncate text-sm font-semibold tracking-tight text-foreground">
                {title}
              </h2>
            </div>
            <button
              type="button"
              onClick={() => setConversationDetailsOpen(true)}
              className="inline-flex h-8 w-8 items-center justify-center text-foreground transition-colors hover:text-primary"
              aria-label="More"
            >
              <MoreHorizontal className="size-4" />
            </button>
          </div>
        </div>
      ) : (
        <div className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-background px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-4 lg:px-6 lg:py-4">
          <div className="flex min-w-0 items-center gap-3">
            {onBack && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 lg:hidden"
                onClick={onBack}
              >
                <ArrowDown className="h-4 w-4 rotate-90" />
              </Button>
            )}
            <div className="group relative">
              <button
                type="button"
                className="relative rounded-full transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70"
                onClick={() => conversationAvatarInputRef.current?.click()}
                disabled={!conversation.permissions?.canManage || avatarUploading}
                title={
                  conversation.permissions?.canManage
                    ? "Change conversation avatar"
                    : undefined
                }
              >
                <ChatAvatar
                  name={title}
                  avatarUrl={conversation.avatarUrl}
                  entityType="conversation"
                  size="lg"
                  className="size-12"
                />
                <TransportKindIcon
                  kind={conversation.transportKind}
                  size={14}
                  className="absolute -right-1 -bottom-1 size-5 p-0.5"
                />
                {conversation.permissions?.canManage ? (
                  <div className="absolute inset-0 flex items-center justify-center rounded-full bg-foreground/55 text-background opacity-0 transition-opacity group-hover:opacity-100">
                    <Pencil className="size-4" />
                  </div>
                ) : null}
              </button>
              <input
                ref={conversationAvatarInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0] || null
                  void handleConversationAvatarFile(file)
                  event.target.value = ""
                }}
              />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {editingTitle ? (
                  <div className="flex items-center gap-2">
                    <Input
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault()
                          void handleSaveTitle()
                        }
                        if (event.key === "Escape") {
                          setEditingTitle(false)
                          setTitleDraft(conversation.title || "")
                        }
                      }}
                      className="h-8 w-[220px]"
                      autoFocus
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      onClick={() => void handleSaveTitle()}
                      disabled={savingTitle}
                    >
                      <Check className="size-4" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <h2 className="truncate text-sm font-semibold tracking-tight text-foreground">
                      {title}
                    </h2>
                    {conversation.permissions?.canManage ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7 text-muted-foreground"
                        onClick={() => setEditingTitle(true)}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                    ) : null}
                  </>
                )}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {memberSummary ||
                  `${conversation.members.length} member${conversation.members.length > 1 ? "s" : ""}`}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <ChatMemberStrip
              members={conversation.members}
              runtimeByActor={actorRuntimes}
              max={5}
              size="lg"
              onMemberClick={participantInteractionHandler}
              contactBasePath={contactBasePath}
              onAdd={
                conversation.permissions?.canManageMembers
                  ? () => setMemberDialogOpen(true)
                  : undefined
              }
            />
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="relative min-h-0 max-w-full min-w-0 bg-muted/20">
        <div
          ref={scrollRef}
          className="h-full max-w-full min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-5 lg:px-6"
          onScroll={handleScroll}
        >
          <div className="flex min-h-full w-full max-w-full min-w-0 flex-col gap-4">
            {loading ? (
              <ChatThreadSkeleton />
            ) : messages.length === 0 ? (
              <div className="flex h-full min-h-[12rem] flex-1 flex-col items-center justify-center gap-4 rounded-[28px] border border-dashed border-border bg-background px-6 py-10 text-center shadow-sm">
                <ChatAvatar
                  name={title}
                  avatarUrl={conversation.avatarUrl}
                  entityType="conversation"
                  size="lg"
                  className="size-20 rounded-3xl"
                />
                <div>
                  <h3 className="mb-2 text-lg font-semibold text-foreground">
                    Chat in {title}
                  </h3>
                  <p className="max-w-md text-sm text-muted-foreground">
                    No shared messages in this conversation yet.
                  </p>
                </div>
              </div>
            ) : (
              messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  messageId={msg.id}
                  role={msg.role}
                  messageType={msg.messageType}
                  metadata={msg.metadata}
                  author={msg.author}
                  contentBlocks={msg.contentBlocks}
                  actorName={msg.actorName}
                  actorAvatarUrl={
                    msg.fromActorId
                      ? actorMemberMap[msg.fromActorId]?.avatarUrl
                      : undefined
                  }
                  actorEmoji={msg.actorEmoji}
                  actorRole={msg.actorRole}
                  actorRuntime={
                    msg.fromActorId
                      ? actorRuntimes?.[msg.fromActorId]
                      : undefined
                  }
                  timestamp={msg.createdAt}
                  isUser={
                    msg.author
                      ? msg.author.memberType === "workspace_member" &&
                        msg.author.workspaceMemberId === currentViewerWorkspaceMemberId
                      : msg.role === "user"
                  }
                  status={msg.deliveryStatus}
                  toolsUsed={msg.toolsUsed}
                  serverToolCalls={msg.serverToolCalls}
                  citationSources={msg.citationSources}
                  coordination={msg.coordination}
                  conversationMembers={conversation.members}
                  targetParticipantIds={msg.targetParticipantIds}
                  targetActorIds={msg.targetActorIds}
                  workspaceActors={workspaceActorDirectory}
                  transport={msg.transport}
                  transportDeliveries={msg.transportDeliveries}
                  interaction={msg.interaction}
                  enableTablePreview={viewportLocked}
                  viewerWorkspaceMemberId={
                    currentViewerWorkspaceMemberId || undefined
                  }
                  contactBasePath={contactBasePath}
                  onParticipantClick={participantInteractionHandler}
                  onResolveInteraction={handleResolveInteraction}
                  retryPending={retryingMessageIds.includes(msg.id)}
                  onRetryModelError={handleRetryModelError}
                />
              ))
            )}

            <div ref={bottomRef} />
          </div>
        </div>
        {showJumpButton && (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
            <button
              onClick={scrollToBottom}
              className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs text-primary-foreground shadow-lg transition-all hover:bg-primary/85"
            >
              <ArrowDown className="h-3 w-3" />
              New messages
            </button>
          </div>
        )}
      </div>

      {/* Input area — textarea with toolbar */}
      <div className="sticky bottom-0 z-20 border-t border-border bg-muted/20 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {/* Responding hint */}
        {workingHint && (
          <div className="mb-2 flex items-center gap-2 px-1">
            <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            <span className="text-xs text-muted-foreground">{workingHint}</span>
          </div>
        )}
        <ChatComposer
          workspaceId={workspaceId || null}
          participants={mentionableParticipants}
          placeholder="Type a message..."
          onSubmit={handleComposerSubmit}
        />
      </div>
      {usesExternalMentionPicker ? (
        <MobileConversationDetailsDialog
          conversation={conversation}
          open={conversationDetailsOpen}
          onOpenChange={setConversationDetailsOpen}
          onMemberClick={openParticipantDetailsFromConversationSheet}
          contactBasePath={contactBasePath}
        />
      ) : null}
      {usesExternalMentionPicker ? (
        <ChatParticipantDetailDialog
          member={selectedParticipantMember}
          open={participantDetailOpen}
          onOpenChange={setParticipantDetailOpen}
          contactBasePath={contactBasePath}
        />
      ) : null}
      <ConversationMemberPickerDialog
        open={memberDialogOpen}
        onOpenChange={setMemberDialogOpen}
        workspaceId={workspaceId || ""}
        conversationId={conversation.id}
        existingMembers={conversation.members}
        onAdded={async () => {
          await onRefreshConversation?.()
        }}
      />
    </div>
  )
}
