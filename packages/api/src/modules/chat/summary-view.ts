import {
  CONVERSATION_BOUNDARY,
  CONVERSATION_KIND,
  CONVERSATION_PARTICIPANT_TYPE,
} from "@synapse/shared"
import { getFileUrlById } from "../files/service.js"
import { listConversationParticipants } from "./service.js"

export function mapConversationParticipant(row: any) {
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
    id: row.workspace_member_id,
    name: row.user_name || "User",
    avatarUrl: row.user_avatar_file_id
      ? getFileUrlById(row.user_avatar_file_id)
      : undefined,
    conversationRole: row.role_key || undefined,
    state: row.state,
  }
}

function buildConversationPresentation(params: {
  row: any
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
    row.kind === CONVERSATION_KIND.PRIVATE
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
    row.kind === CONVERSATION_KIND.PRIVATE
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
    row.kind === CONVERSATION_KIND.PRIVATE && directPeerNames.length > 0
      ? directPeerNames.join(", ")
      : row.title ||
        activeParticipants
          .map((participant) => participant.name)
          .filter(Boolean)
          .join(", ") ||
        row.last_message?.substring(0, 100) ||
        "Untitled thread"

  const chatType =
    row.kind === CONVERSATION_KIND.PRIVATE
      ? ("direct" as const)
      : row.kind === CONVERSATION_KIND.GROUP
        ? ("group" as const)
        : ("virtual" as const)
  const boundaryLabel =
    row.boundary === CONVERSATION_BOUNDARY.EXTERNAL ? "External" : "Internal"
  const canRename =
    row.kind !== CONVERSATION_KIND.PRIVATE && canManageConversation
  const canManageConversationParticipants =
    row.kind !== CONVERSATION_KIND.PRIVATE && canManageParticipants

  return {
    chatType,
    title,
    avatarUrl:
      row.kind === CONVERSATION_KIND.PRIVATE
        ? peer?.avatarUrl
        : row.avatar_url || undefined,
    subtitle:
      row.kind === CONVERSATION_KIND.PRIVATE
        ? `${boundaryLabel} direct chat`
        : `${boundaryLabel} group chat`,
    peer,
    canRename,
    canManageParticipants: canManageConversationParticipants,
  }
}

export async function mapConversationSummaryView(
  row: any,
  viewer: string | { workspaceMemberId: string }
) {
  const viewerWorkspaceMemberId =
    typeof viewer === "string" ? viewer : viewer.workspaceMemberId
  const conversationParticipants = (
    await listConversationParticipants(row.id)
  ).filter((participant: any) => participant.state === "active")
  const mappedParticipants = conversationParticipants.map(
    mapConversationParticipant
  )
  const actorParticipants = mappedParticipants.filter(
    (participant: any) =>
      participant.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
  )
  const hasOpenLane = conversationParticipants.some(
    (participant: any) =>
      participant.actor_id && participant.session_status !== "closed"
  )
  const viewerMembership = conversationParticipants.find(
    (participant: any) =>
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
    row.kind !== CONVERSATION_KIND.PRIVATE &&
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
    boundary: row.boundary,
    status: hasOpenLane ? ("active" as const) : ("completed" as const),
    transportKind: row.transport_kind || undefined,
    participants: mappedParticipants,
    members: mappedParticipants,
    actorParticipants,
    lastMessage: row.last_message
      ? {
          content: row.last_message,
          role:
            row.last_message_sender_type === "user"
              ? ("user" as const)
              : ("assistant" as const),
          actorName: row.last_message_sender_name,
          createdAt: row.last_message_at,
        }
      : undefined,
    unreadCount: row.unread_count || 0,
    createdAt: row.created_at,
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
