import { getFileUrl } from "../../infrastructure/storage/index.js";
import { getFileUrlById } from "../files/service.js";
import {
  authorizeAction,
  userSubject,
} from "../access/service.js";
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
    userId: row.user_id,
    id: row.user_id,
    name: row.user_name || "User",
    avatarUrl: row.user_avatar_file_id
      ? getFileUrlById(row.user_avatar_file_id)
      : undefined,
    state: row.state,
  };
}

function buildConversationPresentation(params: {
  row: any;
  members: ReturnType<typeof mapConversationMember>[];
  userId: string;
  canManage: boolean;
  canManageMembers: boolean;
}) {
  const { row, members, userId, canManage, canManageMembers } = params;
  const activeMembers = members.filter((member) => member.state === "active");
  const peer =
    row.kind === "private"
      ? activeMembers.find(
          (member) =>
            !(member.type === "user" && member.userId === userId),
        ) || activeMembers[0]
      : undefined;

  const directPeerNames =
    row.kind === "private"
      ? activeMembers
          .filter(
            (member) =>
              !(member.type === "user" && member.userId === userId),
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
  const canRename =
    row.kind !== "private" && Boolean(row.workspace_id) && canManage;
  const canManageConversationMembers =
    row.kind !== "private" &&
    Boolean(row.workspace_id) &&
    canManageMembers;

  return {
    chatType,
    title,
    avatarUrl:
      row.kind === "private"
        ? peer?.avatarUrl
        : row.avatar_url || undefined,
    subtitle:
      row.kind === "private"
        ? row.domain === "social"
          ? "Friend direct chat"
          : "Direct chat"
        : row.domain === "social"
          ? "Social group"
          : "Workspace group",
    peer,
    canRename,
    canManageMembers: canManageConversationMembers,
    scope: row.domain,
  };
}

export async function mapConversationSummaryView(row: any, userId: string) {
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
  const [canManage, canManageMembers] = await Promise.all([
    authorizeAction({
      subject: userSubject(userId),
      action: "conversation.manage",
      resourceId: row.id,
    }),
    authorizeAction({
      subject: userSubject(userId),
      action: "conversation.manage_members",
      resourceId: row.id,
    }),
  ]);
  const presentation = buildConversationPresentation({
    row,
    members: mappedMembers,
    userId,
    canManage,
    canManageMembers,
  });

  return {
    id: row.id,
    domain: row.domain,
    kind: row.kind,
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
      canManage: presentation.canRename,
      canManageMembers: presentation.canManageMembers,
    },
  };
}
