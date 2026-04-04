import type { ConversationEntityRef } from "@shared";

type MentionSelectionListener = (mention: ConversationEntityRef) => void;

const listenersByConversationId = new Map<string, Set<MentionSelectionListener>>();

export function publishMentionSelection(
  conversationId: string,
  mention: ConversationEntityRef,
) {
  const listeners = listenersByConversationId.get(conversationId);
  if (!listeners) {
    return;
  }

  for (const listener of listeners) {
    listener(mention);
  }
}

export function subscribeMentionSelection(
  conversationId: string,
  listener: MentionSelectionListener,
) {
  const listeners = listenersByConversationId.get(conversationId) ?? new Set();
  listeners.add(listener);
  listenersByConversationId.set(conversationId, listeners);

  return () => {
    const current = listenersByConversationId.get(conversationId);
    if (!current) {
      return;
    }

    current.delete(listener);
    if (current.size === 0) {
      listenersByConversationId.delete(conversationId);
    }
  };
}
