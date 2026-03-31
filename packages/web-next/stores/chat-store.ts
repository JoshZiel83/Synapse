"use client"

import { create } from "zustand"
import { api } from "@/lib/api"
import {
  clearPendingConversationRead,
  queuePendingConversationRead,
} from "@/lib/read-watermark-queue"
import type {
  ActorRuntimeState,
  CanonicalContentBlock,
  ConversationEntityRef,
  ConversationFeedEventPayloadMap,
  ConversationFeedEventType,
  ConversationFeedItem,
  ConversationMessageTransportContext,
  ConversationMessageTransportDelivery,
  InteractionRequestSummary,
  TransportKind,
} from "@synapse/shared"
import {
  extractText,
  normalizeCanonicalContentBlocks,
  summarizeConversationEvent,
  textBlocks,
} from "@synapse/shared"

export interface ConversationParticipant {
  id: string
  name: string
  role: string
  emoji?: string
  avatarUrl?: string
  title?: string
}

export interface ConversationMember {
  memberId: string
  participantId: string
  type: "actor" | "user" | "external"
  id: string
  name: string
  role?: string
  title?: string
  emoji?: string
  avatarUrl?: string
  sessionStatus?: string
  externalUserKey?: string
  transportKind?: TransportKind
  transportAddressId?: string
  linkedUserId?: string
  linkedUserName?: string
  linkedUserAvatarUrl?: string
}

export interface ConversationSummary {
  id: string
  status: "active" | "completed" | "failed"
  transportKind?: TransportKind
  participants: ConversationParticipant[]
  members: ConversationMember[]
  lastMessage?: {
    content: string
    role: string
    actorName?: string
    createdAt: string
  }
  unreadCount: number
  createdAt: string
  title?: string
  name?: string
  avatarUrl?: string
  permissions?: {
    canManage?: boolean
    canManageMembers?: boolean
  }
}

export interface ServerToolCall {
  type: "web_search" | "web_fetch"
  query?: string
  url?: string
  results?: { url: string; title: string; pageAge?: string }[]
}

export interface FeedMessage {
  id: string
  kind: "message" | "event"
  conversationId: string
  sequence: number
  sessionId: string
  role: string
  messageType?: string
  content: string
  contentBlocks: CanonicalContentBlock[]
  author?: ConversationEntityRef
  fromActorId?: string
  fromUserId?: string
  actorName?: string
  actorRole?: string
  actorEmoji?: string
  createdAt: string
  clientMessageId?: string
  deliveryStatus?: "sending" | "retrying" | "sent"
  metadata?: Record<string, unknown>
  toolsUsed?: string[]
  serverToolCalls?: ServerToolCall[]
  citationSources?: Record<string, { url: string; title: string }>
  coordination?: boolean
  targetParticipantIds?: string[]
  targetActorIds?: string[]
  transport?: ConversationMessageTransportContext
  transportDeliveries?: ConversationMessageTransportDelivery[]
  eventType?: ConversationFeedEventType
  eventPayload?: ConversationFeedEventPayloadMap[ConversationFeedEventType]
  interaction?: InteractionRequestSummary
}

export type ThinkingPhase = "thinking" | "tool" | "responding" | "error"
export type ActorAvatarStatus = "idle" | ThinkingPhase
export type ConversationRuntimeMap = Record<
  string,
  Record<string, ActorRuntimeState>
>

export interface OutboxEntry {
  clientMessageId: string
  workspaceId: string
  conversationId: string
  contentBlocks: CanonicalContentBlock[]
  targetParticipantIds: string[]
  targetActorIds: string[]
  createdAt: string
  optimisticSequence: number
  status: "sending" | "retrying"
  attemptCount: number
  firstFailedAt?: string
  lastAttemptAt?: string
  lastErrorMessage?: string
}

interface ChatState {
  conversations: ConversationSummary[]
  selectedConversationId: string | null
  messages: FeedMessage[]
  outbox: Record<string, OutboxEntry>
  loadingConversations: boolean
  loadingMessages: boolean
  runtimeMap: ConversationRuntimeMap
  runtimeSeqMap: Record<string, number>
  totalUnread: number

  loadConversations: (
    workspaceId: string,
    options?: { silent?: boolean }
  ) => Promise<void>
  selectConversation: (conversationId: string | null) => void
  loadMessages: (workspaceId: string, conversationId: string) => Promise<void>
  sendMessage: (
    workspaceId: string,
    conversationId: string,
    contentBlocks: CanonicalContentBlock[],
    targetParticipantIds?: string[],
    targetActorIds?: string[]
  ) => Promise<void>
  hydrateOutbox: (workspaceId: string) => void
  flushOutbox: (workspaceId: string) => void
  createWorkspaceThread: (
    workspaceId: string,
    kind: "private" | "group",
    actorIds: string[],
    content?: string,
    targetActorIdOrIds?: string | string[],
    contentBlocks?: CanonicalContentBlock[],
    title?: string
  ) => Promise<string>
  markConversationRead: (
    conversationId: string,
    readUpToSequence: number
  ) => Promise<void>

