import Feather from "@expo/vector-icons/Feather"

import { isUuid } from "@/lib/ids"
import {
  extractText,
  summarizeConversationEvent,
  type CanonicalContentBlock,
  type ChatConversationItem,
  type ChatConversationView,
  type ConversationEntityRef,
  type ConversationReplyRef,
  type ChatParticipantSummary,
} from "@shared"

export type LocalChatDeliveryStatus = "sending" | "retrying"

export interface PendingChatRead {
  conversationId: string
  readUpToSequence: number
  lastVisibleSequence: number
  updatedAt: string
}

export interface PendingChatOutboxMessage {
  clientMessageId: string
  conversationId: string
  contentBlocks: CanonicalContentBlock[]
  replyToItemId?: string
  replyTo?: ConversationReplyRef
  createdAt: string
  optimisticSequence: number
  status: LocalChatDeliveryStatus
  attemptCount: number
  lastAttemptAt?: string
  firstFailedAt?: string
  lastErrorMessage?: string
}

export interface ChatConversationMeta {
  readWatermarkSequence: number
  hasMoreBefore: boolean
  hasLoadedLatest: boolean
  loadingLatest: boolean
  lastFetchedAt?: string
  latestLoadError?: string
}

export interface ChatWorkspaceSnapshot {
  version: 4
  workspaceId: string
  workspaceMemberId?: string
  clientInstanceId?: string
  inboxCursor: number
  lastBootstrappedAt?: string
  conversations: ChatConversationView[]
  itemsByConversationId: Record<string, ChatConversationItem[]>
  metaByConversationId: Record<string, ChatConversationMeta>
  pendingReads: Record<string, PendingChatRead>
  outbox: Record<string, PendingChatOutboxMessage>
}

export interface ChatWorkspaceQueueState {
  version: 1
  workspaceId: string
  workspaceMemberId?: string
  clientInstanceId?: string
  inboxCursor: number
  lastBootstrappedAt?: string
  pendingReads: Record<string, PendingChatRead>
  outbox: Record<string, PendingChatOutboxMessage>
}

export type MobileChatItem = ChatConversationItem & {
  localOnly?: boolean
  localDeliveryStatus?: LocalChatDeliveryStatus
  localErrorMessage?: string
}

export function createEmptyChatWorkspaceSnapshot(
  workspaceId: string
): ChatWorkspaceSnapshot {
  return {
    version: 4,
    workspaceId,
    inboxCursor: 0,
    conversations: [],
    itemsByConversationId: {},
    metaByConversationId: {},
    pendingReads: {},
    outbox: {},
  }
}

export function createEmptyChatWorkspaceQueueState(
  workspaceId: string
): ChatWorkspaceQueueState {
  return {
    version: 1,
    workspaceId,
    inboxCursor: 0,
    pendingReads: {},
    outbox: {},
  }
}

function normalizePendingReads(
  value: unknown,
  validConversationIds?: Set<string>
): Record<string, PendingChatRead> {
  if (!value || typeof value !== "object") {
    return {}
  }

  return Object.fromEntries(
    Object.values(value as Record<string, unknown>)
      .filter((entry): entry is PendingChatRead =>
        Boolean(
          entry &&
          typeof entry === "object" &&
          typeof (entry as { conversationId?: unknown }).conversationId ===
            "string" &&
          typeof (entry as { readUpToSequence?: unknown }).readUpToSequence ===
            "number" &&
          typeof (entry as { lastVisibleSequence?: unknown })
            .lastVisibleSequence === "number" &&
          typeof (entry as { updatedAt?: unknown }).updatedAt === "string"
        )
      )
      .filter(
        (entry) =>
          !validConversationIds ||
          validConversationIds.has(entry.conversationId)
      )
      .map((entry) => [entry.conversationId, entry] as const)
  )
}

