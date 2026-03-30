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

function findPrivateConversationForActor(
  conversations: ConversationSummaryView[],
  actorId: string,
  domain?: "workspace" | "social",
) {
  return conversations.find((conversation) => {
    return (
      conversation.kind === "private" &&
      (!domain || conversation.domain === domain) &&
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
  domain?: "workspace" | "social",
) {
  return conversations.find(
    (conversation) =>
      conversation.kind === "private" &&
      (!domain || conversation.domain === domain) &&
      conversationIncludesUser(conversation, userId),
  );
}

export function findDirectConversationForActor(
  conversations: ConversationSummaryView[],
  actorId: string,
) {
  return findPrivateConversationForActor(conversations, actorId, "workspace");
}

export function findSocialConversationForActor(
  conversations: ConversationSummaryView[],
  actorId: string,
) {
  return findPrivateConversationForActor(conversations, actorId, "social");
}

export function findConversationForUser(
  conversations: ConversationSummaryView[],
  userId: string,
) {
  return findPrivateConversationForUser(conversations, userId, "workspace");
}

export function findSocialConversationForUser(
  conversations: ConversationSummaryView[],
  userId: string,
) {
  return findPrivateConversationForUser(conversations, userId, "social");
}

export function conversationDisplayCount(
  members: ConversationParticipantView[],
) {
  return members.filter((member) => member.state !== "removed").length;
}