  handleConversationItemCreated: (item: ConversationFeedItem) => void
  handleRuntimeUpdated: (payload: {
    conversationId: string
    runtimeSeq: number
    snapshot: ActorRuntimeState
  }) => void
  handleConversationUpdated: (payload: {
    conversationId: string
    action: "created" | "profile_updated" | "cancelled"
    title?: string | null
    avatarUrl?: string | null
  }) => void
  handleInteractionUpdated: (payload: {
    conversationId: string
    interactionId: string
    itemId?: string
    interaction: InteractionRequestSummary
  }) => void
}

function normalizeContentBlocks(blocks: unknown): CanonicalContentBlock[] {
  if (Array.isArray(blocks)) {
    return normalizeCanonicalContentBlocks(blocks)
  }
  return []
}

function previewTextForItem(item: FeedMessage) {
  const text = item.content.trim()
  if (text) return text
  if (item.contentBlocks.some((block) => block.type === "file_ref"))
    return "Attachment"
  return item.kind === "event" ? "System event" : ""
}

function sortMessages(messages: FeedMessage[]) {
  return [...messages].sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence
    return (
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    )
  })
}

function sortConversations(conversations: ConversationSummary[]) {
  return [...conversations].sort((left, right) => {
    const leftAt = left.lastMessage?.createdAt || left.createdAt
    const rightAt = right.lastMessage?.createdAt || right.createdAt
    return new Date(rightAt).getTime() - new Date(leftAt).getTime()
  })
}

function sumConversationUnread(conversations: ConversationSummary[]) {
  return conversations.reduce(
    (sum, conversation) => sum + conversation.unreadCount,
    0
  )
}

function createClientMessageId() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID()
  }
  return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function createOptimisticSequence(messages: FeedMessage[]) {
  const maxSequence = messages.reduce(
    (max, message) => Math.max(max, message.sequence),
    0
  )
  return Math.max(Date.now() * 1000, maxSequence) + 1
}

const OUTBOX_STORAGE_KEY = "chat-outbox:v2"
const OUTBOX_RETRY_DELAYS_MS = [1500, 3000, 5000, 8000, 12000, 20000, 30000]
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

function getOutboxRetryDelay(attemptCount: number) {
  const index = Math.max(
    0,
    Math.min(attemptCount, OUTBOX_RETRY_DELAYS_MS.length - 1)
  )
  const baseDelay = OUTBOX_RETRY_DELAYS_MS[index] || 30000
  return baseDelay + Math.round(Math.random() * 600)
}

function loadStoredOutbox(): Record<string, OutboxEntry> {
  if (typeof window === "undefined") return {}

  try {
    const raw = window.localStorage.getItem(OUTBOX_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as OutboxEntry[] | null
    if (!Array.isArray(parsed)) return {}

    return Object.fromEntries(
      parsed
        .filter((entry) => entry && typeof entry.clientMessageId === "string")
        .map((entry) => [entry.clientMessageId, entry])
    )
  } catch {
    return {}
  }
}

function persistOutbox(outbox: Record<string, OutboxEntry>) {
  if (typeof window === "undefined") return

  const entries = Object.values(outbox).sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  )
  window.localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(entries))
}

function outboxEntryToMessage(entry: OutboxEntry): FeedMessage {
  return {
    id: `temp:${entry.clientMessageId}`,
    kind: "message",
    conversationId: entry.conversationId,
    sequence: entry.optimisticSequence,
    sessionId: "",
    role: "user",
    content: extractText(entry.contentBlocks),
    contentBlocks: entry.contentBlocks,
    createdAt: entry.createdAt,
    clientMessageId: entry.clientMessageId,
    deliveryStatus: entry.status,
    targetParticipantIds: entry.targetParticipantIds,
    targetActorIds: entry.targetActorIds,
  }
}

function mergeConversationMessagesWithOutbox(
  messages: FeedMessage[],
  outbox: Record<string, OutboxEntry>,
  conversationId: string
) {
  let nextMessages = sortMessages(messages)
  const pendingEntries = Object.values(outbox)
    .filter(
      (entry) => entry.workspaceId && entry.conversationId === conversationId
    )
    .sort((left, right) => left.optimisticSequence - right.optimisticSequence)

  for (const entry of pendingEntries) {
    const hasServerMessage = nextMessages.some(
      (message) =>
        message.clientMessageId &&
        message.clientMessageId === entry.clientMessageId &&
        message.id !== `temp:${entry.clientMessageId}`
    )
    if (hasServerMessage) continue
    nextMessages = upsertFeedMessage(nextMessages, outboxEntryToMessage(entry))
  }

  return nextMessages
}