function normalizeOutbox(
  value: unknown,
  validConversationIds?: Set<string>
): Record<string, PendingChatOutboxMessage> {
  if (!value || typeof value !== "object") {
    return {}
  }

  return Object.fromEntries(
    Object.values(value as Record<string, unknown>)
      .filter((entry): entry is PendingChatOutboxMessage =>
        Boolean(
          entry &&
          typeof entry === "object" &&
          typeof (entry as { clientMessageId?: unknown }).clientMessageId ===
            "string" &&
          typeof (entry as { conversationId?: unknown }).conversationId ===
            "string" &&
          Array.isArray((entry as { contentBlocks?: unknown }).contentBlocks) &&
          typeof (entry as { createdAt?: unknown }).createdAt === "string" &&
          typeof (entry as { optimisticSequence?: unknown })
            .optimisticSequence === "number" &&
          typeof (entry as { status?: unknown }).status === "string" &&
          typeof (entry as { attemptCount?: unknown }).attemptCount === "number"
        )
      )
      .filter(
        (entry) =>
          !validConversationIds ||
          validConversationIds.has(entry.conversationId)
      )
      .map((entry) => [entry.clientMessageId, entry] as const)
  )
}

export function normalizeChatWorkspaceSnapshot(
  workspaceId: string,
  value: unknown
): ChatWorkspaceSnapshot {
  if (!value || typeof value !== "object") {
    return createEmptyChatWorkspaceSnapshot(workspaceId)
  }

  const snapshot = value as Partial<ChatWorkspaceSnapshot>

  if (snapshot.version !== 4 || snapshot.workspaceId !== workspaceId) {
    return createEmptyChatWorkspaceSnapshot(workspaceId)
  }

  const conversations = Array.isArray(snapshot.conversations)
    ? (snapshot.conversations as unknown[]).filter(
        (conversation): conversation is ChatConversationView =>
          Boolean(
            conversation &&
            typeof conversation === "object" &&
            typeof (conversation as { conversationId?: unknown })
              .conversationId === "string" &&
            typeof (conversation as { workspaceId?: unknown }).workspaceId ===
              "string" &&
            typeof (conversation as { title?: unknown }).title === "string" &&
            (conversation as { presentation?: unknown }).presentation &&
            typeof (conversation as { presentation?: unknown }).presentation ===
              "object" &&
            Array.isArray(
              (conversation as { participants?: unknown }).participants
            )
          )
      )
    : []

  const validConversationIds = new Set(
    conversations.map((conversation) => conversation.conversationId)
  )

  return {
    version: 4,
    workspaceId,
    workspaceMemberId:
      typeof snapshot.workspaceMemberId === "string"
        ? snapshot.workspaceMemberId
        : undefined,
    clientInstanceId:
      typeof snapshot.clientInstanceId === "string" &&
      isUuid(snapshot.clientInstanceId)
        ? snapshot.clientInstanceId
        : undefined,
    inboxCursor:
      typeof snapshot.inboxCursor === "number" &&
      Number.isFinite(snapshot.inboxCursor)
        ? snapshot.inboxCursor
        : 0,
    lastBootstrappedAt:
      typeof snapshot.lastBootstrappedAt === "string"
        ? snapshot.lastBootstrappedAt
        : undefined,
    conversations,
    itemsByConversationId:
      snapshot.itemsByConversationId &&
      typeof snapshot.itemsByConversationId === "object"
        ? Object.fromEntries(
            Object.entries(
              snapshot.itemsByConversationId as Record<
                string,
                ChatConversationItem[]
              >
            ).filter(([conversationId]) =>
              validConversationIds.has(conversationId)
            )
          )
        : {},
    metaByConversationId:
      snapshot.metaByConversationId &&
      typeof snapshot.metaByConversationId === "object"
        ? Object.fromEntries(
            Object.entries(
              snapshot.metaByConversationId as Record<
                string,
                ChatConversationMeta
              >
            )
              .filter(([conversationId]) =>
                validConversationIds.has(conversationId)
              )
              .map(([conversationId, meta]) => [
                conversationId,
                {
                  readWatermarkSequence:
                    typeof meta?.readWatermarkSequence === "number"
                      ? meta.readWatermarkSequence
                      : 0,
                  hasMoreBefore: Boolean(meta?.hasMoreBefore),
                  hasLoadedLatest: Boolean(meta?.hasLoadedLatest),
                  loadingLatest: false,
                  lastFetchedAt:
                    typeof meta?.lastFetchedAt === "string"
                      ? meta.lastFetchedAt
                      : undefined,
                } satisfies ChatConversationMeta,
              ])
          )
        : {},
    pendingReads: normalizePendingReads(
      snapshot.pendingReads,
      validConversationIds
    ),
    outbox: normalizeOutbox(snapshot.outbox, validConversationIds),
  }
}

