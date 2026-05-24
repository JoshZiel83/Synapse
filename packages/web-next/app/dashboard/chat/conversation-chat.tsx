"use client"

import type {
  Actor,
  ActorRuntimeState,
  InteractionRequestSummary,
  ConversationReplyRef,
  RemoteAgentRuntimeState,
} from "@synapse/shared"
import { CONVERSATION_PARTICIPANT_TYPE } from "@synapse/shared"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import ChatComposer, {
  CHAT_COMPOSER_MENTION_TARGET_TYPE,
  type ChatComposerParticipant,
  type ChatComposerSubmitPayload,
} from "@/components/chat-composer"
import { normalizeChiefActorOption } from "@/app/dashboard/chief-actor-picker-shared"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { ArrowDown, MoreHorizontal } from "lucide-react"
import MessageBubble from "./message-bubble"
import ActorActivityBubble from "./actor-activity-bubble"
import type {
  ConversationMember,
  ConversationSummary,
  FeedMessage,
} from "@/stores/chat-store"
import { api, type ChatInteractionResolveInput } from "@/lib/api"
import ChatAvatar from "./chat-avatar"
import ChatMemberStrip from "./chat-member-strip"
import ChatParticipantDetailDialog from "./chat-participant-detail-dialog"
import MobileConversationDetailsDialog from "./mobile-conversation-details-dialog"
import TransportKindIcon from "./transport-kind-icon"
import { getActorRuntimePriority, isActorRuntimeActive } from "./runtime-ui"
import { useChatStore } from "@/stores/chat-store"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { isActorRuntimeProcessingWorkspaceMember } from "@synapse/shared"

interface ConversationChatProps {
  conversation: ConversationSummary
  messages: FeedMessage[]
  loading: boolean
  composerDisabled?: boolean
  actorRuntimes?: Record<string, ActorRuntimeState>
  remoteAgentRuntimes?: Record<string, RemoteAgentRuntimeState>
  onSend: (payload: ChatComposerSubmitPayload) => Promise<void> | void
  onBack?: () => void
  workspaceId?: string
  onRefreshConversation?: () => Promise<void> | void
  viewportLocked?: boolean
  mobileMentionPickerWorkspaceId?: string
  contactBasePath?: string
}

