import Feather from "@expo/vector-icons/Feather"

import { isUuid } from "@/lib/ids"
import { isIsoInstant } from "@shared/datetime"
import {
  mergeChatItems,
  sortChatConversations,
  sortChatItems,
  upsertChatConversation,
  upsertChatConversations,
} from "@shared/chat-state"
import {
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_KIND,
  CONVERSATION_MESSAGE_SUBTYPE,
  CONVERSATION_PARTICIPANT_TYPE,
} from "@shared/constants"
import { extractText } from "@shared/content"
import { summarizeConversationEvent } from "@shared/conversation"
import { sanitizeQueueEntryCarrier } from "@shared/chat-queue"
import type {
  CanonicalContentBlock,
  ChatConversationItem,
  ChatConversationView,
  ConversationEntityRef,
  ConversationReplyRef,
  ChatParticipantSummary,
  PendingConversationRead,
  PendingOutboxMessage,
  Timestamp,
} from "@shared"

// Re-exported under the historical names used across the mobile codebase; the
// implementations now live in @synapse/shared/chat-state (shared with web).
export {
  mergeChatItems,
  sortChatConversations,
  sortChatItems,
  upsertChatConversation,
  upsertChatConversations,
}

export type LocalChatDeliveryStatus = "sending" | "retrying"

// Mobile's persisted queue piggy-backs on the shared chat-queue shapes
// so any change to PendingConversationRead / PendingOutboxMessage in
// shared lands on both clients without manual sync. The local aliases
// keep the historical naming used throughout the mobile codebase.
export type PendingChatRead = PendingConversationRead
export type PendingChatOutboxMessage = Omit<PendingOutboxMessage, "status"> & {
  status: LocalChatDeliveryStatus
}

export interface ChatConversationMeta {
  readWatermarkSequence: number
  hasMoreBefore: boolean
  hasLoadedLatest: boolean
  loadingLatest: boolean
  lastFetchedAt?: Timestamp
  latestLoadError?: string
}

export interface ChatWorkspaceSnapshot {
  version: 6
  workspaceId: string
  workspaceMemberId?: string
  clientInstanceId?: string
  inboxCursor: number
  lastBootstrappedAt?: Timestamp
  conversations: ChatConversationView[]
  itemsByConversationId: Record<string, ChatConversationItem[]>
  metaByConversationId: Record<string, ChatConversationMeta>
  pendingReads: Record<string, PendingChatRead>
  outbox: Record<string, PendingChatOutboxMessage>
  /** conversationId -> { conversationId, removedSeq }. See ConversationTombstone. */
  tombstones: Record<string, ConversationTombstone>
}

/**
 * Locally-recorded "removed at member_seq=removedSeq" marker. Prevents a stale
 * lower-seq conversation.upsert from resurrecting a conversation the member was
 * removed from (or pruned at bootstrap). Mirror of the web/shared tombstone.
 */
export interface ConversationTombstone {
  conversationId: string
  removedSeq: number
}

export interface ChatWorkspaceQueueState {
  version: 3
  workspaceId: string
  workspaceMemberId?: string
  clientInstanceId?: string
  inboxCursor: number
  lastBootstrappedAt?: Timestamp
  pendingReads: Record<string, PendingChatRead>
  outbox: Record<string, PendingChatOutboxMessage>
  tombstones: Record<string, ConversationTombstone>
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
    version: 6,
    workspaceId,
    inboxCursor: 0,
    conversations: [],
    itemsByConversationId: {},
    metaByConversationId: {},
    pendingReads: {},
    outbox: {},
    tombstones: {},
  }
}

export function createEmptyChatWorkspaceQueueState(
  workspaceId: string
): ChatWorkspaceQueueState {
  return {
    version: 3,
    workspaceId,
    inboxCursor: 0,
    pendingReads: {},
    outbox: {},
    tombstones: {},
  }
}

function readTimestamp(value: unknown): Timestamp | undefined {
  return typeof value === "string" && isIsoInstant(value) ? value : undefined
}