export function normalizeChatWorkspaceQueueState(
  workspaceId: string,
  value: unknown
): ChatWorkspaceQueueState {
  if (!value || typeof value !== "object") {
    return createEmptyChatWorkspaceQueueState(workspaceId)
  }

  const queueState = value as Partial<ChatWorkspaceQueueState>
  if (queueState.version !== 1 || queueState.workspaceId !== workspaceId) {
    return createEmptyChatWorkspaceQueueState(workspaceId)
  }

  return {
    version: 1,
    workspaceId,
    workspaceMemberId:
      typeof queueState.workspaceMemberId === "string"
        ? queueState.workspaceMemberId
        : undefined,
    clientInstanceId:
      typeof queueState.clientInstanceId === "string" &&
      isUuid(queueState.clientInstanceId)
        ? queueState.clientInstanceId
        : undefined,
    inboxCursor:
      typeof queueState.inboxCursor === "number" &&
      Number.isFinite(queueState.inboxCursor)
        ? queueState.inboxCursor
        : 0,
    lastBootstrappedAt:
      typeof queueState.lastBootstrappedAt === "string"
        ? queueState.lastBootstrappedAt
        : undefined,
    pendingReads: normalizePendingReads(queueState.pendingReads),
    outbox: normalizeOutbox(queueState.outbox),
  }
}

export function toChatWorkspaceQueueState(
  snapshot: ChatWorkspaceSnapshot
): ChatWorkspaceQueueState {
  return {
    version: 1,
    workspaceId: snapshot.workspaceId,
    workspaceMemberId: snapshot.workspaceMemberId,
    clientInstanceId: snapshot.clientInstanceId,
    inboxCursor: snapshot.inboxCursor,
    lastBootstrappedAt: snapshot.lastBootstrappedAt,
    pendingReads: snapshot.pendingReads,
    outbox: snapshot.outbox,
  }
}

export function applyChatWorkspaceQueueState(
  snapshot: ChatWorkspaceSnapshot,
  queueState: ChatWorkspaceQueueState
): ChatWorkspaceSnapshot {
  return {
    ...snapshot,
    workspaceId: queueState.workspaceId,
    workspaceMemberId:
      queueState.workspaceMemberId ?? snapshot.workspaceMemberId,
    clientInstanceId: queueState.clientInstanceId ?? snapshot.clientInstanceId,
    inboxCursor: Math.max(snapshot.inboxCursor, queueState.inboxCursor),
    lastBootstrappedAt:
      queueState.lastBootstrappedAt ?? snapshot.lastBootstrappedAt,
    pendingReads: queueState.pendingReads,
    outbox: queueState.outbox,
  }
}

export function buildChatWorkspaceSnapshotFromQueueState(
  workspaceId: string,
  queueState: ChatWorkspaceQueueState | null
): ChatWorkspaceSnapshot {
  return applyChatWorkspaceQueueState(
    createEmptyChatWorkspaceSnapshot(workspaceId),
    queueState ?? createEmptyChatWorkspaceQueueState(workspaceId)
  )
}

export function sortChatConversations(conversations: ChatConversationView[]) {
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

export function sortChatItems<
  T extends Pick<ChatConversationItem, "sequence" | "createdAt">,
>(items: T[]) {
  return [...items].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence
    }
    return (
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    )
  })
}

