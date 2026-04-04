import { getFileUrlById } from "../files/service.js";
import { listConversationParticipants } from "./service.js";

export function mapConversationParticipant(row: any) {
  if (row.actor_id) {
    return {
      participantId: row.id,
      type: "actor" as const,
      actorId: row.actor_id,
      id: row.actor_id,
      name: row.actor_name || "Unknown",
      title: row.actor_title || undefined,
      role: row.actor_role || "specialist",
      emoji: row.actor_avatar_emoji || undefined,
      avatarUrl: row.actor_avatar_file_id
        ? getFileUrlById(row.actor_avatar_file_id)
        : undefined,
      state: row.state,
    };
  }

  if (row.participant_kind === "external") {
    return {
      participantId: row.id,
      type: "external" as const,
      id: row.id,
      name:
        row.transport_display_name ||
        row.display_name ||
        "External participant",
      state: row.state,
    };
  }

  return {
    participantId: row.id,
    type: "workspace_member" as const,
    workspaceMemberId: row.workspace_member_id || undefined,
    id: row.workspace_member_id,
    name: row.user_name || "User",
    avatarUrl: row.user_avatar_file_id
      ? getFileUrlById(row.user_avatar_file_id)
      : undefined,
    conversationRole: row.role_key || undefined,
    state: row.state,
  };
}

function buildConversationPresentation(params: {
  row: any;
  participants: ReturnType<typeof mapConversationParticipant>[];
  viewerWorkspaceMemberId: string;
  canManageConversation: boolean;
  canManageParticipants: boolean;
}) {
  const {
    row,
    participants,
    viewerWorkspaceMemberId,
    canManageConversation,
    canManageParticipants,
  } = params;
  const activeParticipants = participants.filter(
    (participant) => participant.state === "active",
  );
  const peer =
    row.kind === "private"
      ? activeParticipants.find(
          (participant) =>
            !(
              participant.type === "workspace_member" &&
              participant.workspaceMemberId === viewerWorkspaceMemberId
            ),
        ) || activeParticipants[0]
      : undefined;

  const directPeerNames =
    row.kind === "private"
      ? activeParticipants
          .filter(
            (participant) =>
              !(
                participant.type === "workspace_member" &&
                participant.workspaceMemberId === viewerWorkspaceMemberId
              ),
          )
          .map((participant) => participant.name)
          .filter(Boolean)
      : [];

  const title =
    row.kind === "private" && directPeerNames.length > 0
      ? directPeerNames.join(", ")
      : row.title ||
        activeParticipants
          .map((participant) => participant.name)
          .filter(Boolean)
          .join(", ") ||
        row.last_message?.substring(0, 100) ||
        "Untitled thread";

  const chatType =
    row.kind === "private"
      ? "direct"
      : row.kind === "group"
        ? "group"
        : "virtual";
  const boundaryLabel = row.boundary === "external" ? "External" : "Internal";
  const canRename = row.kind !== "private" && canManageConversation;
  const canManageConversationParticipants =
    row.kind !== "private" && canManageParticipants;

  return {
    chatType,
    title,
    avatarUrl:
      row.kind === "private"
        ? peer?.avatarUrl
        : row.avatar_url || undefined,
    subtitle:
      row.kind === "private"
        ? `${boundaryLabel} direct chat`
        : `${boundaryLabel} group chat`,
    peer,
    canRename,
    canManageParticipants: canManageConversationParticipants,
  };
}

export async function mapConversationSummaryView(
  row: any,
  viewer: string | { workspaceMemberId: string },
) {
  const viewerWorkspaceMemberId =
    typeof viewer === "string" ? viewer : viewer.workspaceMemberId;
  const conversationParticipants = (await listConversationParticipants(row.id)).filter(
    (participant: any) => participant.state === "active",
  );
  const mappedParticipants = conversationParticipants.map(mapConversationParticipant);
  const actorParticipants = mappedParticipants.filter(
    (participant: any) => participant.type === "actor",
  );
  const hasOpenLane = conversationParticipants.some(
    (participant: any) =>
      participant.actor_id && participant.session_status !== "closed",
  );
  const viewerMembership = conversationParticipants.find(
    (participant: any) =>
      participant.state === "active" &&
      participant.participant_kind === "workspace_member" &&
      participant.workspace_member_id === viewerWorkspaceMemberId,
  );
  const viewerConversationRole =
    viewerMembership?.role_key === "owner" ||
    viewerMembership?.role_key === "admin" ||
    viewerMembership?.role_key === "member"
      ? viewerMembership.role_key
      : "member";
  const canManageConversation =
    row.kind !== "private" &&
    (viewerConversationRole === "owner" || viewerConversationRole === "admin");
  const canManageParticipants = canManageConversation;
  const presentation = buildConversationPresentation({
    row,
    participants: mappedParticipants,
    viewerWorkspaceMemberId,
    canManageConversation,
    canManageParticipants,
  });

  return {
    id: row.id,
    kind: row.kind,
    boundary: row.boundary,
    status: hasOpenLane ? "active" : "completed",
    transportKind: row.transport_kind || undefined,
    participants: mappedParticipants,
    actorParticipants,
    lastMessage: row.last_message
      ? {
          content: row.last_message,
          role:
            row.last_message_sender_type === "user"
              ? "user"
              : "assistant",
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
  };
}