function normalizeTombstones(
  value: unknown
): Record<string, ConversationTombstone> {
  if (!value || typeof value !== "object") {
    return {}
  }
  return Object.fromEntries(
    Object.values(value as Record<string, unknown>)
      .filter((entry): entry is ConversationTombstone =>
        Boolean(
          entry &&
          typeof entry === "object" &&
          typeof (entry as { conversationId?: unknown }).conversationId ===
            "string" &&
          typeof (entry as { removedSeq?: unknown }).removedSeq === "number"
        )
      )
      .map((entry) => [entry.conversationId, entry] as const)
  )
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
      .map(
        (entry) =>
          [entry.conversationId, sanitizeQueueEntryCarrier(entry)] as const
      )
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
      .map(
        (entry) =>
          [entry.clientMessageId, sanitizeQueueEntryCarrier(entry)] as const
      )
  )
}

export function normalizeChatWorkspaceSnapshot(
  workspaceId: string,
  value: unknown
): ChatWorkspaceSnapshot {
  if (!value || typeof value !== "object") {
    return createEmptyChatWorkspaceSnapshot(workspaceId)
  }

  const snapshot = value as Partial<ChatWorkspaceSnapshot> & {
    version?: number
  }

  // Clean break: ONLY the current version is accepted. A cached snapshot from any
  // earlier version (including the pre-carrier v5) is wiped wholesale and the app
  // re-bootstraps — the no-back-compat mandate forbids dual-shape reads, and the
  // bump guarantees no outbox/read entry lacking the validated carrier is read.
  const version: number = snapshot.version ?? 0
  if (version !== 6 || snapshot.workspaceId !== workspaceId) {
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
    version: 6,
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
    lastBootstrappedAt: readTimestamp(snapshot.lastBootstrappedAt),
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
                  lastFetchedAt: readTimestamp(meta?.lastFetchedAt),
                } satisfies ChatConversationMeta,
              ])
          )
        : {},
    pendingReads: normalizePendingReads(
      snapshot.pendingReads,
      validConversationIds
    ),
    outbox: normalizeOutbox(snapshot.outbox, validConversationIds),
    tombstones: normalizeTombstones(snapshot.tombstones),
  }
}

export function normalizeChatWorkspaceQueueState(
  workspaceId: string,
  value: unknown
): ChatWorkspaceQueueState {
  if (!value || typeof value !== "object") {
    return createEmptyChatWorkspaceQueueState(workspaceId)
  }

  const queueState = value as Partial<ChatWorkspaceQueueState> & {
    version?: number
  }
  // Clean break: ONLY the current version is accepted; any earlier persisted
  // queue (including the pre-carrier v2) is wiped wholesale (no-back-compat).
  const version: number = queueState.version ?? 0
  if (version !== 3 || queueState.workspaceId !== workspaceId) {
    return createEmptyChatWorkspaceQueueState(workspaceId)
  }

  return {
    version: 3,
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
    lastBootstrappedAt: readTimestamp(queueState.lastBootstrappedAt),
    pendingReads: normalizePendingReads(queueState.pendingReads),
    outbox: normalizeOutbox(queueState.outbox),
    tombstones: normalizeTombstones(queueState.tombstones),
  }
}

export function toChatWorkspaceQueueState(
  snapshot: ChatWorkspaceSnapshot
): ChatWorkspaceQueueState {
  return {
    version: 3,
    workspaceId: snapshot.workspaceId,
    workspaceMemberId: snapshot.workspaceMemberId,
    clientInstanceId: snapshot.clientInstanceId,
    inboxCursor: snapshot.inboxCursor,
    lastBootstrappedAt: snapshot.lastBootstrappedAt,
    pendingReads: snapshot.pendingReads,
    outbox: snapshot.outbox,
    tombstones: snapshot.tombstones,
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
    tombstones: queueState.tombstones ?? snapshot.tombstones,
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

export function getConversationViewerParticipant(
  conversation: ChatConversationView | null | undefined,
  workspaceMemberId: string | null | undefined
) {
  if (!conversation || !workspaceMemberId) {
    return undefined
  }

  return conversation.participants.find(
    (participant) =>
      participant.participantType ===
        CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
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
    case CONVERSATION_PARTICIPANT_TYPE.ACTOR:
      return "Actor"
    case CONVERSATION_PARTICIPANT_TYPE.EXTERNAL:
      return "External"
    case CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER:
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
          participant.participantType ===
            CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
          participant.workspaceMemberId === workspaceMemberId
        )
    ) ?? conversation.participants[0]
  )
}