function applyOutboxToConversations(
  conversations: ConversationSummary[],
  outbox: Record<string, OutboxEntry>,
  runtimeMap: ConversationRuntimeMap
) {
  let nextConversations = conversations
  const pendingEntries = Object.values(outbox).sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  )

  for (const entry of pendingEntries) {
    const optimisticMessage = outboxEntryToMessage(entry)
    nextConversations = sortConversations(
      nextConversations.map((conversation) =>
        conversation.id === entry.conversationId &&
        (!conversation.lastMessage ||
          new Date(entry.createdAt).getTime() >=
            new Date(conversation.lastMessage.createdAt).getTime())
          ? applyRuntimeMapToConversation(
              applyFeedMessageToConversation(
                conversation,
                optimisticMessage,
                true
              ),
              runtimeMap[conversation.id]
            )
          : conversation
      )
    )
  }

  return nextConversations
}

function upsertFeedMessage(messages: FeedMessage[], item: FeedMessage) {
  const byIdIndex = messages.findIndex((message) => message.id === item.id)
  if (byIdIndex >= 0) {
    const next = [...messages]
    next[byIdIndex] = item
    return sortMessages(next)
  }

  if (item.clientMessageId) {
    const optimisticIndex = messages.findIndex(
      (message) => message.clientMessageId === item.clientMessageId
    )
    if (optimisticIndex >= 0) {
      const next = [...messages]
      next[optimisticIndex] = item
      return sortMessages(next)
    }
  }

  return sortMessages([...messages, item])
}

function feedItemToMessage(item: ConversationFeedItem): FeedMessage {
  if (item.kind === "event") {
    const content = summarizeConversationEvent(item.eventType, item.payload)
    return {
      id: item.itemId,
      kind: "event",
      conversationId: item.conversationId,
      sequence: item.sequence,
      sessionId: item.sessionId || "",
      role: "system",
      content,
      contentBlocks: textBlocks(content),
      author: item.author,
      fromActorId: item.author?.actorId,
      fromUserId: item.author?.userId,
      actorName: item.author?.name,
      actorRole: item.author?.role,
      actorEmoji: item.author?.avatarEmoji,
      createdAt: item.createdAt,
      deliveryStatus: "sent",
      eventType: item.eventType,
      eventPayload: item.payload,
      interaction:
        item.eventType === "interaction_requested" &&
        item.payload &&
        typeof item.payload === "object" &&
        "interaction" in item.payload
          ? (item.payload.interaction as InteractionRequestSummary)
          : undefined,
    }
  }

  const targetParticipantIds = item.targets
    .map((target) => target.participantId || target.memberId)
    .filter((targetId): targetId is string => Boolean(targetId))
  const metadata = item.metadata || {}
  const targetActorIds = Array.isArray(metadata.targetActorIds)
    ? metadata.targetActorIds.filter(
        (targetId): targetId is string =>
          typeof targetId === "string" && targetId.length > 0
      )
    : undefined

  return {
    id: item.itemId,
    kind: "message",
    conversationId: item.conversationId,
    sequence: item.sequence,
    sessionId: item.sessionId || "",
    role: item.role,
    messageType: item.messageType,
    content: item.content,
    contentBlocks: normalizeContentBlocks(item.contentBlocks),
    author: item.author,
    fromActorId: item.author?.actorId,
    fromUserId: item.author?.userId,
    actorName:
      item.author?.memberType === "actor" ? item.author.name : undefined,
    actorRole: item.author?.role,
    actorEmoji: item.author?.avatarEmoji,
    createdAt: item.createdAt,
    clientMessageId: item.clientMessageId,
    deliveryStatus: "sent",
    metadata,
    toolsUsed: metadata.toolsUsed as string[] | undefined,
    serverToolCalls: metadata.serverToolCalls as ServerToolCall[] | undefined,
    citationSources: metadata.citationSources as
      | Record<string, { url: string; title: string }>
      | undefined,
    coordination: Boolean(metadata.coordination),
    targetParticipantIds,
    targetActorIds,
    transport: item.transport,
    transportDeliveries: item.transportDeliveries,
  }
}

