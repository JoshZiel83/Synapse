import { type ReactElement } from "react"
import { StyleSheet, View, type RefreshControlProps } from "react-native"
import { FlashList } from "@shopify/flash-list"

import { ConversationItem } from "@/components/conversation-item"
import { theme } from "@/theme/tokens"
import type { ChatConversationView, PendingConversationRead } from "@shared"

interface ConversationListProps {
  conversations: ChatConversationView[]
  workspaceMemberId?: string | null
  pendingReads?: Record<string, PendingConversationRead>
  onPressConversation: (conversation: ChatConversationView) => void
  maxItems?: number
  showDividers?: boolean
}

/**
 * Capped, non-scrolling variant (e.g. home "recent conversations" with
 * maxItems=3). Renders a plain stack so it composes inside a parent ScrollView.
 * Virtualization is pointless for a handful of items.
 */
function CappedConversationList({
  conversations,
  workspaceMemberId,
  pendingReads,
  onPressConversation,
  maxItems,
  showDividers = false,
}: ConversationListProps & { maxItems: number }) {
  const visible = conversations.slice(0, Math.max(maxItems, 0))
  return (
    <View style={styles.list}>
      {visible.map((conversation) => (
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
  )
}

/**
 * Full inbox list. Uses FlashList (recycling virtualization) and OWNS the scroll
 * — its parent must NOT wrap it in a ScrollView. Pass header/empty/refresh in.
 */
export function ConversationListView({
  conversations,
  workspaceMemberId,
  pendingReads,
  onPressConversation,
  showDividers = false,
  ListHeaderComponent,
  ListEmptyComponent,
  refreshControl,
  contentContainerStyle,
}: ConversationListProps & {
  ListHeaderComponent?: ReactElement | null
  ListEmptyComponent?: ReactElement | null
  refreshControl?: ReactElement<RefreshControlProps>
  contentContainerStyle?: { paddingHorizontal?: number; paddingBottom?: number }
}) {
  return (
    <FlashList
      data={conversations}
      keyExtractor={(conversation) => conversation.conversationId}
      renderItem={({ item }) => (
        <ConversationItem
          conversation={item}
          workspaceMemberId={workspaceMemberId}
          pendingRead={pendingReads?.[item.conversationId]}
          showDivider={showDividers}
          onPress={() => onPressConversation(item)}
        />
      )}
      ListHeaderComponent={ListHeaderComponent}
      ListEmptyComponent={ListEmptyComponent}
      refreshControl={refreshControl}
      contentContainerStyle={contentContainerStyle}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    />
  )
}

/**
 * Back-compat entry point. With `maxItems` -> capped non-scrolling stack (home);
 * otherwise the FlashList inbox. Existing call-sites that passed maxItems keep
 * working unchanged.
 */
export function ConversationList(props: ConversationListProps) {
  if (typeof props.maxItems === "number") {
    return <CappedConversationList {...props} maxItems={props.maxItems} />
  }
  return <ConversationListView {...props} />
}

const styles = StyleSheet.create({
  list: {
    marginTop: 2,
  },
})
