import Feather from "@expo/vector-icons/Feather";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { ChatComposer } from "@/components/chat-composer";
import { MessageItem } from "@/components/message-item";
import { Avatar, EmptyState, LoadingBlock, ScreenView } from "@/components/ui";
import { useWorkspaceWebSocket } from "@/hooks/use-workspace-websocket";
import { api } from "@/lib/api";
import { sortConversationItems } from "@/lib/conversations";
import { createId } from "@/lib/ids";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type {
  ConversationMemberListResponse,
  ConversationParticipantView,
  ConversationSummaryView,
} from "@/types/api";
import type { ConversationFeedItem } from "@shared";

function mergeConversationItem(
  items: ConversationFeedItem[],
  incoming: ConversationFeedItem,
) {
  if (items.some((item) => item.itemId === incoming.itemId)) {
    return items;
  }
  return sortConversationItems([...items, incoming]);
}

export default function ChatDetailScreen() {
  const router = useRouter();
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const { workspaceId } = useWorkspace();
  const scrollRef = useRef<ScrollView | null>(null);
  const [messages, setMessages] = useState<ConversationFeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [conversation, setConversation] =
    useState<ConversationSummaryView | null>(null);
  const [members, setMembers] = useState<ConversationParticipantView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const canRender = workspaceId && conversationId;

  const applyConversationMeta = useCallback(
    (
      nextConversation: ConversationSummaryView | null,
      nextMembers?: ConversationMemberListResponse["members"],
    ) => {
      setConversation(nextConversation);
      if (nextMembers) {
        setMembers(nextMembers);
      }
    },
    [],
  );

  const loadConversation = useCallback(
    async (isRefreshing = false) => {
      if (!conversationId) {
        setLoading(false);
        return;
      }

      if (isRefreshing) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      try {
        const [messagesResponse, threadResponse, membersResponse] =
          await Promise.all([
            api.getConversationMessages(workspaceId || "", conversationId, 100),
            api.getThread(conversationId),
            api.getConversationMembers(workspaceId || "", conversationId),
          ]);

        applyConversationMeta(
          (threadResponse.thread as ConversationSummaryView | null) ?? null,
          membersResponse.members,
        );
        setMessages(sortConversationItems(messagesResponse.items));
        setError(null);
        await api.markConversationRead(workspaceId || "", conversationId).catch(
          () => undefined,
        );
      } catch (nextError) {
        setError(
          nextError instanceof Error ? nextError.message : "聊天记录加载失败。",
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [applyConversationMeta, conversationId, workspaceId],
  );

  useEffect(() => {
    void loadConversation();
  }, [loadConversation]);

  useEffect(() => {
    if (!loading) {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollToEnd({ animated: false });
      });
    }
  }, [loading, messages.length]);

  const handleSocketEvent = useCallback(
    (event: Record<string, unknown>) => {
      if (!conversationId || !workspaceId || typeof event.type !== "string") {
        return;
      }

      switch (event.type) {
        case "feed.item.created": {
          const payload = event.payload as {
            item: ConversationFeedItem;
          };
          if (payload.item.conversationId !== conversationId) {
            return;
          }

          setMessages((current) =>
            mergeConversationItem(current, payload.item),
          );
          void api
            .markConversationRead(workspaceId, conversationId)
            .catch(() => undefined);
          return;
        }
        case "conversation.updated": {
          const payload = event.payload as {
            conversationId: string;
            title?: string | null;
            avatarUrl?: string | null;
          };
          if (payload.conversationId !== conversationId) {
            return;
          }

          setConversation((current) =>
            current
              ? {
                  ...current,
                  title:
                    typeof payload.title === "string" && payload.title.trim()
                      ? payload.title
                      : current.title,
                  avatarUrl:
                    payload.avatarUrl === undefined
                      ? current.avatarUrl
                      : payload.avatarUrl || undefined,
                }
              : current,
          );
          return;
        }
        case "runtime.updated":
        case "interaction.updated": {
          const payload = event.payload as { conversationId: string };
          if (payload.conversationId === conversationId) {
            void loadConversation(true);
          }
          return;
        }
        default:
          return;
      }
    },
    [conversationId, loadConversation, workspaceId],
  );

  useWorkspaceWebSocket({
    workspaceId: workspaceId ?? null,
    enabled: Boolean(canRender && conversation?.domain !== "social"),
    onConnected: () => {
      void loadConversation(true);
    },
    onEvent: handleSocketEvent,
    onGap: () => {
      void loadConversation(true);
    },
  });

  useEffect(() => {
    if (!conversationId || conversation?.domain !== "social") {
      return;
    }

    const timer = setInterval(() => {
      void loadConversation(true);
    }, 5000);

    return () => clearInterval(timer);
  }, [conversation?.domain, conversationId, loadConversation]);

  async function handleSendMessage(contentBlocks: any[]) {
    if (!conversationId) return;

    const clientMessageId = createId("message");
    const response = await api.sendConversationMessage(
      workspaceId || "",
      conversationId,
      contentBlocks,
      clientMessageId,
    );
    setMessages((current) => mergeConversationItem(current, response.item));
    await api
      .markConversationRead(workspaceId || "", conversationId)
      .catch(() => undefined);
  }

  const messageNodes = useMemo(
    () => messages.map((item) => <MessageItem key={item.itemId} item={item} />),
    [messages],
  );

  if (!canRender) {
    return (
      <ScreenView>
        <EmptyState
          icon="message-square"
          title="当前无法打开会话"
          description="请先进入一个有效工作区，再从聊天列表选择具体会话。"
        />
      </ScreenView>
    );
  }

  return (
    <ScreenView>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 10 : 0}
      >
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.headerButton}>
            <Feather name="chevron-left" size={20} color={theme.colors.text} />
          </Pressable>
          <View style={styles.headerCenter}>
            <Avatar
              name={conversation?.title || "聊天"}
              uri={conversation?.avatarUrl}
              size={36}
              icon="message-circle"
            />
            <View style={styles.headerText}>
              <Text numberOfLines={1} style={styles.headerTitle}>
                {conversation?.title || "聊天"}
              </Text>
              <Text style={styles.headerSubtitle}>
                {conversation
                  ? `${conversation.domain === "social" ? "Social" : "Workspace"} · ${
                      conversation.kind === "private" ? "私聊" : "群聊"
                    }`
                  : members.length > 0
                    ? `${members.length} 位成员`
                    : "实时同步中"}
              </Text>
            </View>
          </View>
          <Pressable
            onPress={() =>
              router.push({
                pathname: "/conversations/[conversationId]/details",
                params: { conversationId },
              })
            }
            style={styles.headerButton}
          >
            <Feather
              name="more-horizontal"
              size={18}
              color={theme.colors.text}
            />
          </Pressable>
        </View>

        {loading ? (
          <View style={styles.placeholder}>
            <LoadingBlock label="正在加载聊天记录..." />
          </View>
        ) : error ? (
          <View style={styles.placeholder}>
            <EmptyState
              icon="alert-circle"
              title="聊天记录加载失败"
              description={error}
            />
          </View>
        ) : (
          <>
            <ScrollView
              ref={scrollRef}
              style={styles.messages}
              contentContainerStyle={styles.messagesContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => void loadConversation(true)}
                />
              }
            >
              {messageNodes.length > 0 ? (
                messageNodes
              ) : (
                <EmptyState
                  icon="message-circle"
                  title="会话还没有消息"
                  description="发送第一条文字或附件，让这个会话真正开始。"
                />
              )}
            </ScrollView>
            <ChatComposer
              workspaceId={workspaceId}
              onSend={handleSendMessage}
            />
          </>
        )}
      </KeyboardAvoidingView>
    </ScreenView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  headerButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: theme.colors.surfaceMuted,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  headerCenter: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: theme.colors.text,
  },
  headerSubtitle: {
    fontSize: 12,
    color: theme.colors.textSoft,
  },
  placeholder: {
    flex: 1,
    paddingHorizontal: 18,
    justifyContent: "center",
  },
  messages: {
    flex: 1,
    backgroundColor: theme.colors.backgroundAlt,
  },
  messagesContent: {
    paddingHorizontal: 14,
    paddingTop: 18,
    paddingBottom: 18,
    gap: 14,
  },
});
