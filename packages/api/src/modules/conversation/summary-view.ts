import { getFileUrl } from "../../infrastructure/storage/index.js";
import { getFileUrlById } from "../files/service.js";
import { getConversationMembers } from "./chat-service.js";

export function mapConversationMember(row: any) {
  if (row.actor_id) {
    return {
      memberId: row.id,
      participantId: row.id,
      type: "actor" as const,
      actorId: row.actor_id,
      id: row.actor_id,
      name: row.actor_name || "Unknown",
      title: row.actor_title || undefined,
      role: row.actor_role || "specialist",
      emoji: row.actor_avatar_emoji || undefined,
      avatarUrl: row.actor_avatar_stored_name
        ? getFileUrl(row.actor_avatar_stored_name)
        : undefined,
      state: row.state,
    };
  }

  if (row.member_type === "external") {
    return {
      memberId: row.id,
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
    memberId: row.id,
    participantId: row.id,
    type: "user" as const,
    workspaceMemberId: row.workspace_member_id || undefined,
    userId: row.user_id,
    id: row.user_id,
    name: row.user_name || "User",
    avatarUrl: row.user_avatar_file_id
      ? getFileUrlById(row.user_avatar_file_id)
      : undefined,
    conversationRole: row.role || undefined,
    state: row.state,
  };
}

function buildConversationPresentation(params: {
  row: any;
  members: ReturnType<typeof mapConversationMember>[];
  viewerUserId: string;
  viewerWorkspaceMemberId?: string;
  canManageConversation: boolean;
  canManageMembers: boolean;
}) {
  const {
    row,
    members,
    viewerUserId,
    viewerWorkspaceMemberId,
    canManageConversation,
    canManageMembers,
  } = params;
  const activeMembers = members.filter((member) => member.state === "active");
  const peer =
    row.kind === "private"
      ? activeMembers.find(
          (member) =>
            !(
              member.type === "user" &&
              ((viewerWorkspaceMemberId &&
                member.workspaceMemberId === viewerWorkspaceMemberId) ||
                (!viewerWorkspaceMemberId && member.userId === viewerUserId))
            ),
        ) || activeMembers[0]
      : undefined;

  const directPeerNames =
    row.kind === "private"
      ? activeMembers
          .filter(
            (member) =>
              !(
                member.type === "user" &&
                ((viewerWorkspaceMemberId &&
                  member.workspaceMemberId === viewerWorkspaceMemberId) ||
                  (!viewerWorkspaceMemberId && member.userId === viewerUserId))
              ),
          )
          .map((member) => member.name)
          .filter(Boolean)
      : [];

  const title =
    row.kind === "private" && directPeerNames.length > 0
      ? directPeerNames.join(", ")
      : row.title ||
        activeMembers
          .map((member) => member.name)
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
  const canManageConversationMembers = row.kind !== "private" && canManageMembers;

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
    canManageMembers: canManageConversationMembers,
  };
}

export async function mapConversationSummaryView(
  row: any,
  viewer:
    | string
    | {
        userId: string;
        workspaceMemberId?: string;
      },
) {
  const viewerUserId = typeof viewer === "string" ? viewer : viewer.userId;
  const viewerWorkspaceMemberId =
    typeof viewer === "string" ? undefined : viewer.workspaceMemberId;
  const members = (await getConversationMembers(row.id)).filter(
    (member: any) => member.state === "active",
  );
  const mappedMembers = members.map(mapConversationMember);
  const participants = mappedMembers.filter(
    (member: any) => member.type === "actor",
  );
  const hasOpenLane = members.some(
    (member: any) => member.actor_id && member.session_status !== "closed",
  );
  const viewerMembership = members.find(
    (member: any) =>
      member.state === "active" &&
      member.member_type === "user" &&
      ((viewerWorkspaceMemberId &&
        member.workspace_member_id === viewerWorkspaceMemberId) ||
        (!viewerWorkspaceMemberId && member.user_id === viewerUserId)),
  );
  const viewerConversationRole =
    viewerMembership?.role === "owner" ||
    viewerMembership?.role === "admin" ||
    viewerMembership?.role === "member"
      ? viewerMembership.role
      : "member";
  const canManageConversation =
    row.kind !== "private" &&
    (viewerConversationRole === "owner" || viewerConversationRole === "admin");
  const canManageMembers = canManageConversation;
  const presentation = buildConversationPresentation({
    row,
    members: mappedMembers,
    viewerUserId,
    viewerWorkspaceMemberId,
    canManageConversation,
    canManageMembers,
  });

  return {
    id: row.id,
    kind: row.kind,
    boundary: row.boundary,
    status: hasOpenLane ? "active" : "completed",
    transportKind: row.transport_kind || undefined,
    participants,
    members: mappedMembers,
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
      canManageMembers: presentation.canManageMembers,
    },
    viewerParticipantId: viewerMembership?.id,
    viewerWorkspaceMemberId,
  };
}
