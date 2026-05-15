"use client"

import { create } from "zustand"
import { api } from "@/lib/api"
import {
  createEmptyStoredChatQueueState,
  loadStoredChatQueueState,
  updateStoredChatQueueState,
  type PendingOutboxMessage as PersistedOutboxEntry,
  type PendingConversationRead,
  type StoredChatQueueState,
} from "@/lib/chat-persistence"
import { createUuid } from "@/lib/uuid"
import type {
  ActorRuntimeState,
  CanonicalContentBlock,
  ChatConversationItem,
  ChatConversationReadWatermarkResponse,
  ChatConversationView,
  ChatSyncEvent,
  ConversationEntityRef,
  ConversationFeedEventPayloadMap,
  ConversationFeedEventType,
  ConversationMessageTransportContext,
  ConversationMessageTransportDelivery,
  ConversationReplyRef,
  InteractionRequestSummary,
  RemoteAgentRuntimeState,
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
  participantId: string
  participantType: "actor" | "remote_agent" | "workspace_member" | "external"
  id: string
  workspaceMemberId?: string
  remoteAgentId?: string
  name: string
  role?: string
  title?: string
  emoji?: string
  avatarUrl?: string
  sessionStatus?: string
  externalUserKey?: string
  transportKind?: TransportKind
  transportAddressId?: string
  linkedWorkspaceMemberId?: string
  linkedWorkspaceMemberName?: string
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
  fromWorkspaceMemberId?: string
  actorName?: string
  actorRole?: string
  actorEmoji?: string
  createdAt: string
  clientMessageId?: string
  deliveryStatus?: "sending" | "retrying" | "sent"
  metadata?: Record<string, unknown>
  replyToItemId?: string
  replyTo?: ConversationReplyRef
  toolsUsed?: string[]
  serverToolCalls?: ServerToolCall[]
  citationSources?: Record<string, { url: string; title: string }>
  coordination?: boolean
  restrictedAudienceParticipantIds?: string[]
  transport?: ConversationMessageTransportContext
  transportDeliveries?: ConversationMessageTransportDelivery[]
  eventType?: ConversationFeedEventType
  eventPayload?: ConversationFeedEventPayloadMap[ConversationFeedEventType]
  interaction?: InteractionRequestSummary
}

export type ThinkingPhase = "thinking" | "tool" | "responding" | "error"
export type ActorAvatarStatus = "idle" | ThinkingPhase
export type RemoteAgentAvatarStatus = RemoteAgentRuntimeState["state"]
export type ConversationRuntimeMap = Record<
  string,
  Record<string, ActorRuntimeState>
>

export type OutboxEntry = PersistedOutboxEntry
export interface ChatWorkspaceSnapshot extends StoredChatQueueState {
  conversations: ChatConversationView[]
}

interface ChatState {
  activeWorkspaceId: string | null
  workspaceMemberId: string | null
  clientInstanceId: string | null
  selectedConversationId: string | null
  visibleConversationId: string | null
  conversations: ConversationSummary[]
  messages: FeedMessage[]
  outbox: Record<string, OutboxEntry>
  pendingReads: Record<string, PendingConversationRead>
  loadingConversations: boolean
  loadingMessages: boolean
  syncing: boolean
  runtimeMap: ConversationRuntimeMap
  remoteAgentRuntimeMap: Record<string, RemoteAgentRuntimeState>
  runtimeSeqMap: Record<string, number>
  totalUnread: number

  snapshot: ChatWorkspaceSnapshot | null
  loadedMessageItems: ChatConversationItem[]

  deactivate: () => void
  loadConversations: (
    workspaceId: string,
    options?: { silent?: boolean }
  ) => Promise<void>
  reloadPersistedSnapshot: (workspaceId: string) => Promise<void>
  selectConversation: (conversationId: string | null) => void
  setVisibleConversation: (conversationId: string | null) => void
  loadMessages: (workspaceId: string, conversationId: string) => Promise<void>
  sendMessage: (
    workspaceId: string,
    conversationId: string,
    input: {
      contentBlocks: CanonicalContentBlock[]
      replyToItemId?: string
      replyTo?: ConversationReplyRef
    }
  ) => Promise<void>
  hydrateOutbox: (workspaceId: string) => Promise<void>
  flushOutbox: (workspaceId?: string) => Promise<void>
  syncFromServer: (workspaceId?: string) => Promise<void>
  createWorkspaceThread: (
    workspaceId: string,
    kind: "private" | "group",
    actorIds: string[],
    content?: string,
    contentBlocks?: CanonicalContentBlock[],
    title?: string
  ) => Promise<string>
  markConversationRead: (
    conversationId: string,
    readUpToSequence: number,
    lastVisibleSequence?: number
  ) => Promise<void>

  handleSyncEvent: (event: ChatSyncEvent) => void
  handleRuntimeUpdated: (payload: {
    conversationId: string
    runtimeSeq: number
    snapshot: ActorRuntimeState
  }) => void
  handleInteractionUpdated: (payload: {
    conversationId: string
    interactionId: string
    itemId?: string
    interaction: InteractionRequestSummary
  }) => void
}

const OUTBOX_RETRY_DELAYS_MS = [1500, 3000, 5000, 8000, 12000, 20000, 30000]

let persistPromise: Promise<void> = Promise.resolve()
let bootstrapPromise: Promise<void> | null = null
let bootstrapWorkspaceId: string | null = null
let syncPromise: Promise<void> | null = null
let outboxRetryTimer: ReturnType<typeof setTimeout> | null = null

function createEmptyWorkspaceSnapshot(
  workspaceId: string
): ChatWorkspaceSnapshot {
  return {
    ...createEmptyStoredChatQueueState(workspaceId),
    conversations: [],
  }
}

function toStoredChatQueueState(
  snapshot: Pick<
    ChatWorkspaceSnapshot,
    | "workspaceId"
    | "workspaceMemberId"
    | "clientInstanceId"
    | "inboxCursor"
    | "lastBootstrappedAt"
    | "pendingReads"
    | "outbox"
  > | null
): StoredChatQueueState | null {
  if (!snapshot) {
    return null
  }

  return {
    version: 3,
    workspaceId: snapshot.workspaceId,
    workspaceMemberId: snapshot.workspaceMemberId,
    clientInstanceId: snapshot.clientInstanceId,
    inboxCursor: snapshot.inboxCursor,
    lastBootstrappedAt: snapshot.lastBootstrappedAt,
    pendingReads: snapshot.pendingReads,
    outbox: snapshot.outbox,
  }
}

function mergeStoredQueueIntoSnapshot(
  snapshot: ChatWorkspaceSnapshot | null,
  queueState: StoredChatQueueState
): ChatWorkspaceSnapshot {
  const baseSnapshot =
    snapshot && snapshot.workspaceId === queueState.workspaceId
      ? snapshot
      : createEmptyWorkspaceSnapshot(queueState.workspaceId)

  return {
    ...baseSnapshot,
    version: queueState.version,
    workspaceId: queueState.workspaceId,
    workspaceMemberId:
      queueState.workspaceMemberId ?? baseSnapshot.workspaceMemberId,
    clientInstanceId:
      queueState.clientInstanceId ?? baseSnapshot.clientInstanceId,
    inboxCursor: Math.max(baseSnapshot.inboxCursor, queueState.inboxCursor),
    lastBootstrappedAt: latestIsoTimestamp(
      baseSnapshot.lastBootstrappedAt,
      queueState.lastBootstrappedAt
    ),
    pendingReads: queueState.pendingReads,
    outbox: queueState.outbox,
    conversations: baseSnapshot.conversations,
  }
}

