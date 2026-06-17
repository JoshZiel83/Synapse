// chat/presenter.ts — DTO/wire-shaping helpers for the chat module.
//
// presenter.ts is neither a service nor a controller, so it is the layer that
// is permitted to call serializeInstant / serializeOptionalInstant (see
// packages/api/scripts/guard-layering.mjs r3). service.ts shapes timestamps via
// the thin wrappers below instead of touching the infra serializers directly.
//
// This file must not import generated/db or use Kysely table-row types; it
// takes row values structurally.

import {
  CONVERSATION_KIND,
  CONVERSATION_STATUS,
  CONVERSATION_KINDS,
  CONVERSATION_PARTICIPANT_STATE,
  CONVERSATION_PARTICIPANT_TYPE,
  type ChatConversationMessagesPage,
  type ChatParticipantSummary,
  ChatBootstrapResponse,
  ChatClientInstanceRegistrationResponse,
  ChatConversationCreateResponse,
  ChatConversationItem,
  ChatConversationReadWatermarkResponse,
  ChatConversationSendMessageResponse,
  ChatConversationView,
  ChatSyncEvent,
  type ConversationFeedItemSubtype,
  type ConversationParticipantRoleKey,
  Timestamp,
} from "@synapse/shared"
import type { ChatSyncViewSchemaType } from "@synapse/shared/schemas"
import {
  serializeInstant,
  serializeOptionalInstant,
  type IsoInstantString,
} from "../../infrastructure/datetime.js"
import { canManageConversationRole } from "./roles.js"

type ConversationKind = (typeof CONVERSATION_KINDS)[number]

export type ChatClientInstanceRegistrationRecord = {
  clientInstanceId: string
  workspaceMemberId: string
}

type ChatConversationRoleRecord = ConversationParticipantRoleKey

type ChatConversationLastItemRecord = {
  itemId: string
  sequence: number
  itemType: ChatConversationItem["itemType"]
  subtype: ConversationFeedItemSubtype
  previewText: string
  authorParticipantId?: string
  author?: ChatConversationItem["author"]
  createdAt: Timestamp
}

export type ChatConversationRecord = {
  conversationId: string
  workspaceId: string
  baseTitle: string | null
  kind: ConversationKind
  isIm: boolean
  unreadCount: number
  muted: boolean
  archived: boolean
  pinnedSortKey?: Date
  updatedAt: Date
  createdAt: Date
  participants: ChatParticipantSummary[]
  viewerWorkspaceMemberId: string
  viewerParticipantId?: string
  viewerConversationRole: ChatConversationRoleRecord
  lastItem?: ChatConversationLastItemRecord
}

export type ChatConversationListRecord = {
  workspaceMemberId: string
  conversations: ChatConversationRecord[]
}

export type ChatConversationEnvelopeRecord = {
  conversation: ChatConversationRecord
}

export type ChatConversationCreateRecord = {
  conversation: ChatConversationRecord
}

export type ChatBootstrapRecord = {
  workspaceMemberId: string
  clientInstanceRequired: true
  conversations: ChatConversationRecord[]
  nextInboxCursor: number
}

export type ChatSyncRecord = {
  events: ChatSyncEvent[]
  nextCursor: number
  hasMore: boolean
}

export type ChatConversationSendMessageRecord = {
  item: ChatConversationItem
}

export type ChatConversationReadWatermarkRecord = {
  conversationId: string
  workspaceMemberId: string
  participantId: string
  readWatermarkSequence: number
  lastReadAt: Timestamp
}

export type ChatConversationMessagesRecord = Omit<
  ChatConversationMessagesPage,
  "conversation"
> & {
  conversation: ChatConversationRecord
}

function computeConversationTitle(params: {
  baseTitle: string | null
  kind: ConversationKind
  participants: ChatParticipantSummary[]
  viewerWorkspaceMemberId: string
}): string {
  const baseTitle =
    typeof params.baseTitle === "string" ? params.baseTitle.trim() : ""
  if (baseTitle) {
    return baseTitle
  }

  const active = params.participants.filter(
    (participant) => participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE
  )
  const labels =
    params.kind === CONVERSATION_KIND.DIRECT
      ? active
          .filter(
            (participant) =>
              !(
                participant.participantType ===
                  CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
                participant.workspaceMemberId === params.viewerWorkspaceMemberId
              )
          )
          .map((participant) => participant.name)
      : active.map((participant) => participant.name)

  const uniqueLabels = [...new Set(labels.filter(Boolean))]
  if (uniqueLabels.length === 0) {
    return params.kind === CONVERSATION_KIND.DIRECT
      ? "Direct message"
      : "Untitled conversation"
  }
  if (uniqueLabels.length <= 3) {
    return uniqueLabels.join(", ")
  }
  return `${uniqueLabels.slice(0, 3).join(", ")} +${uniqueLabels.length - 3}`
}

