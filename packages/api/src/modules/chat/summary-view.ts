import {
  CONVERSATION_KIND,
  CONVERSATION_PARTICIPANT_STATE,
  CONVERSATION_PARTICIPANT_TYPE,
  CONVERSATION_STATUS,
  isTransportKind,
} from "@synapse/shared"
import type { Timestamp, TransportKind } from "@synapse/shared"
import { assertIsoInstant } from "@synapse/shared/datetime"
import { getFileUrlById } from "../files/service.js"
import { listConversationParticipants } from "./service.js"

type ConversationParticipantRow = Awaited<
  ReturnType<typeof listConversationParticipants>
>[number]

type ConversationSummaryRow = {
  id: string
  kind: "direct" | "group"
  is_im?: boolean | null
  isIm?: boolean | null
  transport_kind?: string | null
  title?: string | null
  avatar_url?: string | null
  last_message?: string | null
  last_message_sender_type?: string | null
  last_message_sender_name?: string | null
  lastMessageAt?: Timestamp | null
  unread_count?: number | null
  createdAt: Timestamp
}

function asOptionalTransportKind(
  value: string | null | undefined
): TransportKind | undefined {
  if (!value) return undefined
  if (isTransportKind(value)) return value
  throw new Error(`Unexpected conversation transport kind: ${value}`)
}

export function mapConversationParticipant(row: ConversationParticipantRow) {
  if (row.remoteAgentId) {
    return {
      participantId: row.id,
      participantType: CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT,
      remoteAgentId: row.remoteAgentId,
      id: row.remoteAgentId,
      name: row.participantName || "Remote Agent",
      title: row.participantTitle || undefined,
      role: row.participantRole || "remote_agent",
      avatarEmoji: row.participantAvatarEmoji || undefined,
      avatarUrl: row.participantAvatarFileId
        ? getFileUrlById(row.participantAvatarFileId)
        : undefined,
      state: row.state,
    }
  }

  if (row.actorId) {
    return {
      participantId: row.id,
      participantType: CONVERSATION_PARTICIPANT_TYPE.ACTOR,
      actorId: row.actorId,
      id: row.actorId,
      name: row.participantName || "Unknown",
      title: row.participantTitle || undefined,
      role: row.participantRole || "specialist",
      avatarEmoji: row.participantAvatarEmoji || undefined,
      avatarUrl: row.participantAvatarFileId
        ? getFileUrlById(row.participantAvatarFileId)
        : undefined,
      state: row.state,
    }
  }

  if (row.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL) {
    return {
      participantId: row.id,
      participantType: CONVERSATION_PARTICIPANT_TYPE.EXTERNAL,
      id: row.id,
      name:
        row.transportDisplayName || row.displayName || "External participant",
      state: row.state,
    }
  }

  return {
    participantId: row.id,
    participantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
    workspaceMemberId: row.workspaceMemberId || undefined,
    id: row.workspaceMemberId || undefined,
    name: row.userName || "User",
    avatarUrl: row.userAvatarFileId
      ? getFileUrlById(row.userAvatarFileId)
      : undefined,
    conversationRole: row.roleKey || undefined,
    state: row.state,
  }
}