export function getConversationDisplayName(
  conversation: ChatConversationView,
  workspaceMemberId?: string | null
) {
  if (conversation.kind === CONVERSATION_KIND.DIRECT) {
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

  if (peer?.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR) {
    return { name, icon: "cpu" }
  }
  if (
    peer?.participantType === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER
  ) {
    return { name, icon: "user" }
  }
  if (peer?.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL) {
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

  if (item.itemType === CONVERSATION_ITEM_TYPE.EVENT) {
    return summarizeConversationEvent(item.subtype, item.eventPayload)
  }

  if (item.itemType === CONVERSATION_ITEM_TYPE.MESSAGE) {
    return "Attachment"
  }

  return `[${item.subtype}]`
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

/**
 * Remove a conversation and record a tombstone at removedSeq. Mirror of the
 * web/shared helper: also purges the conversation's items/meta/pendingReads/
 * outbox so nothing keeps POSTing to a conversation the member was removed from.
 */
export function pruneConversationFromSnapshot(
  snapshot: ChatWorkspaceSnapshot,
  conversationId: string,
  removedSeq: number
): ChatWorkspaceSnapshot {
  const itemsByConversationId = { ...snapshot.itemsByConversationId }
  delete itemsByConversationId[conversationId]
  const metaByConversationId = { ...snapshot.metaByConversationId }
  delete metaByConversationId[conversationId]
  const pendingReads = { ...snapshot.pendingReads }
  delete pendingReads[conversationId]
  const outbox = Object.fromEntries(
    Object.entries(snapshot.outbox).filter(
      ([, entry]) => entry.conversationId !== conversationId
    )
  )
  const existing = snapshot.tombstones[conversationId]
  return {
    ...snapshot,
    conversations: snapshot.conversations.filter(
      (conversation) => conversation.conversationId !== conversationId
    ),
    itemsByConversationId,
    metaByConversationId,
    pendingReads,
    outbox,
    tombstones: {
      ...snapshot.tombstones,
      [conversationId]: {
        conversationId,
        removedSeq: Math.max(removedSeq, existing?.removedSeq ?? 0),
      },
    },
  }
}

export function clearConversationTombstone(
  snapshot: ChatWorkspaceSnapshot,
  conversationId: string,
  memberSeq?: number
): ChatWorkspaceSnapshot {
  const tombstone = snapshot.tombstones[conversationId]
  if (!tombstone) {
    return snapshot
  }
  // Seq-guarded: a stale {active} (memberSeq <= removedSeq) must not clear a
  // newer kick tombstone. undefined memberSeq (bootstrap liveness) clears
  // unconditionally — bootstrap is the authoritative current set.
  if (typeof memberSeq === "number" && memberSeq <= tombstone.removedSeq) {
    return snapshot
  }
  const tombstones = { ...snapshot.tombstones }
  delete tombstones[conversationId]
  return { ...snapshot, tombstones }
}

/**
 * Upsert a conversation unless a live frame is stale relative to a tombstone
 * (memberSeq <= removedSeq). Returns the snapshot unchanged when guarded.
 */
export function upsertConversationWithTombstoneGuard(
  snapshot: ChatWorkspaceSnapshot,
  incoming: ChatConversationView,
  memberSeq?: number
): ChatWorkspaceSnapshot {
  const tombstone = snapshot.tombstones[incoming.conversationId]
  if (
    tombstone &&
    typeof memberSeq === "number" &&
    memberSeq <= tombstone.removedSeq
  ) {
    return snapshot
  }
  return {
    ...snapshot,
    conversations: upsertChatConversation(snapshot.conversations, incoming),
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
    itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
    role: "user",
    subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
    scope: CONVERSATION_ITEM_SCOPE.SHARED,
    surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
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
        return files[0]!.name || "文件"
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
    case CONVERSATION_PARTICIPANT_TYPE.ACTOR:
      return "Actor"
    case CONVERSATION_PARTICIPANT_TYPE.EXTERNAL:
      return "External"
    case CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER:
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
    case CONVERSATION_PARTICIPANT_TYPE.ACTOR:
      return { name, icon: "cpu" as const }
    case CONVERSATION_PARTICIPANT_TYPE.EXTERNAL:
      return { name, icon: "globe" as const }
    case CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER:
      return { name, icon: "user" as const }
    default:
      return { name, icon: "message-circle" as const }
  }
}