function buildConversationPresentation(record: ChatConversationRecord) {
  const activeParticipants = record.participants.filter(
    (participant) => participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE
  )
  const peer =
    record.kind === CONVERSATION_KIND.DIRECT
      ? (activeParticipants.find(
          (participant) =>
            !(
              participant.participantType ===
                CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
              participant.workspaceMemberId === record.viewerWorkspaceMemberId
            )
        ) ?? activeParticipants[0])
      : undefined
  const avatarParticipants =
    record.kind === CONVERSATION_KIND.DIRECT
      ? peer
        ? [peer]
        : activeParticipants.slice(0, 1)
      : activeParticipants.slice(0, 4)
  const isDirect = record.kind === CONVERSATION_KIND.DIRECT

  return {
    chatType: isDirect ? "direct" : "group",
    subtitle: record.isIm
      ? isDirect
        ? "IM direct chat"
        : "IM group chat"
      : isDirect
        ? "Direct message"
        : "Group chat",
    avatarParticipantIds: avatarParticipants.map(
      (participant) => participant.participantId
    ),
    peerParticipantId: peer?.participantId,
    avatarUrl: peer?.avatarUrl,
    avatarEmoji: peer?.avatarEmoji,
  } satisfies ChatConversationView["presentation"]
}

export function presentChatConversationRecord(
  record: ChatConversationRecord
): ChatConversationView {
  const canManageConversation =
    record.kind !== CONVERSATION_KIND.DIRECT &&
    canManageConversationRole(record.viewerConversationRole)
  const canRename =
    record.kind !== CONVERSATION_KIND.DIRECT && canManageConversation
  const status = record.participants.some(
    (participant) =>
      participant.actorId && participant.sessionStatus !== "closed"
  )
    ? CONVERSATION_STATUS.ACTIVE
    : CONVERSATION_STATUS.COMPLETED

  return {
    conversationId: record.conversationId,
    workspaceId: record.workspaceId,
    title: computeConversationTitle(record),
    kind: record.kind,
    isIm: record.isIm,
    status,
    unreadCount: record.unreadCount,
    muted: record.muted,
    archived: record.archived,
    pinnedSortKey: record.pinnedSortKey
      ? presentInstant(record.pinnedSortKey)
      : undefined,
    updatedAt: presentInstant(record.updatedAt),
    createdAt: presentInstant(record.createdAt),
    participants: record.participants,
    presentation: buildConversationPresentation(record),
    permissions: {
      canManageConversation,
      canManageParticipants: canManageConversation,
      canRename,
    },
    viewerParticipantId: record.viewerParticipantId,
    lastItem: record.lastItem,
  }
}

export function presentChatClientInstanceRegistration(
  record: ChatClientInstanceRegistrationRecord
): ChatClientInstanceRegistrationResponse {
  return {
    clientInstanceId: record.clientInstanceId,
    workspaceMemberId: record.workspaceMemberId,
  }
}

export function presentChatConversationEnvelope(
  record: ChatConversationEnvelopeRecord
): ChatConversationCreateResponse {
  return {
    conversation: presentChatConversationRecord(record.conversation),
  }
}

export function presentChatConversationCreate(
  record: ChatConversationCreateRecord
): ChatConversationCreateResponse {
  return presentChatConversationEnvelope(record)
}

export function presentChatBootstrap(
  record: ChatBootstrapRecord
): ChatBootstrapResponse {
  return {
    workspaceMemberId: record.workspaceMemberId,
    clientInstanceRequired: record.clientInstanceRequired,
    conversations: record.conversations.map(presentChatConversationRecord),
    nextInboxCursor: record.nextInboxCursor,
  }
}

export function presentChatConversationList(
  record: ChatConversationListRecord
) {
  return {
    workspaceMemberId: record.workspaceMemberId,
    conversations: record.conversations.map(presentChatConversationRecord),
  }
}

export function presentChatSync(
  record: ChatSyncRecord
): ChatSyncViewSchemaType {
  return {
    events: record.events as ChatSyncViewSchemaType["events"],
    nextCursor: record.nextCursor,
    hasMore: record.hasMore,
  }
}

export function presentChatConversationMessages(
  record: ChatConversationMessagesRecord
): ChatConversationMessagesPage {
  return {
    ...record,
    conversation: presentChatConversationRecord(record.conversation),
  }
}

export function presentChatConversationSendMessage(
  record: ChatConversationSendMessageRecord
): ChatConversationSendMessageResponse {
  return {
    item: record.item,
  }
}

export function presentChatConversationReadWatermark(
  record: ChatConversationReadWatermarkRecord
): ChatConversationReadWatermarkResponse {
  return {
    conversationId: record.conversationId,
    workspaceMemberId: record.workspaceMemberId,
    participantId: record.participantId,
    readWatermarkSequence: record.readWatermarkSequence,
    lastReadAt: record.lastReadAt,
  }
}

/** Present a stored instant as an ISO timestamp for the wire DTO. */
export function presentInstant(value: Date): IsoInstantString {
  return serializeInstant(value)
}

/** Present a nullable stored instant as an optional ISO timestamp. */
export function presentOptionalInstant(
  value: Date | null | undefined
): IsoInstantString | undefined {
  return serializeOptionalInstant(value)
}