function applyMemberJoined(
  conversation: ConversationSummary,
  payload: ConversationFeedEventPayloadMap["member_joined"]
) {
  const nextMembers = [...conversation.members]
  const nextParticipants = [...conversation.participants]

  for (const member of payload.members) {
    const id =
      member.actorId || member.userId || member.participantId || member.memberId
    if (!id) continue

    const normalizedMember: ConversationMember = {
      memberId: member.memberId,
      participantId: member.participantId || member.memberId,
      type:
        member.memberType === "user"
          ? "user"
          : member.memberType === "external"
            ? "external"
            : "actor",
      id,
      name: member.name || "Unknown",
      title: member.title,
      role: member.role,
      emoji: member.avatarEmoji,
      avatarUrl: member.avatarUrl,
    }

    if (
      !nextMembers.some(
        (existing) => existing.memberId === normalizedMember.memberId
      )
    ) {
      nextMembers.push(normalizedMember)
    }

    if (
      normalizedMember.type === "actor" &&
      !nextParticipants.some(
        (participant) => participant.id === normalizedMember.id
      )
    ) {
      nextParticipants.push({
        id: normalizedMember.id,
        name: normalizedMember.name,
        role: normalizedMember.role || "specialist",
        emoji: normalizedMember.emoji,
        avatarUrl: normalizedMember.avatarUrl,
        title: normalizedMember.title,
      })
    }
  }

  return {
    ...conversation,
    members: nextMembers,
    participants: nextParticipants,
  }
}

function applyMemberRemoved(
  conversation: ConversationSummary,
  payload:
    | ConversationFeedEventPayloadMap["member_kicked"]
    | ConversationFeedEventPayloadMap["member_left"]
) {
  const removedActorIds = new Set(
    payload.members
      .map((member) => member.actorId)
      .filter((value): value is string => Boolean(value))
  )
  const removedUserIds = new Set(
    payload.members
      .map((member) => member.userId)
      .filter((value): value is string => Boolean(value))
  )

  return {
    ...conversation,
    participants: conversation.participants.filter(
      (participant) => !removedActorIds.has(participant.id)
    ),
    members: conversation.members.filter((member) =>
      member.type === "actor"
        ? !removedActorIds.has(member.id)
        : !removedUserIds.has(member.id)
    ),
  }
}

function applyActorPatch(
  conversation: ConversationSummary,
  actorId: string,
  patch: Partial<ConversationMember & ConversationParticipant>
) {
  return {
    ...conversation,
    participants: conversation.participants.map((participant) =>
      participant.id === actorId ? { ...participant, ...patch } : participant
    ),
    members: conversation.members.map((member) =>
      member.type === "actor" && member.id === actorId
        ? { ...member, ...patch }
        : member
    ),
  }
}

function applyFeedMessageToConversation(
  conversation: ConversationSummary,
  item: FeedMessage,
  isSelected: boolean
) {
  let nextConversation: ConversationSummary = {
    ...conversation,
    lastMessage: {
      content: previewTextForItem(item),
      role: item.role,
      actorName: item.actorName,
      createdAt: item.createdAt,
    },
    unreadCount: isSelected
      ? conversation.unreadCount
      : conversation.unreadCount + 1,
  }

  if (item.kind !== "event" || !item.eventType || !item.eventPayload) {
    return nextConversation
  }

  switch (item.eventType) {
    case "member_joined":
      nextConversation = applyMemberJoined(
        nextConversation,
        item.eventPayload as ConversationFeedEventPayloadMap["member_joined"]
      )
      break
    case "member_kicked":
    case "member_left":
      nextConversation = applyMemberRemoved(
        nextConversation,
        item.eventPayload as
          | ConversationFeedEventPayloadMap["member_kicked"]
          | ConversationFeedEventPayloadMap["member_left"]
      )
      break
    case "actor_renamed": {
      const payload =
        item.eventPayload as ConversationFeedEventPayloadMap["actor_renamed"]
      if (payload.actor.actorId) {
        nextConversation = applyActorPatch(
          nextConversation,
          payload.actor.actorId,
          {
          name: payload.newName,
          }
        )
      }
      break
    }
    case "actor_avatar_changed": {
      const payload =
        item.eventPayload as ConversationFeedEventPayloadMap["actor_avatar_changed"]
      if (payload.actor.actorId) {
        nextConversation = applyActorPatch(
          nextConversation,
          payload.actor.actorId,
          {
            avatarUrl: payload.newAvatarUrl,
            emoji: payload.newAvatarEmoji,
          }
        )
      }
      break
    }
    case "actor_version_changed": {
      const payload =
        item.eventPayload as ConversationFeedEventPayloadMap["actor_version_changed"]
      if (payload.actor.actorId) {
        nextConversation = applyActorPatch(
          nextConversation,
          payload.actor.actorId,
          {
            name: payload.actor.name,
            avatarUrl: payload.actor.avatarUrl,
            emoji: payload.actor.avatarEmoji,
          }
        )
      }
      break
    }
    default:
      break
  }

  return nextConversation
}

