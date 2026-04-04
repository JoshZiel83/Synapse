import { StyleSheet, View } from "react-native";

import { ConversationItem } from "@/components/conversation-item";
import type { PendingChatRead } from "@/lib/chat-data";
import { theme } from "@/theme/tokens";
import type { ChatConversationView } from "@shared";

export function ConversationList({
  conversations,
  workspaceMemberId,
  pendingReads,
  onPressConversation,
  maxItems,
  showDividers = false,
}: {
  conversations: ChatConversationView[];
  workspaceMemberId?: string | null;
  pendingReads?: Record<string, PendingChatRead>;
  onPressConversation: (conversation: ChatConversationView) => void;
  maxItems?: number;
  showDividers?: boolean;
}) {
  const visibleConversations =
    typeof maxItems === "number"
      ? conversations.slice(0, Math.max(maxItems, 0))
      : conversations;

  return (
    <View style={styles.list}>
      {visibleConversations.map((conversation) => (
        <ConversationItem
          key={conversation.conversationId}
          conversation={conversation}
          workspaceMemberId={workspaceMemberId}
          pendingRead={pendingReads?.[conversation.conversationId]}
          showDivider={showDividers}
          onPress={() => onPressConversation(conversation)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    marginTop: 2,
  },
});
