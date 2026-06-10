import {
  CONVERSATION_KIND,
  CONVERSATION_PARTICIPANT_TYPE,
} from "@synapse/shared"
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
  last_message_at?: string | null
  unread_count?: number | null
  created_at: string
}

export function mapConversationParticipant(row: ConversationParticipantRow) {
  if (row.remote_agent_id) {
    return {
      participantId: row.id,
      participantType: CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT,
      remoteAgentId: row.remote_agent_id,
      id: row.remote_agent_id,
      name: row.participant_name || "Remote Agent",
      title: row.participant_title || undefined,
      role: row.participant_role || "remote_agent",
      avatarEmoji: row.participant_avatar_emoji || undefined,
      avatarUrl: row.participant_avatar_file_id
        ? getFileUrlById(row.participant_avatar_file_id)
        : undefined,
      state: row.state,
    }
  }

  if (row.actor_id) {
    return {
      participantId: row.id,
      participantType: CONVERSATION_PARTICIPANT_TYPE.ACTOR,
      actorId: row.actor_id,
      id: row.actor_id,
      name: row.participant_name || "Unknown",
      title: row.participant_title || undefined,
      role: row.participant_role || "specialist",
      avatarEmoji: row.participant_avatar_emoji || undefined,
      avatarUrl: row.participant_avatar_file_id
        ? getFileUrlById(row.participant_avatar_file_id)
        : undefined,
      state: row.state,
    }
  }

  if (row.participant_type === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL) {
    return {
      participantId: row.id,
      participantType: CONVERSATION_PARTICIPANT_TYPE.EXTERNAL,
      id: row.id,
      name:
        row.transport_display_name ||
        row.display_name ||
        "External participant",
      state: row.state,
    }
  }

  return {
    participantId: row.id,
    participantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
    workspaceMemberId: row.workspace_member_id || undefined,
    id: row.workspace_member_id || undefined,
    name: row.user_name || "User",
    avatarUrl: row.user_avatar_file_id
      ? getFileUrlById(row.user_avatar_file_id)
      : undefined,
    conversationRole: row.role_key || undefined,
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
    (participant) => participant.state === "active"
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
  ).filter((participant) => participant.state === "active")
  const mappedParticipants = conversationParticipants.map(
    mapConversationParticipant
  )
  const actorParticipants = mappedParticipants.filter(
    (participant) =>
      participant.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
  )
  const hasOpenLane = conversationParticipants.some(
    (participant) =>
      participant.actor_id && participant.session_status !== "closed"
  )
  const viewerMembership = conversationParticipants.find(
    (participant) =>
      participant.state === "active" &&
      participant.participant_type === "workspace_member" &&
      participant.workspace_member_id === viewerWorkspaceMemberId
  )
  const viewerConversationRole =
    viewerMembership?.role_key === "owner" ||
    viewerMembership?.role_key === "admin" ||
    viewerMembership?.role_key === "member"
      ? viewerMembership.role_key
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
    status: hasOpenLane ? ("active" as const) : ("completed" as const),
    transportKind: row.transport_kind || undefined,
    participants: mappedParticipants,
    members: mappedParticipants,
    actorParticipants,
    lastMessage:
      row.last_message && row.last_message_at
        ? {
            content: row.last_message,
            role:
              row.last_message_sender_type === "user"
                ? ("user" as const)
                : ("assistant" as const),
            actorName: row.last_message_sender_name || undefined,
            createdAt: assertIsoInstant(row.last_message_at),
          }
        : undefined,
    unreadCount: row.unread_count || 0,
    createdAt: assertIsoInstant(row.created_at),
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