export function runtimePhaseToBadgePhase(
  runtime?: ActorRuntimeState
): ThinkingPhase | undefined {
  if (!runtime) return undefined
  if (runtime.health === "error" || runtime.phase === "error") return "error"
  if (runtime.phase === "tool") return "tool"
  if (runtime.phase === "responding") return "responding"
  if (
    runtime.phase === "thinking" ||
    runtime.laneState === "running" ||
    runtime.laneState === "queued"
  ) {
    return "thinking"
  }
  return undefined
}

export function runtimeToAvatarStatus(
  runtime?: ActorRuntimeState
): ActorAvatarStatus | undefined {
  if (!runtime) return undefined
  return runtimePhaseToBadgePhase(runtime) || "idle"
}

function applyRuntimeToConversationMembers(
  conversation: ConversationSummary,
  runtime: ActorRuntimeState
): ConversationSummary {
  return {
    ...conversation,
    members: conversation.members.map((member) =>
      member.type === "actor" && member.id === runtime.actorId
        ? { ...member, sessionStatus: runtime.laneState }
        : member
    ),
  }
}

function deriveConversationStatus(
  conversation: ConversationSummary,
  runtimesForConversation?: Record<string, ActorRuntimeState>
) {
  const actorMembers = conversation.members.filter(
    (member) => member.type === "actor"
  )
  if (actorMembers.length === 0) return "completed" as const
  const hasOpenLane = actorMembers.some((member) => {
    const runtime = runtimesForConversation?.[member.id]
    const laneState = runtime?.laneState || member.sessionStatus
    return laneState !== "closed"
  })
  return hasOpenLane ? ("active" as const) : ("completed" as const)
}

function applyRuntimeMapToConversation(
  conversation: ConversationSummary,
  runtimesForConversation?: Record<string, ActorRuntimeState>
): ConversationSummary {
  if (!runtimesForConversation) {
    return {
      ...conversation,
      status: deriveConversationStatus(conversation, undefined),
    }
  }

  let nextConversation = conversation
  for (const runtime of Object.values(runtimesForConversation)) {
    nextConversation = applyRuntimeToConversationMembers(
      nextConversation,
      runtime
    )
  }

  return {
    ...nextConversation,
    status: deriveConversationStatus(
      nextConversation,
      runtimesForConversation
    ),
  }
}