function summarizeMemberCounts(conversation: ConversationSummary) {
  const workspaceMemberCount = conversation.members.filter(
    (member) =>
      member.participantType === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER
  ).length
  const actorCount = conversation.members.filter(
    (member) => member.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
  ).length
  const remoteAgentCount = conversation.members.filter(
    (member) =>
      member.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
  ).length
  const externalCount = conversation.members.filter(
    (member) =>
      member.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL
  ).length
  const workspaceMemberLabel = `${workspaceMemberCount} member${workspaceMemberCount === 1 ? "" : "s"}`
  const actorLabel = `${actorCount} actor${actorCount === 1 ? "" : "s"}`
  const remoteAgentLabel = `${remoteAgentCount} remote agent${remoteAgentCount === 1 ? "" : "s"}`
  if (externalCount === 0) {
    return remoteAgentCount > 0
      ? `${workspaceMemberLabel} · ${actorLabel} · ${remoteAgentLabel}`
      : `${workspaceMemberLabel} · ${actorLabel}`
  }
  const externalLabel = `${externalCount} external${externalCount === 1 ? "" : "s"}`
  return remoteAgentCount > 0
    ? `${workspaceMemberLabel} · ${actorLabel} · ${remoteAgentLabel} · ${externalLabel}`
    : `${workspaceMemberLabel} · ${actorLabel} · ${externalLabel}`
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
  composerDisabled = false,
  actorRuntimes,
  remoteAgentRuntimes,
  onSend,
  onBack,
  workspaceId,
  viewportLocked = false,
  mobileMentionPickerWorkspaceId,
  contactBasePath = "/dashboard/contacts",
}: ConversationChatProps) {
  const { currentWorkspaceMemberId } = useWorkspace()
  const handleInteractionUpdated = useChatStore(
    (state) => state.handleInteractionUpdated
  )
  const loadOlderMessages = useChatStore((state) => state.loadOlderMessages)
  const currentViewerWorkspaceMemberId = currentWorkspaceMemberId || ""
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const initialScrollPendingRef = useRef(true)
  const hasObservedLoadingForConversationRef = useRef(false)
  const [showJumpButton, setShowJumpButton] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  // `null` = unknown (default), `true` = more older messages exist, `false`
  // = the API said it's reached the start. Reset whenever the conversation
  // changes since the new conversation has a fresh history.
  const [hasMoreOlder, setHasMoreOlder] = useState<boolean | null>(null)
  const [conversationDetailsOpen, setConversationDetailsOpen] = useState(false)
  const [participantDetailOpen, setParticipantDetailOpen] = useState(false)
  const [selectedParticipantMember, setSelectedParticipantMember] =
    useState<ConversationMember | null>(null)
  const [retryingMessageIds, setRetryingMessageIds] = useState<string[]>([])
  const [workspaceActors, setWorkspaceActors] = useState<Actor[]>([])
  const [replyTo, setReplyTo] = useState<ConversationReplyRef | null>(null)
  const prevMsgCount = useRef(messages.length)
  const mentionableParticipants = useMemo<ChatComposerParticipant[]>(() => {
    const inConversationActorIds = new Set(
      conversation.members
        .filter(
          (member) =>
            member.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
        )
        .map((member) => member.id)
    )
    const inConversationActors = conversation.members
      .filter(
        (member) =>
          member.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
      )
      .map((member) => ({
        id: member.id,
        name: member.name,
        participantType: CONVERSATION_PARTICIPANT_TYPE.ACTOR,
        targetType: CHAT_COMPOSER_MENTION_TARGET_TYPE.ACTOR,
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
      .filter(
        (member) =>
          member.participantType !== CONVERSATION_PARTICIPANT_TYPE.ACTOR
      )
      .map((member) => ({
        id: member.participantId,
        name: member.name,
        participantType: member.participantType,
        targetType: CHAT_COMPOSER_MENTION_TARGET_TYPE.PARTICIPANT,
        participantId: member.participantId,
        actorId:
          member.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
            ? member.id
            : undefined,
        workspaceMemberId:
          member.participantType ===
          CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER
            ? member.id
            : undefined,
        externalUserKey:
          member.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL
            ? member.externalUserKey
            : undefined,
        transportAddressId: member.transportAddressId,
        transportKind: member.transportKind,
        inGroup: true,
        role: member.role,
        title: member.title,
        avatarUrl: member.avatarUrl,
        emoji: member.emoji,
        description:
          member.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL
            ? member.linkedWorkspaceMemberName
              ? `External participant · linked to ${member.linkedWorkspaceMemberName}`
              : "External participant"
            : member.participantType ===
                CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
              ? member.title || member.role || "Remote agent"
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
          participantType: CONVERSATION_PARTICIPANT_TYPE.ACTOR,
          targetType: CHAT_COMPOSER_MENTION_TARGET_TYPE.ACTOR,
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
          .filter(
            (member) =>
              member.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
          )
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
        .filter((runtime) => isActorRuntimeActive(runtime))
        .sort(
          (left, right) =>
            getActorRuntimePriority(left) - getActorRuntimePriority(right)
        ),
    [actorRuntimes]
  )
  const currentTurnRuntimes = useMemo(
    () =>
      activeRuntimes.filter((runtime) =>
        Boolean(runtime.currentTurnPreview?.turnId)
      ),
    [activeRuntimes]
  )
  const myProcessingRuntimes = useMemo(
    () =>
      currentTurnRuntimes.filter(
        (runtime) =>
          runtime.laneState === "running" &&
          isActorRuntimeProcessingWorkspaceMember(
            runtime,
            currentViewerWorkspaceMemberId
          )
      ),
    [currentTurnRuntimes, currentViewerWorkspaceMemberId]
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
    setHasMoreOlder(null)
    setLoadingOlder(false)
  }, [conversation.id])

  const handleLoadOlder = async () => {
    if (!workspaceId || loadingOlder || hasMoreOlder === false) return
    const earliestSequence = messages.length > 0 ? messages[0].sequence : null
    if (earliestSequence === null) return
    setLoadingOlder(true)
    try {
      // Capture viewport height so we can preserve scroll position when the
      // older messages get prepended — without this the list would jump
      // upward and dump the user back to the new content's top edge.
      const el = scrollRef.current
      const previousScrollHeight = el?.scrollHeight ?? 0
      const previousScrollTop = el?.scrollTop ?? 0

      const result = await loadOlderMessages(
        workspaceId,
        conversation.id,
        earliestSequence
      )

      if (result) {
        setHasMoreOlder(result.hasMoreBefore)
      }

      // After React paints the new items the scroll height grew; bump
      // scrollTop by the delta so the user stays anchored on the message
      // they were reading.
      requestAnimationFrame(() => {
        const next = scrollRef.current
        if (!next) return
        const delta = next.scrollHeight - previousScrollHeight
        if (delta > 0) {
          next.scrollTop = previousScrollTop + delta
        }
      })
    } finally {
      setLoadingOlder(false)
    }
  }

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
    setParticipantDetailOpen(false)
    setSelectedParticipantMember(null)
    setConversationDetailsOpen(false)
    setReplyTo(null)
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

  async function handleResolveInteraction(
    interactionId: string,
    data: ChatInteractionResolveInput
  ): Promise<InteractionRequestSummary> {
    if (!workspaceId) {
      throw new Error(
        "Workspace context is required to respond to interactions."
      )
    }

    const result = await api.resolveChatInteraction(
      workspaceId,
      conversation.id,
      interactionId,
      data
    )
    handleInteractionUpdated({
      conversationId: conversation.id,
      interactionId: result.interaction.id,
      itemId: result.interaction.itemId,
      interaction: result.interaction,
    })
    return result.interaction
  }

  async function handleComposerSubmit(payload: ChatComposerSubmitPayload) {
    await onSend(payload)
    setReplyTo(null)
    setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    }, 50)
    // Make sure we send a final `stopped` typing state on submit so the
    // indicator on the recipient side disappears promptly.
    void sendTypingState(conversation.id, "stopped")
    lastTypingSentRef.current = "stopped"
  }

  const sendTypingState = useChatStore((state) => state.sendTypingState)
  const typersForConversation = useChatStore(
    (state) => state.typingByConversation[conversation.id]
  )
  const activeTypers = useMemo(() => {
    if (!typersForConversation) return [] as string[]
    const now = Date.now()
    return Object.entries(typersForConversation)
      .filter(([, expireAt]) => expireAt > now)
      .map(([memberId]) => memberId)
  }, [typersForConversation])

  // Debounced typing emit: send "started" on first keystroke, then re-send
  // "started" at most every 3s while typing; send "stopped" after 4s of
  // silence.
  const lastTypingSentRef = useRef<"started" | "stopped" | null>(null)
  const typingStartedAtRef = useRef<number>(0)
  const typingStoppedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const handleTypingHeartbeat = useCallback(() => {
    const now = Date.now()
    if (
      lastTypingSentRef.current !== "started" ||
      now - typingStartedAtRef.current > 3_000
    ) {
      void sendTypingState(conversation.id, "started")
      lastTypingSentRef.current = "started"
      typingStartedAtRef.current = now
    }
    if (typingStoppedTimerRef.current) {
      clearTimeout(typingStoppedTimerRef.current)
    }
    typingStoppedTimerRef.current = setTimeout(() => {
      void sendTypingState(conversation.id, "stopped")
      lastTypingSentRef.current = "stopped"
    }, 4_000)
  }, [conversation.id, sendTypingState])

  useEffect(() => {
    return () => {
      if (typingStoppedTimerRef.current) {
        clearTimeout(typingStoppedTimerRef.current)
      }
    }
  }, [])

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
            <div className="relative">
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
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold tracking-tight text-foreground">
                {title}
              </h2>
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
              runtimeByRemoteAgent={remoteAgentRuntimes}
              max={5}
              size="lg"
              onMemberClick={participantInteractionHandler}
              contactBasePath={contactBasePath}
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
              <>
                {hasMoreOlder !== false ? (
                  <div className="flex justify-center pt-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={loadingOlder}
                      onClick={() => void handleLoadOlder()}
                    >
                      {loadingOlder
                        ? "Loading earlier messages..."
                        : "Load earlier messages"}
                    </Button>
                  </div>
                ) : null}
                {messages.map((msg) => (
                  <MessageBubble
                    key={msg.id}
                    kind={msg.kind}
                    messageId={msg.id}
                    role={msg.role}
                    messageType={msg.messageType}
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
                    remoteAgentRuntime={
                      msg.author?.participantType ===
                        CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT &&
                      msg.author.remoteAgentId
                        ? remoteAgentRuntimes?.[msg.author.remoteAgentId]
                        : undefined
                    }
                    timestamp={msg.createdAt}
                    isUser={
                      msg.author
                        ? msg.author.participantType ===
                            CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
                          msg.author.workspaceMemberId ===
                            currentViewerWorkspaceMemberId
                        : msg.role === "user"
                    }
                    status={msg.deliveryStatus}
                    toolsUsed={msg.toolsUsed}
                    serverToolCalls={msg.serverToolCalls}
                    citationSources={msg.citationSources}
                    coordination={msg.coordination}
                    conversationMembers={conversation.members}
                    restrictedAudienceParticipantIds={
                      msg.restrictedAudienceParticipantIds
                    }
                    replyTo={msg.replyTo}
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
                    onQuoteMessage={setReplyTo}
                  />
                ))}
              </>
            )}

            {!loading
              ? currentTurnRuntimes.map((runtime) => (
                  <ActorActivityBubble
                    key={`${runtime.actorId}:${runtime.currentTurnPreview!.turnId}`}
                    conversationId={conversation.id}
                    workspaceId={workspaceId}
                    runtime={runtime}
                    member={actorMemberMap[runtime.actorId]}
                  />
                ))
              : null}

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
        {/* Typing indicator (other participants currently typing) */}
        {activeTypers.length > 0 && (
          <div className="mb-2 flex items-center gap-2 px-1">
            <div className="flex gap-0.5">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:120ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:240ms]" />
            </div>
            <span className="text-xs text-muted-foreground">
              {activeTypers.length === 1
                ? "Someone is typing…"
                : `${activeTypers.length} people are typing…`}
            </span>
          </div>
        )}
        <ChatComposer
          workspaceId={workspaceId || null}
          participants={mentionableParticipants}
          disabled={composerDisabled}
          placeholder="Type a message..."
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          onSubmit={handleComposerSubmit}
          onTyping={handleTypingHeartbeat}
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
    </div>
  )
}
