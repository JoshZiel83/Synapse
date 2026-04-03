import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";

import { ConversationList } from "@/components/conversation-list";
import { MobileHeaderActions } from "@/components/mobile-header-actions";
import {
  Button,
  EmptyState,
  LoadingBlock,
  MobilePageHeader,
  ScreenView,
  SectionBlock,
} from "@/components/ui";
import { useWorkspaceWebSocket } from "@/hooks/use-workspace-websocket";
import { api } from "@/lib/api";
import {
  applyPendingConversationReadState,
  sortConversationSummaries,
} from "@/lib/conversations";
import { useScanLauncher } from "@/hooks/use-scan-launcher";
import { useWorkspace } from "@/providers/workspace-provider";
import type { ConversationSummaryView } from "@/types/api";
import type { ChatSocketEvent, ConversationFeedItem } from "@shared";

export default function ChatsTab() {
  const router = useRouter();
  const { openScan, permissionSheet } = useScanLauncher("relationship");
  const { workspaceId } = useWorkspace();
  const [conversations, setConversations] = useState<ConversationSummaryView[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unreadCount = conversations.reduce(
    (total, conversation) => total + conversation.unreadCount,
    0,
  );
  const headerTitle = unreadCount > 0 ? `消息(${unreadCount})` : "消息";

  const loadConversations = useCallback(
    async (isRefreshing = false) => {
      if (!workspaceId) {
        setConversations([]);
        setLoading(false);
        setRefreshing(false);
        return;
      }

      if (isRefreshing) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      try {
        const response = await api.getThreads(workspaceId);
        const syncedConversations = await applyPendingConversationReadState(
          response.conversations,
        );
        setConversations(sortConversationSummaries(syncedConversations));
        setError(null);
      } catch (nextError) {
        setError(
          nextError instanceof Error ? nextError.message : "加载聊天列表失败。",
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  const handleSocketEvent = useCallback(
    (event: ChatSocketEvent | Record<string, unknown>) => {
      if (!workspaceId || typeof event.type !== "string") {
        return;
      }

      switch (event.type) {
        case "conversation.item.created": {
          const payload = (event as ChatSocketEvent<"conversation.item.created">)
            .payload as ConversationFeedItem;
          if (payload.conversationId) {
            void loadConversations(true);
          }
          return;
        }
        case "conversation.updated":
        case "conversation.read.updated":
          void loadConversations(true);
          return;
        default:
          return;
      }
    },
    [loadConversations, workspaceId],
  );

  useWorkspaceWebSocket({
    workspaceId: workspaceId || undefined,
    enabled: Boolean(workspaceId),
    subscriptions: workspaceId
      ? [
          {
            key: `inbox:${workspaceId}`,
            topic: "inbox",
          },
        ]
      : [],
    onConnected: () => {
      void loadConversations(true);
    },
    onEvent: handleSocketEvent,
  });

  return (
    <ScreenView>
      <View style={styles.pageShell}>
        <View style={styles.headerGutter}>
          <MobilePageHeader
            title={headerTitle}
            action={
              <MobileHeaderActions
                onSearch={() => router.push("/search")}
                onStartGroup={() => router.push("/contacts/group/new")}
                onAddFriend={() => router.push("/contacts/add")}
                onScan={() => void openScan()}
              />
            }
          />
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void loadConversations(true)}
            />
          }
        >
          {loading ? (
            <SectionBlock>
              <LoadingBlock label="正在加载会话..." />
            </SectionBlock>
          ) : error ? (
            <SectionBlock>
              <EmptyState
                icon="alert-circle"
                title="会话加载失败"
                description={error}
                action={
                  <View style={styles.retryAction}>
                    <Button
                      label="重试"
                      icon="refresh-cw"
                      onPress={() => void loadConversations()}
                    />
                  </View>
                }
              />
            </SectionBlock>
          ) : conversations.length > 0 ? (
            <SectionBlock style={styles.listSection}>
              <ConversationList
                conversations={conversations}
                onPressConversation={(conversation) =>
                  router.push(`/chat/${conversation.id}`)
                }
              />
            </SectionBlock>
          ) : (
            <SectionBlock>
              <EmptyState
                icon="message-square"
                title="还没有任何聊天"
                description="去联系人页选一个数字员工，或从首页快捷创建新会话。"
              />
            </SectionBlock>
          )}
        </ScrollView>
      </View>
      {permissionSheet}
    </ScreenView>
  );
}

const styles = StyleSheet.create({
  pageShell: {
    flex: 1,
  },
  headerGutter: {
    paddingHorizontal: 18,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 18,
    paddingBottom: 128,
  },
  listSection: {
    borderTopWidth: 0,
    borderBottomWidth: 0,
    paddingVertical: 0,
    gap: 0,
  },
  retryAction: {
    marginTop: 10,
    width: "100%",
  },
});
