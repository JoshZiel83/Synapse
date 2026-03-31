import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { RefreshControl, StyleSheet, Text, View } from "react-native";

import { ConversationItem } from "@/components/conversation-item";
import { MobileHeaderActions } from "@/components/mobile-header-actions";
import {
  Button,
  EmptyState,
  LoadingBlock,
  MobilePageHeader,
  ScreenScroll,
  SectionBlock,
  SectionTitleRow,
} from "@/components/ui";
import { useWorkspaceWebSocket } from "@/hooks/use-workspace-websocket";
import { api } from "@/lib/api";
import { listPendingConversationReads } from "@/lib/chat-sync";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type { ConversationSummaryView } from "@/types/api";
import type { ChatSocketEvent, ConversationFeedItem } from "@shared";

function sortConversations(conversations: ConversationSummaryView[]) {
  return [...conversations].sort((left, right) => {
    const leftAt = left.lastMessage?.createdAt || left.createdAt;
    const rightAt = right.lastMessage?.createdAt || right.createdAt;
    return new Date(rightAt).getTime() - new Date(leftAt).getTime();
  });
}

async function applyLocalReadState(
  conversations: ConversationSummaryView[],
) {
  const pendingReads = await listPendingConversationReads();
  const pendingConversationIds = new Set(
    pendingReads.map((entry) => entry.conversationId),
  );

  return conversations.map((conversation) =>
    pendingConversationIds.has(conversation.id)
      ? { ...conversation, unreadCount: 0 }
      : conversation,
  );
}

export default function ChatsTab() {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const [conversations, setConversations] = useState<ConversationSummaryView[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        const syncedConversations = await applyLocalReadState(
          response.conversations,
        );
        setConversations(sortConversations(syncedConversations));
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
    enabled: Boolean(workspaceId),
    subscriptions: workspaceId
      ? [
          {
            key: `inbox:${workspaceId}`,
            topic: "inbox",
            workspaceId,
          },
        ]
      : [],
    onConnected: () => {
      void loadConversations(true);
    },
    onEvent: handleSocketEvent,
  });

  return (
    <ScreenScroll
      topPadding={0}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void loadConversations(true)}
        />
      }
    >
      <MobilePageHeader
        title="聊天"
        action={
          <MobileHeaderActions
            onSearch={() => router.push("/search")}
            onStartGroup={() => router.push("/contacts/group/new")}
            onAddFriend={() => router.push("/contacts/add")}
            onScan={() => router.push("/scan?intent=relationship")}
          />
        }
      />

      <SectionBlock>
        <SectionTitleRow title="会话列表" />
        <Text style={styles.headerCopy}>
          联系人页可直接新建对话；点进任意会话后，首期已支持文字、图片、语音、拍照和录像发送。
        </Text>
        <Button
          label="去联系人页发起新会话"
          icon="users"
          variant="secondary"
          onPress={() => router.push("/contacts")}
        />
      </SectionBlock>

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
        <SectionBlock>
          <SectionTitleRow
            title="最近消息"
            action={
              <Text style={styles.countText}>
                {conversations.length} 个会话
              </Text>
            }
          />
          <View style={styles.listShell}>
            {conversations.map((conversation) => (
              <ConversationItem
                key={conversation.id}
                conversation={conversation}
                onPress={() => router.push(`/chat/${conversation.id}`)}
              />
            ))}
          </View>
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
    </ScreenScroll>
  );
}

const styles = StyleSheet.create({
  headerCopy: {
    fontSize: 14,
    lineHeight: 21,
    color: theme.colors.textMuted,
  },
  retryAction: {
    marginTop: 10,
    width: "100%",
  },
  countText: {
    fontSize: 12,
    color: theme.colors.textSoft,
  },
  listShell: {
    marginTop: 2,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
});