export function getConversationViewerParticipant(
  conversation: ChatConversationView | null | undefined,
  workspaceMemberId: string | null | undefined
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

export function getParticipantDisplayName(
  participant:
    | Pick<ChatParticipantSummary, "name" | "participantType">
    | undefined
) {
  const displayName =
    typeof participant?.name === "string" ? participant.name.trim() : ""

  if (displayName) {
    return displayName
  }

  switch (participant?.participantType) {
    case "actor":
      return "Actor"
    case "external":
      return "External"
    case "workspace_member":
      return "成员"
    default:
      return "系统"
  }
}

function getConversationPeerParticipant(
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

export function getConversationDisplayName(
  conversation: ChatConversationView,
  workspaceMemberId?: string | null
) {
  if (conversation.kind === "private") {
    const peer = getConversationPeerParticipant(conversation, workspaceMemberId)
    return getParticipantDisplayName(peer) || conversation.title || "聊天"
  }

  const title = conversation.title?.trim()
  if (title) {
    return title
  }

  return "群聊"
}

export function getConversationAvatarSpec(
  conversation: ChatConversationView,
  workspaceMemberId?: string | null
): {
  name: string
  uri?: string
  icon?: keyof typeof Feather.glyphMap
} {
  if (conversation.presentation?.avatarUrl) {
    return {
      name: getConversationDisplayName(conversation, workspaceMemberId),
      uri: conversation.presentation.avatarUrl,
    }
  }

  if (conversation.presentation?.avatarEmoji) {
    return {
      name: conversation.presentation.avatarEmoji,
    }
  }

  const peer = getConversationPeerParticipant(conversation, workspaceMemberId)
  const name = getConversationDisplayName(conversation, workspaceMemberId)

  if (peer?.avatarUrl) {
    return { name, uri: peer.avatarUrl }
  }
  if (peer?.avatarEmoji) {
    return { name: peer.avatarEmoji }
  }

  if (peer?.participantType === "actor") {
    return { name, icon: "cpu" }
  }
  if (peer?.participantType === "workspace_member") {
    return { name, icon: "user" }
  }
  if (peer?.participantType === "external") {
    return { name, icon: "globe" }
  }

  return { name, icon: "message-circle" }
}

export function buildPreviewTextFromItem(
  item: ChatConversationItem | undefined
) {
  if (!item) {
    return ""
  }

  const text = extractText(item.contentBlocks).trim()
  if (text) {
    return text
  }

  if (item.itemType === "event") {
    return summarizeConversationEvent(item.subtype, item.eventPayload)
  }

  if (item.itemType === "message") {
    return "Attachment"
  }

  return `[${item.subtype}]`
}

export function mergeChatItems(
  existing: ChatConversationItem[],
  incoming: ChatConversationItem[]
) {
  const byKey = new Map<string, ChatConversationItem>()

  for (const item of existing) {
    byKey.set(item.id, item)
  }

  for (const item of incoming) {
    byKey.set(item.id, item)
  }

  return sortChatItems([...byKey.values()])
}

export function upsertChatConversation(
  conversations: ChatConversationView[],
  incoming: ChatConversationView
) {
  const next = conversations.filter(
    (conversation) => conversation.conversationId !== incoming.conversationId
  )
  next.push(incoming)
  return sortChatConversations(next)
}

export function upsertChatConversations(
  conversations: ChatConversationView[],
  incoming: ChatConversationView[]
) {
  return incoming.reduce(upsertChatConversation, conversations)
}

export function getConversationMetaOrDefault(
  snapshot: ChatWorkspaceSnapshot,
  conversationId: string
): ChatConversationMeta {
  return (
    snapshot.metaByConversationId[conversationId] ?? {
      readWatermarkSequence: 0,
      hasMoreBefore: false,
      hasLoadedLatest: false,
      loadingLatest: false,
    }
  )
}

export function updateConversationInSnapshot(
  snapshot: ChatWorkspaceSnapshot,
  conversationId: string,
  updater: (conversation: ChatConversationView) => ChatConversationView
) {
  const current = snapshot.conversations.find(
    (conversation) => conversation.conversationId === conversationId
  )
  if (!current) {
    return snapshot
  }

  return {
    ...snapshot,
    conversations: upsertChatConversation(
      snapshot.conversations,
      updater(current)
    ),
  }
}

export function toPendingReadAdjustedUnreadCount(
  conversation: ChatConversationView,
  pendingRead?: PendingChatRead
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

export function buildOptimisticChatItem(
  outbox: PendingChatOutboxMessage,
  conversation: ChatConversationView | undefined,
  workspaceMemberId?: string | null
): MobileChatItem {
  const viewerParticipantId = getConversationViewerParticipant(
    conversation,
    workspaceMemberId
  )

  return {
    id: `local:${outbox.clientMessageId}`,
    conversationId: outbox.conversationId,
    sequence: outbox.optimisticSequence,
    clientMessageId: outbox.clientMessageId,
    itemType: "message",
    role: "user",
    subtype: "chat.message",
    scope: "shared",
    surface: "visible",
    authorParticipantId: viewerParticipantId?.participantId,
    author: viewerParticipantId
      ? {
          participantId: viewerParticipantId.participantId,
          participantType: viewerParticipantId.participantType,
          workspaceMemberId: viewerParticipantId.workspaceMemberId,
          actorId: viewerParticipantId.actorId,
          externalUserKey: viewerParticipantId.externalUserKey,
          transportAddressId: viewerParticipantId.transportAddressId,
          transportKind: viewerParticipantId.transportKind,
          name: viewerParticipantId.name,
          title: viewerParticipantId.title,
          role: viewerParticipantId.role,
          avatarUrl: viewerParticipantId.avatarUrl,
          avatarEmoji: viewerParticipantId.avatarEmoji,
        }
      : undefined,
    content: extractText(outbox.contentBlocks),
    contentBlocks: outbox.contentBlocks,
    replyToItemId: outbox.replyToItemId,
    replyTo: outbox.replyTo,
    metadata: {},
    createdAt: outbox.createdAt,
    localOnly: true,
    localDeliveryStatus: outbox.status,
    localErrorMessage: outbox.lastErrorMessage,
  }
}

function summarizeFileCategories(blocks: CanonicalContentBlock[]) {
  const files = blocks.filter(
    (block): block is Extract<CanonicalContentBlock, { type: "file_ref" }> =>
      block.type === "file_ref"
  )
  if (files.length === 0) {
    return ""
  }

  if (files.length === 1) {
    switch (files[0]!.category) {
      case "image":
        return "图片"
      case "video":
        return "视频"
      case "audio":
        return "语音"
      default:
        return files[0]!.originalName || "文件"
    }
  }

  return `${files.length} 个附件`
}

export function buildContentBlocksPreviewText(blocks: CanonicalContentBlock[]) {
  const text = extractText(blocks).trim()
  if (text) {
    return text
  }

  return summarizeFileCategories(blocks)
}

export function buildReplyPreviewText(
  reply:
    | Pick<
        ConversationReplyRef,
        "previewText" | "previewBlocks" | "subtype" | "isUnavailable"
      >
    | null
    | undefined
) {
  if (!reply) {
    return ""
  }

  if (reply.isUnavailable) {
    return "原消息不可用"
  }

  const previewText = reply.previewText.trim()
  if (previewText) {
    return previewText
  }

  const fallback = buildContentBlocksPreviewText(reply.previewBlocks)
  if (fallback) {
    return fallback
  }

  return reply.subtype ? `[${reply.subtype}]` : "消息"
}

export function participantToConversationEntityRef(
  participant: Pick<
    ChatParticipantSummary,
    | "participantId"
    | "participantType"
    | "workspaceMemberId"
    | "actorId"
    | "externalUserKey"
    | "transportAddressId"
    | "transportKind"
    | "name"
    | "title"
    | "role"
    | "avatarUrl"
    | "avatarEmoji"
  >
): ConversationEntityRef {
  return {
    participantId: participant.participantId,
    participantType: participant.participantType,
    workspaceMemberId: participant.workspaceMemberId,
    actorId: participant.actorId,
    externalUserKey: participant.externalUserKey,
    transportAddressId: participant.transportAddressId,
    transportKind: participant.transportKind,
    name: participant.name,
    title: participant.title,
    role: participant.role,
    avatarUrl: participant.avatarUrl,
    avatarEmoji: participant.avatarEmoji,
  }
}

export function getMentionableConversationParticipants(
  conversation: ChatConversationView | null | undefined,
  viewerParticipantId?: string
) {
  return (conversation?.participants ?? []).filter(
    (participant) =>
      participant.state === "active" &&
      participant.participantType !== "system" &&
      participant.participantId !== viewerParticipantId
  )
}

export function getMobileConversationItems(
  snapshot: ChatWorkspaceSnapshot,
  conversationId: string
): MobileChatItem[] {
  const conversation = snapshot.conversations.find(
    (entry) => entry.conversationId === conversationId
  )
  const confirmedItems = (
    snapshot.itemsByConversationId[conversationId] ?? []
  ).map<MobileChatItem>((item) => item)
  const optimisticItems = Object.values(snapshot.outbox)
    .filter((entry) => entry.conversationId === conversationId)
    .filter(
      (entry) =>
        !confirmedItems.some(
          (item) =>
            item.clientMessageId &&
            item.clientMessageId === entry.clientMessageId
        )
    )
    .map((entry) =>
      buildOptimisticChatItem(entry, conversation, snapshot.workspaceMemberId)
    )

  const merged = new Map<string, MobileChatItem>()
  for (const item of confirmedItems) {
    merged.set(item.id, item)
  }
  for (const item of optimisticItems) {
    merged.set(item.id, item)
  }

  return sortChatItems([...merged.values()])
}

export function getConfirmedConversationMaxSequence(
  items: Array<Pick<ChatConversationItem, "sequence"> & { localOnly?: boolean }>
) {
  return items.reduce((maxSequence, item) => {
    if (item.localOnly) {
      return maxSequence
    }
    return Math.max(maxSequence, Number(item.sequence || 0))
  }, 0)
}

export function getConversationParticipantMap(
  conversation: ChatConversationView | null | undefined
) {
  const map = new Map<string, ChatParticipantSummary>()
  for (const participant of conversation?.participants ?? []) {
    map.set(participant.participantId, participant)
  }
  return map
}

export function getEntityDisplayName(
  entity: Pick<ConversationEntityRef, "name" | "participantType"> | undefined
) {
  const name = typeof entity?.name === "string" ? entity.name.trim() : ""
  if (name) {
    return name
  }

  switch (entity?.participantType) {
    case "actor":
      return "Actor"
    case "external":
      return "External"
    case "workspace_member":
      return "成员"
    default:
      return "系统"
  }
}

export function getEntityAvatarSpec(
  entity:
    | Pick<
        ConversationEntityRef,
        "name" | "participantType" | "avatarUrl" | "avatarEmoji"
      >
    | undefined
) {
  if (entity?.avatarUrl) {
    return {
      name: getEntityDisplayName(entity),
      uri: entity.avatarUrl,
    }
  }

  if (entity?.avatarEmoji) {
    return {
      name: entity.avatarEmoji,
    }
  }

  const name = getEntityDisplayName(entity)
  switch (entity?.participantType) {
    case "actor":
      return { name, icon: "cpu" as const }
    case "external":
      return { name, icon: "globe" as const }
    case "workspace_member":
      return { name, icon: "user" as const }
    default:
      return { name, icon: "message-circle" as const }
  }
}