function latestIsoTimestamp(
  currentValue?: string,
  nextValue?: string
): string | undefined {
  if (!currentValue) {
    return nextValue
  }
  if (!nextValue) {
    return currentValue
  }
  return new Date(currentValue).getTime() >= new Date(nextValue).getTime()
    ? currentValue
    : nextValue
}

function sameStoredEntry(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function mergeStoredQueueTransition(
  currentState: StoredChatQueueState,
  previousState: StoredChatQueueState | null,
  nextState: StoredChatQueueState
) {
  const nextWorkspaceState =
    currentState.workspaceMemberId &&
    nextState.workspaceMemberId &&
    currentState.workspaceMemberId !== nextState.workspaceMemberId
      ? createEmptyStoredChatQueueState(nextState.workspaceId)
      : currentState.workspaceId === nextState.workspaceId
        ? currentState
        : createEmptyStoredChatQueueState(nextState.workspaceId)

  const previousOutbox = previousState?.outbox ?? {}
  const previousPendingReads = previousState?.pendingReads ?? {}
  const nextOutbox = { ...nextWorkspaceState.outbox }
  const nextPendingReads = { ...nextWorkspaceState.pendingReads }

  for (const clientMessageId of Object.keys(previousOutbox)) {
    if (!(clientMessageId in nextState.outbox)) {
      delete nextOutbox[clientMessageId]
    }
  }
  for (const [clientMessageId, entry] of Object.entries(nextState.outbox)) {
    if (!sameStoredEntry(previousOutbox[clientMessageId], entry)) {
      nextOutbox[clientMessageId] = entry
    }
  }

  for (const conversationId of Object.keys(previousPendingReads)) {
    if (!(conversationId in nextState.pendingReads)) {
      const currentEntry = nextPendingReads[conversationId]
      const previousEntry = previousPendingReads[conversationId]
      if (
        currentEntry &&
        previousEntry &&
        currentEntry.readUpToSequence > previousEntry.readUpToSequence
      ) {
        continue
      }
      delete nextPendingReads[conversationId]
    }
  }
  for (const [conversationId, entry] of Object.entries(
    nextState.pendingReads
  )) {
    if (!sameStoredEntry(previousPendingReads[conversationId], entry)) {
      nextPendingReads[conversationId] = entry
    }
  }

  return {
    ...nextWorkspaceState,
    workspaceId: nextState.workspaceId,
    workspaceMemberId:
      nextState.workspaceMemberId ?? nextWorkspaceState.workspaceMemberId,
    clientInstanceId:
      nextState.clientInstanceId ?? nextWorkspaceState.clientInstanceId,
    inboxCursor: Math.max(
      nextWorkspaceState.inboxCursor,
      nextState.inboxCursor
    ),
    lastBootstrappedAt: latestIsoTimestamp(
      nextWorkspaceState.lastBootstrappedAt,
      nextState.lastBootstrappedAt
    ),
    pendingReads: nextPendingReads,
    outbox: nextOutbox,
  }
}

function queuePersistSnapshot(
  previousSnapshot: ChatWorkspaceSnapshot | null,
  nextSnapshot: ChatWorkspaceSnapshot | null
) {
  if (!nextSnapshot || typeof window === "undefined") {
    return Promise.resolve()
  }

  const previousQueueState = toStoredChatQueueState(previousSnapshot)
  const nextQueueState = toStoredChatQueueState(nextSnapshot)
  if (!nextQueueState) {
    return Promise.resolve()
  }

  persistPromise = persistPromise
    .then(() =>
      updateStoredChatQueueState(nextQueueState.workspaceId, (currentState) =>
        mergeStoredQueueTransition(
          currentState,
          previousQueueState,
          nextQueueState
        )
      )
    )
    .catch(() => undefined)

  return persistPromise
}

function clearOutboxRetryTimer() {
  if (outboxRetryTimer) {
    clearTimeout(outboxRetryTimer)
    outboxRetryTimer = null
  }
}

function scheduleOutboxRetry(attemptCount: number) {
  clearOutboxRetryTimer()

  const index = Math.max(
    0,
    Math.min(attemptCount, OUTBOX_RETRY_DELAYS_MS.length - 1)
  )
  const baseDelay = OUTBOX_RETRY_DELAYS_MS[index] || 30000
  const delay = baseDelay + Math.round(Math.random() * 600)

  outboxRetryTimer = setTimeout(() => {
    outboxRetryTimer = null
    void useChatStore.getState().flushOutbox()
  }, delay)
}

function buildDesktopDeviceLabel() {
  if (typeof navigator === "undefined") {
    return "Web Desktop"
  }

  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ||
    navigator.platform ||
    "Desktop"

  return `Web Desktop (${platform})`
}

function normalizeContentBlocks(blocks: unknown): CanonicalContentBlock[] {
  if (!Array.isArray(blocks)) {
    return []
  }
  return normalizeCanonicalContentBlocks(blocks)
}

function sortRawConversations(conversations: ChatConversationView[]) {
  return [...conversations].sort((left, right) => {
    const leftPinned = left.pinnedSortKey
      ? new Date(left.pinnedSortKey).getTime()
      : 0
    const rightPinned = right.pinnedSortKey
      ? new Date(right.pinnedSortKey).getTime()
      : 0

    if (leftPinned !== rightPinned) {
      return rightPinned - leftPinned
    }

    const leftAt = left.lastItem?.createdAt ?? left.updatedAt ?? left.createdAt
    const rightAt =
      right.lastItem?.createdAt ?? right.updatedAt ?? right.createdAt

    return new Date(rightAt).getTime() - new Date(leftAt).getTime()
  })
}

function upsertRawConversation(
  conversations: ChatConversationView[],
  incoming: ChatConversationView
) {
  const next = conversations.filter(
    (conversation) => conversation.conversationId !== incoming.conversationId
  )
  next.push(incoming)
  return sortRawConversations(next)
}

function mergeRawItems(
  existing: ChatConversationItem[],
  incoming: ChatConversationItem[]
) {
  const byId = new Map<string, ChatConversationItem>()

  for (const item of existing) {
    byId.set(item.id, item)
  }
  for (const item of incoming) {
    byId.set(item.id, item)
  }

  return [...byId.values()].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence
    }
    return (
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    )
  })
}

function patchInteractionInRawItem(
  item: ChatConversationItem,
  payload: ChatSyncEvent<"interaction.updated">["payload"]
) {
  if (
    item.itemType !== "event" ||
    item.subtype !== "interaction_requested" ||
    !item.eventPayload ||
    typeof item.eventPayload !== "object"
  ) {
    return item
  }

  const currentInteraction =
    "interaction" in item.eventPayload
      ? (item.eventPayload.interaction as InteractionRequestSummary | undefined)
      : undefined

  if (
    item.id !== payload.itemId &&
    currentInteraction?.id !== payload.interactionId
  ) {
    return item
  }

  return {
    ...item,
    eventPayload: {
      ...(item.eventPayload as ConversationFeedEventPayloadMap["interaction_requested"]),
      interaction: payload.interaction,
    },
  }
}

function patchInteractionInRawItems(
  items: ChatConversationItem[],
  payload: ChatSyncEvent<"interaction.updated">["payload"]
) {
  return mergeRawItems(
    [],
    items.map((item) => patchInteractionInRawItem(item, payload))
  )
}

