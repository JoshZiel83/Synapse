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
  const members = getActiveConversationMembers(conversation);
  const actorCount = members.filter((member) => member.type === "actor").length;
  const userCount = members.filter((member) => member.type === "user").length;
  return (
    members.length > 2 ||
    actorCount > 1 ||
    userCount > 1 ||
    members.some((member) => member.type === "external")
  );
}

export function findDirectConversationForActor(
  conversations: ConversationSummaryView[],
  actorId: string,
) {
  return conversations.find((conversation) => {
    const members = getActiveConversationMembers(conversation);
    const actorCount = members.filter(
      (member) => member.type === "actor",
    ).length;
    const userCount = members.filter((member) => member.type === "user").length;
    return (
      conversationIncludesActor(conversation, actorId) &&
      actorCount === 1 &&
      userCount === 1 &&
      !members.some((member) => member.type === "external")
    );
  });
}

export function findConversationForUser(
  conversations: ConversationSummaryView[],
  userId: string,
) {
  return conversations.find((conversation) =>
    conversationIncludesUser(conversation, userId),
  );
}

export function conversationDisplayCount(
  members: ConversationParticipantView[],
) {
  return members.filter((member) => member.state !== "removed").length;
}