function buildConversationPresentation(params: {
  row: ConversationSummaryRow
  participants: ReturnType<typeof mapConversationParticipant>[]
  viewerWorkspaceMemberId: string
  canManageConversation: boolean
  canManageParticipants: boolean
}) {
  const {
    row,
    participants,
    viewerWorkspaceMemberId,
    canManageConversation,
    canManageParticipants,
  } = params
  const activeParticipants = participants.filter(
    (participant) => participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE
  )
  const peer =
    row.kind === CONVERSATION_KIND.DIRECT
      ? activeParticipants.find(
          (participant) =>
            !(
              participant.participantType ===
                CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
              participant.workspaceMemberId === viewerWorkspaceMemberId
            )
        ) || activeParticipants[0]
      : undefined

  const directPeerNames =
    row.kind === CONVERSATION_KIND.DIRECT
      ? activeParticipants
          .filter(
            (participant) =>
              !(
                participant.participantType ===
                  CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
                participant.workspaceMemberId === viewerWorkspaceMemberId
              )
          )
          .map((participant) => participant.name)
          .filter(Boolean)
      : []

  const title =
    row.kind === CONVERSATION_KIND.DIRECT && directPeerNames.length > 0
      ? directPeerNames.join(", ")
      : row.title ||
        activeParticipants
          .map((participant) => participant.name)
          .filter(Boolean)
          .join(", ") ||
        row.last_message?.substring(0, 100) ||
        "Untitled thread"

  const chatType =
    row.kind === CONVERSATION_KIND.DIRECT
      ? ("direct" as const)
      : ("group" as const)
  const isIm = Boolean(row.is_im ?? row.isIm)
  const canRename =
    row.kind !== CONVERSATION_KIND.DIRECT && canManageConversation
  const canManageConversationParticipants =
    row.kind !== CONVERSATION_KIND.DIRECT && canManageParticipants

  const isDirect = row.kind === CONVERSATION_KIND.DIRECT
  return {
    chatType,
    title,
    avatarUrl:
      row.kind === CONVERSATION_KIND.DIRECT
        ? peer?.avatarUrl
        : row.avatar_url || undefined,
    subtitle: isIm
      ? isDirect
        ? "IM direct chat"
        : "IM group chat"
      : isDirect
        ? "Direct message"
        : "Group chat",
    peer,
    canRename,
    canManageParticipants: canManageConversationParticipants,
  }
}

export async function mapConversationSummaryView(
  row: ConversationSummaryRow,
  viewer: string | { workspaceMemberId: string }
) {
  const viewerWorkspaceMemberId =
    typeof viewer === "string" ? viewer : viewer.workspaceMemberId
  const conversationParticipants = (
    await listConversationParticipants(row.id)
  ).filter(
    (participant) => participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE
  )
  const mappedParticipants = conversationParticipants.map(
    mapConversationParticipant
  )
  const actorParticipants = mappedParticipants.filter(
    (participant) =>
      participant.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
  )
  const hasOpenLane = conversationParticipants.some(
    (participant) =>
      participant.actorId && participant.sessionStatus !== "closed"
  )
  const viewerMembership = conversationParticipants.find(
    (participant) =>
      participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE &&
      participant.participantType ===
        CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
      participant.workspaceMemberId === viewerWorkspaceMemberId
  )
  const viewerConversationRole =
    viewerMembership?.roleKey === "owner" ||
    viewerMembership?.roleKey === "admin" ||
    viewerMembership?.roleKey === "member"
      ? viewerMembership.roleKey
      : "member"
  const canManageConversation =
    row.kind !== CONVERSATION_KIND.DIRECT &&
    (viewerConversationRole === "owner" || viewerConversationRole === "admin")
  const canManageParticipants = canManageConversation
  const presentation = buildConversationPresentation({
    row,
    participants: mappedParticipants,
    viewerWorkspaceMemberId,
    canManageConversation,
    canManageParticipants,
  })

  return {
    id: row.id,
    kind: row.kind,
    isIm: Boolean(row.is_im ?? row.isIm),
    status: hasOpenLane
      ? CONVERSATION_STATUS.ACTIVE
      : CONVERSATION_STATUS.COMPLETED,
    transportKind: asOptionalTransportKind(row.transport_kind),
    participants: mappedParticipants,
    members: mappedParticipants,
    actorParticipants,
    lastMessage:
      row.last_message && row.lastMessageAt
        ? {
            content: row.last_message,
            role:
              row.last_message_sender_type === "user"
                ? ("user" as const)
                : ("assistant" as const),
            actorName: row.last_message_sender_name || undefined,
            createdAt: assertIsoInstant(row.lastMessageAt),
          }
        : undefined,
    unreadCount: row.unread_count || 0,
    createdAt: assertIsoInstant(row.createdAt),
    title: presentation.title,
    name: presentation.title,
    avatarUrl: presentation.avatarUrl,
    presentation,
    permissions: {
      canManage: canManageConversation,
      canManageParticipants: presentation.canManageParticipants,
    },
    viewerParticipantId: viewerMembership?.id,
    viewerWorkspaceMemberId,
  }
}