function applyInteractionUpdatedToSnapshot(
  snapshot: ChatWorkspaceSnapshot,
  payload: ChatSyncEvent<"interaction.updated">["payload"]
) {
  const currentConversation = snapshot.conversations.find(
    (conversation) => conversation.conversationId === payload.conversationId
  )
  if (!currentConversation) {
    return snapshot
  }

  const nextLastItem =
    payload.itemId && currentConversation.lastItem?.itemId === payload.itemId
      ? {
          ...currentConversation.lastItem,
          previewText: summarizeConversationEvent("interaction_requested", {
            interaction: payload.interaction,
          }),
        }
      : currentConversation.lastItem

  return {
    ...snapshot,
    conversations: upsertRawConversation(snapshot.conversations, {
      ...currentConversation,
      lastItem: nextLastItem,
    }),
  }
}

function sortMessages(messages: FeedMessage[]) {
  return [...messages].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence
    }
    return (
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    )
  })
}

function sumConversationUnread(conversations: ConversationSummary[]) {
  return conversations.reduce(
    (sum, conversation) => sum + conversation.unreadCount,
    0
  )
}

function getViewerParticipant(
  conversation: ChatConversationView | undefined,
  workspaceMemberId?: string | null
) {
  if (!conversation || !workspaceMemberId) {
    return undefined
  }

  return conversation.participants.find(
    (participant) =>
      participant.participantType === "workspace_member" &&
      participant.workspaceMemberId === workspaceMemberId
  )
}

function getPeerParticipant(
  conversation: ChatConversationView,
  workspaceMemberId?: string | null
) {
  return (
    conversation.participants.find(
      (participant) =>
        participant.state === "active" &&
        !(
          participant.participantType === "workspace_member" &&
          participant.workspaceMemberId === workspaceMemberId
        )
    ) ?? conversation.participants[0]
  )
}

function getConversationDisplayName(
  conversation: ChatConversationView,
  workspaceMemberId?: string | null
) {
  if (conversation.kind === "private") {
    const peer = getPeerParticipant(conversation, workspaceMemberId)
    return peer?.name?.trim() || conversation.title?.trim() || "Direct chat"
  }

  return conversation.title?.trim() || "Group chat"
}

function resolveConversationAvatarUrl(
  conversation: ChatConversationView,
  workspaceMemberId?: string | null
) {
  if (conversation.presentation?.avatarUrl) {
    return conversation.presentation.avatarUrl
  }

  const peer = getPeerParticipant(conversation, workspaceMemberId)
  return peer?.avatarUrl
}

function resolveConversationTransportKind(conversation: ChatConversationView) {
  return conversation.participants.find(
    (participant) => participant.transportKind
  )?.transportKind
}

function toConversationMember(
  participant: ChatConversationView["participants"][number]
): ConversationMember {
  if (participant.participantType === "system") {
    throw new Error(
      "system participants should not be mapped into conversation members"
    )
  }
  const id =
    participant.actorId ||
    participant.remoteAgentId ||
    participant.workspaceMemberId ||
    participant.externalUserKey ||
    participant.participantId

  return {
    participantId: participant.participantId,
    participantType: participant.participantType,
    id,
    workspaceMemberId: participant.workspaceMemberId,
    remoteAgentId: participant.remoteAgentId,
    name: participant.name || "Unknown",
    role: participant.role || participant.roleKey,
    title: participant.title,
    emoji: participant.avatarEmoji,
    avatarUrl: participant.avatarUrl,
    sessionStatus: participant.sessionStatus,
    externalUserKey: participant.externalUserKey,
    transportKind: participant.transportKind,
    transportAddressId: participant.transportAddressId,
  }
}

function toConversationParticipant(
  participant: ChatConversationView["participants"][number]
): ConversationParticipant {
  return {
    id:
      participant.actorId ||
      participant.workspaceMemberId ||
      participant.externalUserKey ||
      participant.participantId,
    name: participant.name || "Unknown",
    role:
      participant.role || participant.roleKey || participant.participantType,
    emoji: participant.avatarEmoji,
    avatarUrl: participant.avatarUrl,
    title: participant.title,
  }
}

function deriveLastMessageRole(
  author?: ConversationEntityRef,
  itemType?: "message" | "event" | "summary" | "control"
) {
  if (itemType === "event") {
    return "system"
  }
  if (author?.participantType === "workspace_member") {
    return "user"
  }
  if (author?.participantType === "actor") {
    return "assistant"
  }
  if (author?.participantType === "remote_agent") {
    return "assistant"
  }
  return "system"
}

function getAdjustedUnreadCount(
  conversation: ChatConversationView,
  pendingRead?: PendingConversationRead
) {
  if (!pendingRead) {
    return conversation.unreadCount
  }

  const latestSequence = conversation.lastItem?.sequence ?? 0
  if (pendingRead.readUpToSequence >= latestSequence) {
    return 0
  }

  return conversation.unreadCount
}

function rawConversationToSummary(
  conversation: ChatConversationView,
  snapshot: ChatWorkspaceSnapshot
): ConversationSummary {
  const activeParticipants = conversation.participants.filter(
    (participant) =>
      participant.state === "active" && participant.participantType !== "system"
  )
  const title = getConversationDisplayName(
    conversation,
    snapshot.workspaceMemberId ?? null
  )

  return {
    id: conversation.conversationId,
    status: conversation.status,
    transportKind: resolveConversationTransportKind(conversation),
    participants: activeParticipants.map(toConversationParticipant),
    members: activeParticipants.map(toConversationMember),
    lastMessage: conversation.lastItem
      ? {
          content: conversation.lastItem.previewText,
          role: deriveLastMessageRole(
            conversation.lastItem.author,
            conversation.lastItem.itemType
          ),
          actorName:
            conversation.lastItem.author?.participantType === "actor"
              ? conversation.lastItem.author.name
              : undefined,
          createdAt: conversation.lastItem.createdAt,
        }
      : undefined,
    unreadCount: getAdjustedUnreadCount(
      conversation,
      snapshot.pendingReads[conversation.conversationId]
    ),
    createdAt: conversation.createdAt,
    title,
    name: title,
    avatarUrl: resolveConversationAvatarUrl(
      conversation,
      snapshot.workspaceMemberId ?? null
    ),
    permissions: {
      canManage: conversation.permissions.canManageConversation,
      canManageMembers: conversation.permissions.canManageParticipants,
    },
  }
}

function buildMessagePreview(item: FeedMessage) {
  const text = item.content.trim()
  if (text) {
    return text
  }

  if (item.contentBlocks.some((block) => block.type === "file_ref")) {
    return "Attachment"
  }

  return item.kind === "event" ? "System event" : ""
}

