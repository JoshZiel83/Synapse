import { StyleSheet, View } from "react-native";

import { ConversationItem } from "@/components/conversation-item";
import { theme } from "@/theme/tokens";
import type { ConversationSummaryView } from "@/types/api";

export function ConversationList({
  conversations,
  onPressConversation,
  maxItems,
  showDividers = false,
}: {
  conversations: ConversationSummaryView[];
  onPressConversation: (conversation: ConversationSummaryView) => void;
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
          key={conversation.id}
          conversation={conversation}
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