function applyFeedItemToRuntimeMap(
  runtimeByActor: Record<string, ActorRuntimeState>,
  item: FeedMessage
) {
  let nextRuntimeByActor = runtimeByActor

  if (
    item.kind === "message" &&
    item.fromActorId &&
    runtimeByActor[item.fromActorId]
  ) {
    nextRuntimeByActor = {
      ...runtimeByActor,
      [item.fromActorId]: {
        ...runtimeByActor[item.fromActorId],
        actorName: item.actorName || runtimeByActor[item.fromActorId].actorName,
        updatedAt: item.createdAt,
      },
    }
  }

  if (item.kind !== "event" || !item.eventType || !item.eventPayload) {
    return nextRuntimeByActor
  }

  switch (item.eventType) {
    case "member_kicked":
    case "member_left": {
      const payload = item.eventPayload as
        | ConversationFeedEventPayloadMap["member_kicked"]
        | ConversationFeedEventPayloadMap["member_left"]
      const removedActorIds = payload.members
        .map((member) => member.actorId)
        .filter((value): value is string => Boolean(value))
      if (removedActorIds.length === 0) return nextRuntimeByActor
      const next = { ...nextRuntimeByActor }
      for (const actorId of removedActorIds) {
        delete next[actorId]
      }
      return next
    }
    case "actor_renamed": {
      const payload =
        item.eventPayload as ConversationFeedEventPayloadMap["actor_renamed"]
      const actorId = payload.actor.actorId
      if (!actorId || !nextRuntimeByActor[actorId]) return nextRuntimeByActor
      return {
        ...nextRuntimeByActor,
        [actorId]: {
          ...nextRuntimeByActor[actorId],
          actorName: payload.newName,
          updatedAt: item.createdAt,
        },
      }
    }
    case "actor_version_changed": {
      const payload =
        item.eventPayload as ConversationFeedEventPayloadMap["actor_version_changed"]
      const actorId = payload.actor.actorId
      if (!actorId || !nextRuntimeByActor[actorId]) return nextRuntimeByActor
      return {
        ...nextRuntimeByActor,
        [actorId]: {
          ...nextRuntimeByActor[actorId],
          actorName:
            payload.actor.name || nextRuntimeByActor[actorId].actorName,
          updatedAt: item.createdAt,
        },
      }
    }
    default:
      return nextRuntimeByActor
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  selectedConversationId: null,
  messages: [],
  outbox: {},
  loadingConversations: false,
  loadingMessages: false,
  runtimeMap: {},
  runtimeSeqMap: {},
  totalUnread: 0,

  loadConversations: async (workspaceId, options) => {
    const shouldShowLoading =
      !options?.silent || get().conversations.length === 0
    if (shouldShowLoading) {
      set({ loadingConversations: true })
    }
    try {
      const res = await api.getThreads(workspaceId)
      const incomingConversations = Array.isArray(res?.conversations)
        ? (res.conversations as ConversationSummary[])
        : []
      const serverRuntime = (res?.runtimeMap || {}) as ConversationRuntimeMap

      set((state) => {
        const runtimeMap = { ...state.runtimeMap, ...serverRuntime }
        const conversations = applyOutboxToConversations(
          sortConversations(
            incomingConversations.map((conversation) =>
              applyRuntimeMapToConversation(
                conversation,
                runtimeMap[conversation.id]
              )
            )
          ),
          state.outbox,
          runtimeMap
        )
        const currentSelection = state.selectedConversationId
        const nextSelectedConversationId =
          currentSelection &&
          conversations.some(
            (conversation) => conversation.id === currentSelection
          )
            ? currentSelection
            : null

        return {
          conversations,
          runtimeMap,
          totalUnread: sumConversationUnread(conversations),
          loadingConversations: false,
          ...(nextSelectedConversationId === currentSelection
            ? {}
            : {
                selectedConversationId: nextSelectedConversationId,
                messages: [],
              }),
        }
      })
    } catch (err) {
      console.error("Failed to load conversations:", err)
      set({ loadingConversations: false })
    }
  },

  selectConversation: (conversationId) => {
    const currentSelection = get().selectedConversationId
    if (currentSelection === conversationId) return
    set({
      selectedConversationId: conversationId,
      messages: [],
    })
  },

  loadMessages: async (workspaceId, conversationId) => {
    set({ loadingMessages: true })
    try {
      const res = await api.getThreadMessages(conversationId, 100)
      const fetchedMessages = sortMessages(
        (res?.items || []).map(feedItemToMessage)
      )

      set((state) => {
        const currentSelection = state.selectedConversationId
        if (currentSelection !== conversationId) {
          return { loadingMessages: false }
        }

        return {
          messages: mergeConversationMessagesWithOutbox(
            fetchedMessages,
            state.outbox,
            conversationId
          ),
          loadingMessages: false,
        }
      })
    } catch (err) {
      console.error("Failed to load messages:", err)
      set({ loadingMessages: false })
    }
  },

  sendMessage: async (
    workspaceId,
    conversationId,
    contentBlocks,
    targetParticipantIds,
    targetActorIds
  ) => {
    const clientMessageId = createClientMessageId()
    const createdAt = new Date().toISOString()
    const optimisticSequence = createOptimisticSequence(get().messages)
    const entry: OutboxEntry = {
      clientMessageId,
      workspaceId,
      conversationId,
      contentBlocks,
      targetParticipantIds: targetParticipantIds || [],
      targetActorIds: targetActorIds || [],
      createdAt,
      optimisticSequence,
      status: "sending",
      attemptCount: 0,
    }
    const optimisticMessage = outboxEntryToMessage(entry)

    set((state) => {
      const outbox = {
        ...state.outbox,
        [clientMessageId]: entry,
      }
      const conversations = sortConversations(
        state.conversations.map((conversation) =>
          conversation.id === conversationId
            ? applyRuntimeMapToConversation(
                applyFeedMessageToConversation(
                  conversation,
                  optimisticMessage,
                  true
                ),
                state.runtimeMap[conversationId]
              )
            : conversation
        )
      )

      persistOutbox(outbox)
      const currentSelection = state.selectedConversationId

      return {
        outbox,
        messages:
          currentSelection === conversationId
            ? upsertFeedMessage(state.messages, optimisticMessage)
            : state.messages,
        conversations,
        totalUnread: sumConversationUnread(conversations),
      }
    })

    scheduleOutboxSend(clientMessageId, 0)
  },

  hydrateOutbox: (workspaceId) => {
    const storedOutbox = loadStoredOutbox()
    set((state) => {
      const conversations = applyOutboxToConversations(
        state.conversations,
        storedOutbox,
        state.runtimeMap
      )
      const currentSelection = state.selectedConversationId
      return {
        outbox: storedOutbox,
        conversations,
        messages: currentSelection
          ? mergeConversationMessagesWithOutbox(
              state.messages,
              storedOutbox,
              currentSelection
            )
          : state.messages,
        totalUnread: sumConversationUnread(conversations),
      }
    })
    get().flushOutbox(workspaceId)
  },

  flushOutbox: (workspaceId) => {
    for (const entry of Object.values(get().outbox)) {
      if (entry.workspaceId !== workspaceId) continue
      scheduleOutboxSend(entry.clientMessageId, 0)
    }
  },

  createWorkspaceThread: async (
    workspaceId,
    kind,
    actorIds,
    content,
    targetActorIdOrIds,
    contentBlocks,
    title
  ) => {
    const targetActorIds = Array.isArray(targetActorIdOrIds)
      ? targetActorIdOrIds.filter(Boolean)
      : typeof targetActorIdOrIds === "string" && targetActorIdOrIds
        ? [targetActorIdOrIds]
        : []
    const res = await api.createThread({
      domain: "workspace",
      kind,
      workspaceId,
      actorIds,
      ...(title ? { title } : {}),
      ...(content ? { content } : {}),
      ...(contentBlocks && contentBlocks.length > 0 ? { contentBlocks } : {}),
      ...(targetActorIds.length > 0 ? { targetActorIds } : {}),
    })
    const conversationId = res.conversationId
    await get().loadConversations(workspaceId)
    return conversationId
  },

  markConversationRead: async (conversationId, readUpToSequence) => {
    set((state) => {
      const conversations = state.conversations.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, unreadCount: 0 }
          : conversation
      )
      return {
        conversations,
        totalUnread: sumConversationUnread(conversations),
      }
    })

    try {
      await api.markThreadRead(conversationId, readUpToSequence)
      clearPendingConversationRead(conversationId, readUpToSequence)
    } catch (err) {
      queuePendingConversationRead(conversationId, readUpToSequence)
      console.error("Failed to mark read:", err)
    }
  },

  handleConversationItemCreated: (item) => {
    const message = feedItemToMessage(item)

    set((state) => {
      const nextOutbox = { ...state.outbox }
      if (message.clientMessageId && nextOutbox[message.clientMessageId]) {
        delete nextOutbox[message.clientMessageId]
        const timer = retryTimers.get(message.clientMessageId)
        if (timer) {
          clearTimeout(timer)
          retryTimers.delete(message.clientMessageId)
        }
      }

      const currentSelection = state.selectedConversationId
      const isSelected = currentSelection === message.conversationId
      const currentRuntime = state.runtimeMap[message.conversationId] || {}
      const nextRuntime = applyFeedItemToRuntimeMap(currentRuntime, message)
      const runtimeMap =
        nextRuntime === currentRuntime
          ? state.runtimeMap
          : { ...state.runtimeMap, [message.conversationId]: nextRuntime }
      const conversations = applyOutboxToConversations(
        sortConversations(
          state.conversations.map((conversation) =>
            conversation.id === message.conversationId
              ? applyRuntimeMapToConversation(
                  applyFeedMessageToConversation(
                    conversation,
                    message,
                    isSelected
                  ),
                  runtimeMap[message.conversationId]
                )
              : conversation
          )
        ),
        nextOutbox,
        runtimeMap
      )

      persistOutbox(nextOutbox)

      return {
        messages: isSelected
          ? mergeConversationMessagesWithOutbox(
              upsertFeedMessage(state.messages, message),
              nextOutbox,
              message.conversationId
            )
          : state.messages,
        outbox: nextOutbox,
        conversations,
        runtimeMap,
        totalUnread: sumConversationUnread(conversations),
      }
    })
  },

  handleRuntimeUpdated: (payload) => {
    set((state) => {
      const currentSeq = state.runtimeSeqMap[payload.conversationId] || 0
      if (payload.runtimeSeq <= currentSeq) {
        return state
      }

      const nextRuntimeForConversation = {
        ...(state.runtimeMap[payload.conversationId] || {}),
        [payload.snapshot.actorId]: payload.snapshot,
      }
      const runtimeMap = {
        ...state.runtimeMap,
        [payload.conversationId]: nextRuntimeForConversation,
      }
      const conversations = state.conversations.map((conversation) =>
        conversation.id === payload.conversationId
          ? applyRuntimeMapToConversation(
              conversation,
              nextRuntimeForConversation
            )
          : conversation
      )

      return {
        conversations,
        runtimeMap,
        runtimeSeqMap: {
          ...state.runtimeSeqMap,
          [payload.conversationId]: payload.runtimeSeq,
        },
      }
    })
  },

  handleConversationUpdated: (payload) => {
    set((state) => {
      const hasConversation = state.conversations.some(
        (conversation) => conversation.id === payload.conversationId
      )
      if (!hasConversation) return state

      const conversations = sortConversations(
        state.conversations.map((conversation) => {
          if (conversation.id !== payload.conversationId) return conversation

          let nextConversation = conversation
          if (payload.action === "profile_updated") {
            const nextTitle =
              payload.title?.trim() ||
              conversation.title ||
              conversation.name
            nextConversation = {
              ...nextConversation,
              title: nextTitle,
              name: nextTitle,
              avatarUrl:
                payload.avatarUrl === undefined
                  ? conversation.avatarUrl
                  : payload.avatarUrl || undefined,
            }
          }

          if (payload.action === "cancelled") {
            nextConversation = {
              ...nextConversation,
              status: "completed",
            }
          }

          return applyRuntimeMapToConversation(
            nextConversation,
            state.runtimeMap[payload.conversationId]
          )
        })
      )

      return { conversations }
    })
  },

  handleInteractionUpdated: (payload) => {
    set((state) => {
      const currentSelection = state.selectedConversationId
      if (currentSelection !== payload.conversationId) {
        return state
      }

      const messages = state.messages.map((message) => {
        const currentInteractionId =
          message.interaction?.id ||
          (message.eventType === "interaction_requested" &&
          message.eventPayload &&
          typeof message.eventPayload === "object" &&
          "interaction" in message.eventPayload
            ? (message.eventPayload.interaction as InteractionRequestSummary).id
            : undefined)

        if (
          message.id !== payload.itemId &&
          currentInteractionId !== payload.interactionId
        ) {
          return message
        }

        const nextPayload = {
          interaction: payload.interaction,
        } as ConversationFeedEventPayloadMap["interaction_requested"]
        const content = summarizeConversationEvent(
          "interaction_requested",
          nextPayload
        )

        return {
          ...message,
          content,
          contentBlocks: textBlocks(content),
          eventType: "interaction_requested" as const,
          eventPayload: nextPayload,
          interaction: payload.interaction,
        }
      })

      return { messages }
    })
  },
}))