function outboxEntryToMessage(
  entry: OutboxEntry,
  conversation: ChatConversationView | undefined,
  workspaceMemberId?: string | null
): FeedMessage {
  const viewer = getViewerParticipant(conversation, workspaceMemberId)
  const author = viewer
    ? ({
        participantId: viewer.participantId,
        participantType: viewer.participantType,
        workspaceMemberId: viewer.workspaceMemberId,
        actorId: viewer.actorId,
        externalUserKey: viewer.externalUserKey,
        transportAddressId: viewer.transportAddressId,
        transportKind: viewer.transportKind,
        name: viewer.name,
        title: viewer.title,
        role: viewer.role,
        avatarUrl: viewer.avatarUrl,
        avatarEmoji: viewer.avatarEmoji,
      } satisfies ConversationEntityRef)
    : undefined

  return {
    id: `local:${entry.clientMessageId}`,
    kind: "message",
    conversationId: entry.conversationId,
    sequence: entry.optimisticSequence,
    sessionId: "",
    role: "user",
    messageType: "chat.message",
    content: extractText(entry.contentBlocks),
    contentBlocks: entry.contentBlocks,
    author,
    fromWorkspaceMemberId: viewer?.workspaceMemberId,
    createdAt: entry.createdAt,
    clientMessageId: entry.clientMessageId,
    deliveryStatus: entry.status,
    replyToItemId: entry.replyToItemId,
    replyTo: entry.replyTo,
  }
}

function chatItemToFeedMessage(item: ChatConversationItem): FeedMessage {
  if (item.itemType === "event") {
    const content = summarizeConversationEvent(item.subtype, item.eventPayload)
    const interaction =
      item.subtype === "interaction_requested" &&
      item.eventPayload &&
      typeof item.eventPayload === "object" &&
      "interaction" in item.eventPayload
        ? (item.eventPayload.interaction as InteractionRequestSummary)
        : undefined

    return {
      id: item.id,
      kind: "event",
      conversationId: item.conversationId,
      sequence: item.sequence,
      sessionId: item.sessionId || "",
      role: "system",
      messageType: item.subtype,
      content,
      contentBlocks: textBlocks(content),
      author: item.author,
      fromActorId: item.author?.actorId,
      fromWorkspaceMemberId: item.author?.workspaceMemberId,
      actorName:
        item.author?.participantType === "actor" ? item.author.name : undefined,
      actorRole: item.author?.role,
      actorEmoji: item.author?.avatarEmoji,
      createdAt: item.createdAt,
      deliveryStatus: "sent",
      eventType: item.subtype,
      eventPayload: item.eventPayload,
      interaction,
    }
  }

  const metadata = item.metadata || {}

  return {
    id: item.id,
    kind: "message",
    conversationId: item.conversationId,
    sequence: item.sequence,
    sessionId: item.sessionId || "",
    role: item.role,
    messageType: item.subtype,
    content: item.content,
    contentBlocks: normalizeContentBlocks(item.contentBlocks),
    author: item.author,
    fromActorId: item.author?.actorId,
    fromWorkspaceMemberId: item.author?.workspaceMemberId,
    actorName:
      item.author?.participantType === "actor" ? item.author.name : undefined,
    actorRole: item.author?.role,
    actorEmoji: item.author?.avatarEmoji,
    createdAt: item.createdAt,
    clientMessageId: item.clientMessageId,
    deliveryStatus: "sent",
    metadata,
    replyToItemId: item.replyToItemId,
    replyTo: item.replyTo,
    toolsUsed: metadata.toolsUsed as string[] | undefined,
    serverToolCalls: metadata.serverToolCalls as ServerToolCall[] | undefined,
    citationSources: metadata.citationSources as
      | Record<string, { url: string; title: string }>
      | undefined,
    coordination: Boolean(metadata.coordination),
    restrictedAudienceParticipantIds: item.restrictedAudienceParticipantIds,
    transport: item.transport,
    transportDeliveries: item.transportDeliveries,
  }
}

function mergeMessagesWithOutbox(
  loadedItems: ChatConversationItem[],
  snapshot: ChatWorkspaceSnapshot,
  conversationId: string
) {
  let nextMessages = sortMessages(loadedItems.map(chatItemToFeedMessage))
  const conversation = snapshot.conversations.find(
    (entry) => entry.conversationId === conversationId
  )

  const pendingEntries = Object.values(snapshot.outbox)
    .filter((entry) => entry.conversationId === conversationId)
    .sort((left, right) => left.optimisticSequence - right.optimisticSequence)

  for (const entry of pendingEntries) {
    const hasServerMessage = nextMessages.some(
      (message) =>
        message.clientMessageId &&
        message.clientMessageId === entry.clientMessageId &&
        message.id !== `local:${entry.clientMessageId}`
    )

    if (hasServerMessage) {
      continue
    }

    nextMessages = sortMessages([
      ...nextMessages.filter(
        (message) => message.clientMessageId !== entry.clientMessageId
      ),
      outboxEntryToMessage(
        entry,
        conversation,
        snapshot.workspaceMemberId ?? null
      ),
    ])
  }

  return nextMessages
}

function applyFeedMessageToConversation(
  conversation: ConversationSummary,
  item: FeedMessage
) {
  return {
    ...conversation,
    lastMessage: {
      content: buildMessagePreview(item),
      role: item.role,
      actorName: item.actorName,
      createdAt: item.createdAt,
    },
  }
}

function applyOutboxToConversations(
  conversations: ConversationSummary[],
  snapshot: ChatWorkspaceSnapshot,
  runtimeMap: ConversationRuntimeMap
) {
  let nextConversations = conversations
  const pendingEntries = Object.values(snapshot.outbox).sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  )

  for (const entry of pendingEntries) {
    const rawConversation = snapshot.conversations.find(
      (conversation) => conversation.conversationId === entry.conversationId
    )
    const optimisticMessage = outboxEntryToMessage(
      entry,
      rawConversation,
      snapshot.workspaceMemberId ?? null
    )

    nextConversations = sortConversations(
      nextConversations.map((conversation) =>
        conversation.id === entry.conversationId &&
        (!conversation.lastMessage ||
          new Date(entry.createdAt).getTime() >=
            new Date(conversation.lastMessage.createdAt).getTime())
          ? applyRuntimeMapToConversation(
              applyFeedMessageToConversation(conversation, optimisticMessage),
              runtimeMap[conversation.id]
            )
          : conversation
      )
    )
  }

  return nextConversations
}

