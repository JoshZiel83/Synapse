import type { ConversationFeedItem } from "@shared";

import type {
  ConversationParticipantView,
  ConversationSummaryView,
} from "@/types/api";

export function sortConversationItems(items: ConversationFeedItem[]) {
  return [...items].sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
    return (
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    );
  });
}

export function getActiveConversationMembers(
  conversation: ConversationSummaryView,
) {
  return conversation.members.filter((member) => member.state !== "removed");
}

export function conversationIncludesActor(
  conversation: ConversationSummaryView,
  actorId: string,
) {
  return getActiveConversationMembers(conversation).some(
    (member) => member.type === "actor" && member.actorId === actorId,
  );
}

export function conversationIncludesUser(
  conversation: ConversationSummaryView,
  userId: string,
) {
  return getActiveConversationMembers(conversation).some(
    (member) => member.type === "user" && member.userId === userId,
  );
}

export function isGroupConversation(conversation: ConversationSummaryView) {
  return conversation.kind === "group";
}

export function conversationBoundaryLabel(
  conversation: Pick<ConversationSummaryView, "boundary">,
) {
  return conversation.boundary === "external" ? "外部" : "内部";
}

export function conversationKindLabel(
  conversation: Pick<ConversationSummaryView, "kind">,
) {
  switch (conversation.kind) {
    case "private":
      return "单聊";
    case "group":
      return "群聊";
    default:
      return "会话";
  }
}

export function conversationScopeLabel(
  conversation: Pick<ConversationSummaryView, "boundary" | "kind">,
) {
  return `${conversationBoundaryLabel(conversation)}${conversationKindLabel(conversation)}`;
}

function findPrivateConversationForActor(
  conversations: ConversationSummaryView[],
  actorId: string,
) {
  return conversations.find((conversation) => {
    return (
      conversation.kind === "private" &&
      conversationIncludesActor(conversation, actorId) &&
      !getActiveConversationMembers(conversation).some(
        (member) => member.type === "external",
      )
    );
  });
}

function findPrivateConversationForUser(
  conversations: ConversationSummaryView[],
  userId: string,
) {
  return conversations.find(
    (conversation) =>
      conversation.kind === "private" &&
      conversationIncludesUser(conversation, userId),
  );
}

export function findPrivateWorkspaceConversationForActor(
  conversations: ConversationSummaryView[],
  actorId: string,
) {
  return findPrivateConversationForActor(conversations, actorId);
}

export function findPrivateSocialConversationForActor(
  conversations: ConversationSummaryView[],
  actorId: string,
) {
  return conversations.find(
    (conversation) =>
      conversation.boundary === "external" &&
      conversation.kind === "private" &&
      conversationIncludesActor(conversation, actorId),
  );
}

export function findPrivateWorkspaceConversationForUser(
  conversations: ConversationSummaryView[],
  userId: string,
) {
  return findPrivateConversationForUser(conversations, userId);
}

export function findPrivateSocialConversationForUser(
  conversations: ConversationSummaryView[],
  userId: string,
) {
  return conversations.find(
    (conversation) =>
      conversation.boundary === "external" &&
      conversation.kind === "private" &&
      conversationIncludesUser(conversation, userId),
  );
}

export function conversationDisplayCount(
  members: ConversationParticipantView[],
) {
  return members.filter((member) => member.state !== "removed").length;
}