function scheduleOutboxSend(clientMessageId: string, delayMs: number) {
  const existingTimer = retryTimers.get(clientMessageId)
  if (existingTimer) {
    clearTimeout(existingTimer)
  }

  const timer = setTimeout(
    () => {
      retryTimers.delete(clientMessageId)
      void processOutboxEntry(clientMessageId)
    },
    Math.max(0, delayMs)
  )

  retryTimers.set(clientMessageId, timer)
}

async function processOutboxEntry(clientMessageId: string) {
  const state = useChatStore.getState()
  const entry = state.outbox[clientMessageId]
  if (!entry) {
    return
  }

  const lastAttemptAt = new Date().toISOString()
  useChatStore.setState((currentState) => {
    const currentEntry = currentState.outbox[clientMessageId]
    if (!currentEntry) return currentState

    const nextOutbox = {
      ...currentState.outbox,
      [clientMessageId]: {
        ...currentEntry,
        attemptCount: currentEntry.attemptCount + 1,
        lastAttemptAt,
      },
    }
    persistOutbox(nextOutbox)
    return {
      outbox: nextOutbox,
      messages:
        currentState.selectedConversationId === currentEntry.conversationId
          ? mergeConversationMessagesWithOutbox(
              currentState.messages,
              nextOutbox,
              currentEntry.conversationId
            )
          : currentState.messages,
    }
  })

  try {
    const result = await api.sendThreadMessage(
      entry.conversationId,
      entry.contentBlocks,
      entry.clientMessageId,
      entry.targetParticipantIds,
      entry.targetActorIds
    )

    if (result?.item) {
      useChatStore.getState().handleConversationItemCreated(result.item)
      return
    }

    throw new Error("Message send did not return an item")
  } catch (error) {
    const failedAt = new Date().toISOString()
    let retryDelay = 30000

    useChatStore.setState((currentState) => {
      const currentEntry = currentState.outbox[clientMessageId]
      if (!currentEntry) return currentState

      retryDelay = getOutboxRetryDelay(currentEntry.attemptCount)
      const nextEntry: OutboxEntry = {
        ...currentEntry,
        status: "retrying",
        firstFailedAt: currentEntry.firstFailedAt || failedAt,
        lastErrorMessage:
          error instanceof Error ? error.message : "Failed to send message",
      }
      const nextOutbox = {
        ...currentState.outbox,
        [clientMessageId]: nextEntry,
      }
      persistOutbox(nextOutbox)

      return {
        outbox: nextOutbox,
        messages:
          currentState.selectedConversationId === nextEntry.conversationId
            ? mergeConversationMessagesWithOutbox(
                currentState.messages,
                nextOutbox,
                nextEntry.conversationId
              )
            : currentState.messages,
      }
    })

    scheduleOutboxSend(clientMessageId, retryDelay)
  }
}