function sortConversations(conversations: ConversationSummary[]) {
  return [...conversations].sort((left, right) => {
    const leftAt = left.lastMessage?.createdAt || left.createdAt
    const rightAt = right.lastMessage?.createdAt || right.createdAt
    return new Date(rightAt).getTime() - new Date(leftAt).getTime()
  })
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

export function remoteAgentRuntimeToAvatarStatus(
  runtime?: RemoteAgentRuntimeState
): RemoteAgentAvatarStatus | undefined {
  return runtime?.state
}

function applyRuntimeToConversationMembers(
  conversation: ConversationSummary,
  runtime: ActorRuntimeState
): ConversationSummary {
  return {
    ...conversation,
    members: conversation.members.map((member) =>
      member.participantType === "actor" && member.id === runtime.actorId
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
    (member) => member.participantType === "actor"
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
    status: deriveConversationStatus(nextConversation, runtimesForConversation),
  }
}

function deriveConversationSummaries(
  snapshot: ChatWorkspaceSnapshot,
  runtimeMap: ConversationRuntimeMap
) {
  const base = sortRawConversations(snapshot.conversations).map(
    (conversation) =>
      applyRuntimeMapToConversation(
        rawConversationToSummary(conversation, snapshot),
        runtimeMap[conversation.conversationId]
      )
  )

  return applyOutboxToConversations(base, snapshot, runtimeMap)
}

function createStateFromSnapshot(
  currentState: ChatState,
  snapshot: ChatWorkspaceSnapshot,
  input?: {
    selectedConversationId?: string | null
    visibleConversationId?: string | null
    loadedMessageItems?: ChatConversationItem[]
  }
) {
  const candidateSelectedConversationId =
    input?.selectedConversationId === undefined
      ? currentState.selectedConversationId
      : input.selectedConversationId

  const selectedConversationId =
    candidateSelectedConversationId &&
    snapshot.conversations.some(
      (conversation) =>
        conversation.conversationId === candidateSelectedConversationId
    )
      ? candidateSelectedConversationId
      : null

  const loadedMessageItems =
    input?.loadedMessageItems === undefined
      ? selectedConversationId === currentState.selectedConversationId
        ? currentState.loadedMessageItems
        : []
      : input.loadedMessageItems

  const visibleConversationId =
    input?.visibleConversationId === undefined
      ? currentState.visibleConversationId === selectedConversationId
        ? currentState.visibleConversationId
        : null
      : input.visibleConversationId

  const conversations = deriveConversationSummaries(
    snapshot,
    currentState.runtimeMap
  )
  const messages =
    selectedConversationId && loadedMessageItems.length >= 0
      ? mergeMessagesWithOutbox(
          loadedMessageItems,
          snapshot,
          selectedConversationId
        )
      : []

  return {
    snapshot,
    activeWorkspaceId: snapshot.workspaceId,
    workspaceMemberId: snapshot.workspaceMemberId ?? null,
    clientInstanceId: snapshot.clientInstanceId ?? null,
    outbox: snapshot.outbox,
    pendingReads: snapshot.pendingReads,
    conversations,
    messages: selectedConversationId ? messages : [],
    totalUnread: sumConversationUnread(conversations),
    selectedConversationId,
    visibleConversationId,
    loadedMessageItems: selectedConversationId ? loadedMessageItems : [],
  }
}

function shouldIncrementUnreadCount(
  conversation: ChatConversationView,
  item: ChatConversationItem
) {
  return (
    item.itemType === "message" &&
    item.scope === "shared" &&
    item.surface === "visible" &&
    item.authorParticipantId !== conversation.viewerParticipantId
  )
}

function applyReadWatermarkAck(
  snapshot: ChatWorkspaceSnapshot,
  response: ChatConversationReadWatermarkResponse
) {
  const pendingReads = { ...snapshot.pendingReads }
  const queued = pendingReads[response.conversationId]
  if (queued && queued.readUpToSequence <= response.readWatermarkSequence) {
    delete pendingReads[response.conversationId]
  }

  return {
    ...snapshot,
    pendingReads,
    conversations: snapshot.conversations.map((conversation) =>
      conversation.conversationId === response.conversationId
        ? { ...conversation, unreadCount: 0 }
        : conversation
    ),
  }
}

function clearDeliveredOutbox(
  outbox: StoredChatQueueState["outbox"],
  items: ChatConversationItem[]
) {
  const deliveredClientIds = new Set(
    items
      .map((item) => item.clientMessageId)
      .filter((value): value is string => Boolean(value))
  )
  if (deliveredClientIds.size === 0) {
    return outbox
  }

  const nextOutbox = { ...outbox }
  for (const clientMessageId of deliveredClientIds) {
    delete nextOutbox[clientMessageId]
  }
  return nextOutbox
}

function applySyncEventToSnapshot(
  snapshot: ChatWorkspaceSnapshot,
  event: ChatSyncEvent,
  visibleConversationId?: string | null
) {
  let nextSnapshot: ChatWorkspaceSnapshot = {
    ...snapshot,
    inboxCursor: Math.max(snapshot.inboxCursor, event.syncSeq),
  }

  switch (event.eventType) {
    case "conversation.upsert": {
      const payload =
        event.payload as ChatSyncEvent<"conversation.upsert">["payload"]
      nextSnapshot = {
        ...nextSnapshot,
        conversations: upsertRawConversation(
          nextSnapshot.conversations,
          payload.conversation
        ),
      }
      break
    }
    case "conversation.item.created": {
      const payload =
        event.payload as ChatSyncEvent<"conversation.item.created">["payload"]
      const currentConversation = nextSnapshot.conversations.find(
        (conversation) => conversation.conversationId === payload.conversationId
      )

      nextSnapshot = {
        ...nextSnapshot,
        outbox: clearDeliveredOutbox(nextSnapshot.outbox, [payload.item]),
      }

      if (!currentConversation) {
        break
      }

      nextSnapshot = {
        ...nextSnapshot,
        conversations: upsertRawConversation(nextSnapshot.conversations, {
          ...currentConversation,
          unreadCount:
            visibleConversationId === payload.conversationId
              ? currentConversation.unreadCount
              : shouldIncrementUnreadCount(currentConversation, payload.item)
                ? currentConversation.unreadCount + 1
                : currentConversation.unreadCount,
          updatedAt: payload.item.createdAt,
          lastItem: {
            itemId: payload.item.id,
            sequence: payload.item.sequence,
            itemType: payload.item.itemType,
            subtype: payload.item.subtype,
            previewText:
              extractText(payload.item.contentBlocks).trim() ||
              payload.item.content ||
              (payload.item.itemType === "event"
                ? payload.item.subtype
                : "Attachment"),
            authorParticipantId: payload.item.authorParticipantId,
            author: payload.item.author,
            createdAt: payload.item.createdAt,
          },
        }),
      }
      break
    }
    case "conversation.read.updated": {
      const payload =
        event.payload as ChatSyncEvent<"conversation.read.updated">["payload"]
      if (payload.workspaceMemberId !== nextSnapshot.workspaceMemberId) {
        break
      }

      nextSnapshot = applyReadWatermarkAck(nextSnapshot, {
        conversationId: payload.conversationId,
        workspaceMemberId: payload.workspaceMemberId,
        participantId: payload.participantId,
        readWatermarkSequence: payload.readWatermarkSequence,
        lastReadAt: payload.lastReadAt,
      })
      break
    }
    case "interaction.updated": {
      const payload =
        event.payload as ChatSyncEvent<"interaction.updated">["payload"]
      nextSnapshot = applyInteractionUpdatedToSnapshot(nextSnapshot, payload)
      break
    }
  }

  return nextSnapshot
}

async function bootstrapWorkspaceSnapshot(
  workspaceId: string,
  snapshot: ChatWorkspaceSnapshot | null
) {
  const bootstrap = await api.getChatBootstrap(workspaceId)

  let baseSnapshot = snapshot ?? createEmptyWorkspaceSnapshot(workspaceId)
  if (
    baseSnapshot.workspaceMemberId &&
    baseSnapshot.workspaceMemberId !== bootstrap.workspaceMemberId
  ) {
    baseSnapshot = createEmptyWorkspaceSnapshot(workspaceId)
  }

  const clientInstanceInput = {
    platform: "web-desktop",
    deviceLabel: buildDesktopDeviceLabel(),
    metadata: {
      workspaceMemberId: bootstrap.workspaceMemberId,
    },
  }

  let clientInstanceId = baseSnapshot.clientInstanceId || null
  if (clientInstanceId) {
    const response = await api.touchChatClientInstance(
      workspaceId,
      clientInstanceId,
      clientInstanceInput
    )
    clientInstanceId = response.clientInstanceId
  }

  if (!clientInstanceId) {
    const response = await api.createChatClientInstance(
      workspaceId,
      clientInstanceInput
    )
    clientInstanceId = response.clientInstanceId
  }

  return {
    ...baseSnapshot,
    workspaceId,
    workspaceMemberId: bootstrap.workspaceMemberId,
    clientInstanceId,
    inboxCursor: Math.max(baseSnapshot.inboxCursor, bootstrap.nextInboxCursor),
    lastBootstrappedAt: new Date().toISOString(),
    conversations: bootstrap.conversations.reduce(
      upsertRawConversation,
      baseSnapshot.conversations
    ),
  }
}

async function flushPendingReadsInternal(snapshot: ChatWorkspaceSnapshot) {
  if (!snapshot.clientInstanceId) {
    return snapshot
  }

  let nextSnapshot = snapshot
  const pendingReads = Object.values(snapshot.pendingReads).sort(
    (left, right) => left.readUpToSequence - right.readUpToSequence
  )

  for (const entry of pendingReads) {
    try {
      const response = await api.updateChatConversationReadWatermark(
        snapshot.workspaceId,
        entry.conversationId,
        {
          clientInstanceId: snapshot.clientInstanceId,
          readUpToSequence: entry.readUpToSequence,
          lastVisibleSequence: entry.lastVisibleSequence,
        }
      )
      nextSnapshot = applyReadWatermarkAck(nextSnapshot, response)
    } catch {
      break
    }
  }

  return nextSnapshot
}

async function flushOutboxInternal(
  snapshot: ChatWorkspaceSnapshot,
  selectedConversationId: string | null,
  loadedMessageItems: ChatConversationItem[]
) {
  if (!snapshot.clientInstanceId) {
    return {
      snapshot,
      loadedMessageItems,
      retryAttemptCount: null as number | null,
    }
  }

  let nextSnapshot = snapshot
  let nextLoadedMessageItems = loadedMessageItems
  let retryAttemptCount: number | null = null

  const entries = Object.values(snapshot.outbox).sort(
    (left, right) => left.optimisticSequence - right.optimisticSequence
  )

  for (const entry of entries) {
    nextSnapshot = {
      ...nextSnapshot,
      outbox: {
        ...nextSnapshot.outbox,
        [entry.clientMessageId]: {
          ...nextSnapshot.outbox[entry.clientMessageId]!,
          attemptCount:
            nextSnapshot.outbox[entry.clientMessageId]!.attemptCount + 1,
          lastAttemptAt: new Date().toISOString(),
        },
      },
    }

    try {
      const response = await api.sendChatConversationMessage(
        snapshot.workspaceId,
        entry.conversationId,
        {
          clientInstanceId: snapshot.clientInstanceId,
          clientMessageId: entry.clientMessageId,
          contentBlocks: entry.contentBlocks,
          replyToItemId: entry.replyToItemId,
        }
      )

      const nextOutbox = { ...nextSnapshot.outbox }
      delete nextOutbox[entry.clientMessageId]

      const currentConversation = nextSnapshot.conversations.find(
        (conversation) => conversation.conversationId === entry.conversationId
      )

      nextSnapshot = {
        ...nextSnapshot,
        outbox: nextOutbox,
        conversations: currentConversation
          ? upsertRawConversation(nextSnapshot.conversations, {
              ...currentConversation,
              updatedAt: response.item.createdAt,
              lastItem: {
                itemId: response.item.id,
                sequence: response.item.sequence,
                itemType: response.item.itemType,
                subtype: response.item.subtype,
                previewText:
                  extractText(response.item.contentBlocks).trim() ||
                  response.item.content ||
                  (response.item.itemType === "event"
                    ? response.item.subtype
                    : "Attachment"),
                authorParticipantId: response.item.authorParticipantId,
                author: response.item.author,
                createdAt: response.item.createdAt,
              },
            })
          : nextSnapshot.conversations,
      }

      if (selectedConversationId === entry.conversationId) {
        nextLoadedMessageItems = mergeRawItems(nextLoadedMessageItems, [
          response.item,
        ])
      }
    } catch (error) {
      const currentEntry = nextSnapshot.outbox[entry.clientMessageId]
      if (!currentEntry) {
        break
      }

      retryAttemptCount = currentEntry.attemptCount
      nextSnapshot = {
        ...nextSnapshot,
        outbox: {
          ...nextSnapshot.outbox,
          [entry.clientMessageId]: {
            ...currentEntry,
            status: "retrying",
            firstFailedAt:
              currentEntry.firstFailedAt || new Date().toISOString(),
            lastErrorMessage:
              error instanceof Error ? error.message : "Failed to send message",
          },
        },
      }
      break
    }
  }

  return {
    snapshot: nextSnapshot,
    loadedMessageItems: nextLoadedMessageItems,
    retryAttemptCount,
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  activeWorkspaceId: null,
  workspaceMemberId: null,
  clientInstanceId: null,
  selectedConversationId: null,
  visibleConversationId: null,
  conversations: [],
  messages: [],
  outbox: {},
  pendingReads: {},
  loadingConversations: false,
  loadingMessages: false,
  syncing: false,
  runtimeMap: {},
  remoteAgentRuntimeMap: {},
  runtimeSeqMap: {},
  totalUnread: 0,
  snapshot: null,
  loadedMessageItems: [],

  deactivate: () => {
    clearOutboxRetryTimer()
    bootstrapPromise = null
    bootstrapWorkspaceId = null
    syncPromise = null

    set({
      activeWorkspaceId: null,
      workspaceMemberId: null,
      clientInstanceId: null,
      selectedConversationId: null,
      visibleConversationId: null,
      conversations: [],
      messages: [],
      outbox: {},
      pendingReads: {},
      loadingConversations: false,
      loadingMessages: false,
      syncing: false,
      runtimeMap: {},
      remoteAgentRuntimeMap: {},
      runtimeSeqMap: {},
      totalUnread: 0,
      snapshot: null,
      loadedMessageItems: [],
    })
  },

  loadConversations: async (workspaceId, options) => {
    const currentState = get()
    const shouldShowLoading =
      !options?.silent || currentState.conversations.length === 0

    if (bootstrapPromise && bootstrapWorkspaceId === workspaceId) {
      return bootstrapPromise
    }

    bootstrapWorkspaceId = workspaceId
    bootstrapPromise = (async () => {
      if (shouldShowLoading) {
        set({
          activeWorkspaceId: workspaceId,
          loadingConversations: true,
        })
      } else if (get().activeWorkspaceId !== workspaceId) {
        set({
          activeWorkspaceId: workspaceId,
        })
      }

      const persistedQueueState =
        (await loadStoredChatQueueState(workspaceId).catch(() => null)) ||
        createEmptyStoredChatQueueState(workspaceId)

      if (get().activeWorkspaceId && get().activeWorkspaceId !== workspaceId) {
        return
      }

      const currentSnapshot = get().snapshot
      const baseSnapshot =
        currentSnapshot?.workspaceId === workspaceId
          ? mergeStoredQueueIntoSnapshot(currentSnapshot, persistedQueueState)
          : mergeStoredQueueIntoSnapshot(null, persistedQueueState)

      const nextSnapshot = await bootstrapWorkspaceSnapshot(
        workspaceId,
        baseSnapshot
      )

      if (get().activeWorkspaceId && get().activeWorkspaceId !== workspaceId) {
        return
      }

      set((state) => ({
        ...createStateFromSnapshot(state, nextSnapshot),
        loadingConversations: false,
      }))
      void queuePersistSnapshot(baseSnapshot, nextSnapshot)
      await get().syncFromServer(workspaceId)
    })()
      .catch((error) => {
        console.error("Failed to load conversations:", error)
        set({
          loadingConversations: false,
        })
      })
      .finally(() => {
        if (bootstrapWorkspaceId === workspaceId) {
          bootstrapWorkspaceId = null
          bootstrapPromise = null
        }
      })

    return bootstrapPromise
  },

  reloadPersistedSnapshot: async (workspaceId) => {
    const persistedQueueState = await loadStoredChatQueueState(
      workspaceId
    ).catch(() => null)
    if (!persistedQueueState) {
      return
    }

    if (get().activeWorkspaceId && get().activeWorkspaceId !== workspaceId) {
      return
    }

    set((state) => {
      if (!state.snapshot || state.snapshot.workspaceId !== workspaceId) {
        return state
      }

      const mergedSnapshot = mergeStoredQueueIntoSnapshot(
        state.snapshot,
        persistedQueueState
      )
      return {
        ...createStateFromSnapshot(state, mergedSnapshot),
      }
    })
  },

  hydrateOutbox: async (workspaceId) => {
    await get().reloadPersistedSnapshot(workspaceId)
  },

  selectConversation: (conversationId) => {
    const currentSelection = get().selectedConversationId
    if (currentSelection === conversationId) {
      return
    }

    set({
      selectedConversationId: conversationId,
      loadedMessageItems: [],
      messages: [],
      loadingMessages: true,
    })
  },

  setVisibleConversation: (conversationId) => {
    set((state) => ({
      visibleConversationId: conversationId,
      ...(state.snapshot
        ? createStateFromSnapshot(state, state.snapshot, {
            visibleConversationId: conversationId,
          })
        : {}),
    }))
  },

  loadMessages: async (workspaceId, conversationId) => {
    const currentSnapshot = get().snapshot
    if (!currentSnapshot?.clientInstanceId) {
      set({ loadingMessages: false })
      return
    }
    set({ loadingMessages: true })

    try {
      const response = await api.getChatConversationMessages(
        workspaceId,
        conversationId,
        {
          clientInstanceId: currentSnapshot.clientInstanceId,
          limit: 100,
        }
      )

      set((state) => {
        const baseSnapshot =
          state.snapshot ?? createEmptyWorkspaceSnapshot(workspaceId)
        const nextRuntimeMap = {
          ...state.runtimeMap,
          [conversationId]: response.runtimeByActor || {},
        }
        const nextRemoteAgentRuntimeMap = {
          ...state.remoteAgentRuntimeMap,
          ...(response.runtimeByRemoteAgent || {}),
        }

        if (state.selectedConversationId !== conversationId) {
          return {
            runtimeMap: nextRuntimeMap,
            remoteAgentRuntimeMap: nextRemoteAgentRuntimeMap,
          }
        }

        const nextSnapshot = {
          ...baseSnapshot,
          conversations: upsertRawConversation(
            baseSnapshot.conversations,
            response.conversation
          ),
          outbox: clearDeliveredOutbox(baseSnapshot.outbox, response.items),
        }

        void queuePersistSnapshot(baseSnapshot, nextSnapshot)

        return {
          ...createStateFromSnapshot(
            {
              ...state,
              runtimeMap: nextRuntimeMap,
              remoteAgentRuntimeMap: nextRemoteAgentRuntimeMap,
            } as ChatState,
            nextSnapshot,
            {
              loadedMessageItems: mergeRawItems([], response.items),
            }
          ),
          runtimeMap: nextRuntimeMap,
          remoteAgentRuntimeMap: nextRemoteAgentRuntimeMap,
          loadingMessages: false,
        }
      })
    } catch (error) {
      console.error("Failed to load messages:", error)
      set((state) =>
        state.selectedConversationId === conversationId
          ? { loadingMessages: false }
          : state
      )
    }
  },

  sendMessage: async (workspaceId, conversationId, input) => {
    const snapshot = get().snapshot
    if (!snapshot || snapshot.workspaceId !== workspaceId) {
      throw new Error("No active workspace")
    }
    if (!snapshot.clientInstanceId) {
      throw new Error("Chat is still connecting")
    }

    const existingSequences = [
      ...get()
        .loadedMessageItems.filter(
          (item) => item.conversationId === conversationId
        )
        .map((item) => item.sequence),
      ...Object.values(snapshot.outbox)
        .filter((entry) => entry.conversationId === conversationId)
        .map((entry) => entry.optimisticSequence),
      0,
    ]

    const optimisticSequence =
      Math.max(Date.now() * 1000, ...existingSequences) + 1

    const entry: OutboxEntry = {
      clientMessageId: createUuid("message"),
      conversationId,
      contentBlocks: input.contentBlocks,
      replyToItemId: input.replyToItemId,
      replyTo: input.replyTo,
      createdAt: new Date().toISOString(),
      optimisticSequence,
      status: "sending",
      attemptCount: 0,
    }

    set((state) => {
      const currentSnapshot = state.snapshot
      if (!currentSnapshot) {
        return state
      }

      const nextSnapshot = {
        ...currentSnapshot,
        outbox: {
          ...currentSnapshot.outbox,
          [entry.clientMessageId]: entry,
        },
      }

      void queuePersistSnapshot(currentSnapshot, nextSnapshot)
      return createStateFromSnapshot(state, nextSnapshot)
    })

    await get().flushOutbox(workspaceId)
  },

  flushOutbox: async (workspaceId) => {
    const snapshot = get().snapshot
    if (!snapshot) {
      return
    }
    if (workspaceId && snapshot.workspaceId !== workspaceId) {
      return
    }

    clearOutboxRetryTimer()

    const result = await flushOutboxInternal(
      snapshot,
      get().selectedConversationId,
      get().loadedMessageItems
    )

    set((state) => ({
      ...createStateFromSnapshot(state, result.snapshot, {
        loadedMessageItems:
          get().selectedConversationId === state.selectedConversationId
            ? result.loadedMessageItems
            : state.loadedMessageItems,
      }),
    }))
    void queuePersistSnapshot(snapshot, result.snapshot)

    if (result.retryAttemptCount !== null) {
      scheduleOutboxRetry(result.retryAttemptCount)
    }
  },

  syncFromServer: async (workspaceId) => {
    const currentSnapshot = get().snapshot
    const effectiveWorkspaceId =
      workspaceId || currentSnapshot?.workspaceId || get().activeWorkspaceId

    if (!effectiveWorkspaceId) {
      return
    }

    if (syncPromise) {
      return syncPromise
    }

    set({ syncing: true })
    syncPromise = (async () => {
      let workingSnapshot = get().snapshot
      if (
        !workingSnapshot ||
        workingSnapshot.workspaceId !== effectiveWorkspaceId
      ) {
        return
      }

      let workingLoadedItems = get().loadedMessageItems
      let cursor = workingSnapshot.inboxCursor
      let hasMore = true

      while (hasMore) {
        if (get().snapshot?.workspaceId !== effectiveWorkspaceId) {
          return
        }

        const response = await api.getChatSync(effectiveWorkspaceId, {
          cursor,
          limit: 200,
        })

        for (const event of response.events) {
          workingSnapshot = applySyncEventToSnapshot(
            workingSnapshot,
            event,
            get().visibleConversationId
          )

          if (event.eventType === "conversation.item.created") {
            const payload =
              event.payload as ChatSyncEvent<"conversation.item.created">["payload"]
            if (payload.conversationId !== get().selectedConversationId) {
              continue
            }
            workingLoadedItems = mergeRawItems(workingLoadedItems, [
              payload.item,
            ])
            continue
          }

          if (event.eventType === "interaction.updated") {
            const payload =
              event.payload as ChatSyncEvent<"interaction.updated">["payload"]
            if (payload.conversationId !== get().selectedConversationId) {
              continue
            }
            workingLoadedItems = patchInteractionInRawItems(
              workingLoadedItems,
              payload
            )
          }
        }

        cursor = response.nextCursor
        hasMore = response.hasMore
      }

      workingSnapshot = await flushPendingReadsInternal(workingSnapshot)

      const outboxResult = await flushOutboxInternal(
        workingSnapshot,
        get().selectedConversationId,
        workingLoadedItems
      )
      workingSnapshot = outboxResult.snapshot
      workingLoadedItems = outboxResult.loadedMessageItems

      set((state) => ({
        ...createStateFromSnapshot(state, workingSnapshot, {
          loadedMessageItems: workingLoadedItems,
        }),
      }))
      void queuePersistSnapshot(currentSnapshot, workingSnapshot)

      if (outboxResult.retryAttemptCount !== null) {
        scheduleOutboxRetry(outboxResult.retryAttemptCount)
      }
    })()
      .catch((error) => {
        console.error("Failed to sync chat inbox:", error)
      })
      .finally(() => {
        syncPromise = null
        set({ syncing: false })
      })

    return syncPromise
  },

  createWorkspaceThread: async (
    workspaceId,
    kind,
    actorIds,
    content,
    contentBlocks,
    title
  ) => {
    const response = await api.createChatConversation(workspaceId, {
      clientRequestId: createUuid("conversation"),
      kind,
      title,
      actorIds,
      metadata:
        content || (contentBlocks && contentBlocks.length > 0)
          ? {
              initialContent: content,
              initialContentBlocks: contentBlocks,
            }
          : undefined,
    })

    if (get().activeWorkspaceId === workspaceId && get().snapshot) {
      set((state) => {
        if (!state.snapshot || state.snapshot.workspaceId !== workspaceId) {
          return state
        }

        const nextSnapshot = {
          ...state.snapshot,
          conversations: upsertRawConversation(
            state.snapshot.conversations,
            response.conversation
          ),
        }

        return createStateFromSnapshot(state, nextSnapshot)
      })
    }

    return response.conversation.conversationId
  },

  markConversationRead: async (
    conversationId,
    readUpToSequence,
    lastVisibleSequence
  ) => {
    const snapshot = get().snapshot
    if (!snapshot) {
      return
    }

    const normalizedReadUpToSequence = Math.max(0, Math.floor(readUpToSequence))
    const normalizedLastVisibleSequence = Math.max(
      normalizedReadUpToSequence,
      Math.floor(lastVisibleSequence ?? normalizedReadUpToSequence)
    )

    const nextSnapshot: ChatWorkspaceSnapshot = {
      ...snapshot,
      pendingReads: {
        ...snapshot.pendingReads,
        [conversationId]: {
          conversationId,
          readUpToSequence: Math.max(
            normalizedReadUpToSequence,
            snapshot.pendingReads[conversationId]?.readUpToSequence || 0
          ),
          lastVisibleSequence: Math.max(
            normalizedLastVisibleSequence,
            snapshot.pendingReads[conversationId]?.lastVisibleSequence || 0
          ),
          updatedAt: new Date().toISOString(),
        },
      },
      conversations: snapshot.conversations.map((conversation) =>
        conversation.conversationId === conversationId
          ? { ...conversation, unreadCount: 0 }
          : conversation
      ),
    }

    set((state) => createStateFromSnapshot(state, nextSnapshot))
    void queuePersistSnapshot(snapshot, nextSnapshot)

    if (!nextSnapshot.clientInstanceId) {
      return
    }

    try {
      const response = await api.updateChatConversationReadWatermark(
        nextSnapshot.workspaceId,
        conversationId,
        {
          clientInstanceId: nextSnapshot.clientInstanceId,
          readUpToSequence: normalizedReadUpToSequence,
          lastVisibleSequence: normalizedLastVisibleSequence,
        }
      )

      set((state) => {
        if (!state.snapshot) {
          return state
        }
        const confirmedSnapshot = applyReadWatermarkAck(
          state.snapshot,
          response
        )
        void queuePersistSnapshot(state.snapshot, confirmedSnapshot)
        return createStateFromSnapshot(state, confirmedSnapshot)
      })
    } catch (error) {
      console.error("Failed to mark conversation read:", error)
    }
  },

  handleSyncEvent: (event) => {
    set((state) => {
      if (!state.snapshot || state.snapshot.workspaceId !== event.workspaceId) {
        return state
      }

      let nextLoadedItems = state.loadedMessageItems
      const nextSnapshot = applySyncEventToSnapshot(
        state.snapshot,
        event,
        state.visibleConversationId
      )

      if (event.eventType === "conversation.item.created") {
        const payload =
          event.payload as ChatSyncEvent<"conversation.item.created">["payload"]
        if (payload.conversationId !== state.selectedConversationId) {
          void queuePersistSnapshot(state.snapshot, nextSnapshot)
          return createStateFromSnapshot(state, nextSnapshot, {
            loadedMessageItems: nextLoadedItems,
          })
        }
        nextLoadedItems = mergeRawItems(state.loadedMessageItems, [
          payload.item,
        ])
      } else if (event.eventType === "interaction.updated") {
        const payload =
          event.payload as ChatSyncEvent<"interaction.updated">["payload"]
        if (payload.conversationId === state.selectedConversationId) {
          nextLoadedItems = patchInteractionInRawItems(
            state.loadedMessageItems,
            payload
          )
        }
      } else if (event.eventType === "remote_agent.runtime_updated") {
        const payload =
          event.payload as ChatSyncEvent<"remote_agent.runtime_updated">["payload"]
        void queuePersistSnapshot(state.snapshot, nextSnapshot)
        return {
          ...createStateFromSnapshot(state, nextSnapshot, {
            loadedMessageItems: nextLoadedItems,
          }),
          remoteAgentRuntimeMap: {
            ...state.remoteAgentRuntimeMap,
            [payload.remoteAgentId]: payload.snapshot,
          },
        }
      }

      void queuePersistSnapshot(state.snapshot, nextSnapshot)
      return createStateFromSnapshot(state, nextSnapshot, {
        loadedMessageItems: nextLoadedItems,
      })
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

      const conversations = state.snapshot
        ? deriveConversationSummaries(state.snapshot, runtimeMap)
        : state.conversations

      return {
        runtimeMap,
        runtimeSeqMap: {
          ...state.runtimeSeqMap,
          [payload.conversationId]: payload.runtimeSeq,
        },
        conversations,
        totalUnread: sumConversationUnread(conversations),
      }
    })
  },

  handleInteractionUpdated: (payload) => {
    set((state) => {
      if (!state.snapshot) {
        return state
      }

      const nextSnapshot = applyInteractionUpdatedToSnapshot(
        state.snapshot,
        payload
      )
      const nextLoadedItems =
        payload.conversationId === state.selectedConversationId
          ? patchInteractionInRawItems(state.loadedMessageItems, payload)
          : state.loadedMessageItems

      return createStateFromSnapshot(state, nextSnapshot, {
        loadedMessageItems: nextLoadedItems,
      })
    })
  },
}))
