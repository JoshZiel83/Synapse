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
import {
  clearPendingConversationMessage,
  clearPendingConversationRead,
  flushPendingConversationMessages,
  flushPendingConversationReads,
  listPendingConversationMessages,
  pendingConversationMessageToFeedItem,
  queuePendingConversationMessage,
  queuePendingConversationRead,
  type PendingConversationMessage,
} from "@/lib/chat-sync";
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
  const sameItemIndex = items.findIndex((item) => item.itemId === incoming.itemId);
  if (sameItemIndex >= 0) {
    const next = [...items];
    next[sameItemIndex] = incoming;
    return sortConversationItems(next);
  }

  if (incoming.kind === "message" && incoming.clientMessageId) {
    const sameClientMessageIndex = items.findIndex(
      (item) =>
        item.kind === "message" &&
        item.clientMessageId === incoming.clientMessageId,
    );
    if (sameClientMessageIndex >= 0) {
      const existing = items[sameClientMessageIndex];
      const existingIsTemp = String(existing.itemId).startsWith("temp:");
      const incomingIsTemp = String(incoming.itemId).startsWith("temp:");
      if (!existingIsTemp && incomingIsTemp) {
        return items;
      }
      const next = [...items];
      next[sameClientMessageIndex] = incoming;
      return sortConversationItems(next);
    }
  }

  return sortConversationItems([...items, incoming]);
}

function mergePendingMessages(
  items: ConversationFeedItem[],
  pendingMessages: PendingConversationMessage[],
) {
  return pendingMessages.reduce(
    (current, entry) =>
      mergeConversationItem(current, pendingConversationMessageToFeedItem(entry)),
    items,
  );
}

function applyDeliveredItems(
  items: ConversationFeedItem[],
  deliveredItems: ConversationFeedItem[],
) {
  return deliveredItems.reduce(
    (current, item) => mergeConversationItem(current, item),
    items,
  );
}

export default function ChatDetailScreen() {
  const router = useRouter();
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const { workspaceId } = useWorkspace();
  const scrollRef = useRef<ScrollView | null>(null);
  const lastReportedReadRef = useRef<string>("");
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [messages, setMessages] = useState<ConversationFeedItem[]>([]);
  const [pendingMessages, setPendingMessages] = useState<
    PendingConversationMessage[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [conversation, setConversation] =
    useState<ConversationSummaryView | null>(null);
  const [members, setMembers] = useState<ConversationParticipantView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const canRender = workspaceId && conversationId;

  const refreshPendingMessages = useCallback(async () => {
    if (!conversationId) {
      setPendingMessages([]);
      return [];
    }

    const nextPendingMessages = await listPendingConversationMessages(
      conversationId,
    );
    setPendingMessages(nextPendingMessages);
    return nextPendingMessages;
  }, [conversationId]);

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
      if (!workspaceId) {
        setLoading(false);
        return;
      }

      if (isRefreshing) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      try {
        const nextPendingMessages = await listPendingConversationMessages(
          conversationId,
        );
        const [messagesResponse, threadResponse, membersResponse] =
          await Promise.all([
            api.getThreadMessages(workspaceId, conversationId, 100),
            api.getThread(workspaceId, conversationId),
            api.getThreadMembers(workspaceId, conversationId),
          ]);

        applyConversationMeta(
          (threadResponse.conversation as ConversationSummaryView | null) ??
            null,
          membersResponse.members,
        );
        setPendingMessages(nextPendingMessages);
        setMessages(
          mergePendingMessages(
            sortConversationItems(messagesResponse.items),
            nextPendingMessages,
          ),
        );
        setError(null);
        void flushPendingConversationReads();
        void flushPendingConversationMessages({ conversationId }).then(
          (deliveredItems) => {
            const deliveredForConversation = deliveredItems.filter(
              (item) => item.conversationId === conversationId,
            );
            if (deliveredForConversation.length > 0) {
              setMessages((current) =>
                applyDeliveredItems(current, deliveredForConversation),
              );
            }
            void refreshPendingMessages();
          },
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

  const scheduleConversationRefresh = useCallback(() => {
    if (refreshTimerRef.current) {
      return;
    }

    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void loadConversation(true);
    }, 300);
  }, [loadConversation]);

  useEffect(() => {
    void loadConversation();
  }, [loadConversation]);

  useEffect(
    () => () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    void refreshPendingMessages();
  }, [refreshPendingMessages]);

  useEffect(() => {
    if (!loading) {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollToEnd({ animated: false });
      });
    }
  }, [loading, messages.length]);

  useEffect(() => {
    if (!conversationId || !workspaceId || loading || messages.length === 0) {
      return;
    }

    const maxSequence = messages.reduce(
      (max, item) => Math.max(max, Number(item.sequence || 0)),
      0,
    );
    if (maxSequence <= 0) {
      return;
    }

    const nextKey = `${conversationId}:${maxSequence}`;
    if (lastReportedReadRef.current === nextKey) {
      return;
    }
    lastReportedReadRef.current = nextKey;
    void api
      .markThreadRead(workspaceId, conversationId, maxSequence)
      .then(() => clearPendingConversationRead(conversationId, maxSequence))
      .catch(() =>
        queuePendingConversationRead(workspaceId, conversationId, maxSequence),
      );
  }, [conversationId, loading, messages, workspaceId]);

  useEffect(() => {
    if (!conversationId || pendingMessages.length === 0) {
      return;
    }

    const timer = setInterval(() => {
      void flushPendingConversationMessages({ conversationId }).then(
        (deliveredItems) => {
          const deliveredForConversation = deliveredItems.filter(
            (item) => item.conversationId === conversationId,
          );
          if (deliveredForConversation.length > 0) {
            setMessages((current) =>
              applyDeliveredItems(current, deliveredForConversation),
            );
          }
          void refreshPendingMessages();
        },
      );
    }, 5000);

    return () => clearInterval(timer);
  }, [conversationId, pendingMessages.length, refreshPendingMessages]);

  const handleSocketEvent = useCallback(
    (event: Record<string, unknown>) => {
      if (!conversationId || !workspaceId || typeof event.type !== "string") {
        return;
      }

      switch (event.type) {
        case "conversation.item.created": {
          const payload = event.payload as ConversationFeedItem;
          if (payload.conversationId !== conversationId) {
            return;
          }

          setMessages((current) => mergeConversationItem(current, payload));
          if (payload.kind === "message" && payload.clientMessageId) {
            void clearPendingConversationMessage(payload.clientMessageId).then(
              refreshPendingMessages,
            );
          }
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
        case "interaction.updated": {
          const payload = event.payload as { conversationId: string };
          if (payload.conversationId === conversationId) {
            scheduleConversationRefresh();
          }
          return;
        }
        case "runtime.updated":
          return;
        default:
          return;
      }
    },
    [conversationId, scheduleConversationRefresh, workspaceId],
  );

  useWorkspaceWebSocket({
    workspaceId: workspaceId || undefined,
    enabled: Boolean(canRender),
    subscriptions:
      canRender
        ? [
            {
              key: `conversation:${conversationId}`,
              topic: "conversation" as const,
              conversationId,
            },
          ]
        : [],
    onConnected: () => {
      void flushPendingConversationReads();
      void flushPendingConversationMessages({ conversationId }).then(
        (deliveredItems) => {
          const deliveredForConversation = deliveredItems.filter(
            (item) => item.conversationId === conversationId,
          );
          if (deliveredForConversation.length > 0) {
            setMessages((current) =>
              applyDeliveredItems(current, deliveredForConversation),
            );
          }
          void refreshPendingMessages();
        },
      );
      void loadConversation(true);
    },
    onEvent: handleSocketEvent,
  });

  async function handleSendMessage(contentBlocks: any[]) {
    if (!conversationId || !workspaceId) return;

    const clientMessageId = createId("message");
    const optimisticSequence =
      Math.max(
        Date.now() * 1000,
        ...messages.map((item) => Number(item.sequence || 0)),
        ...pendingMessages.map((item) => Number(item.optimisticSequence || 0)),
      ) + 1;
    const pendingMessage: PendingConversationMessage = {
      clientMessageId,
      workspaceId,
      conversationId,
      contentBlocks,
      createdAt: new Date().toISOString(),
      optimisticSequence,
      status: "sending",
      attemptCount: 0,
    };

    await queuePendingConversationMessage(pendingMessage);
    setPendingMessages((current) =>
      [...current, pendingMessage].sort(
        (left, right) => left.optimisticSequence - right.optimisticSequence,
      ),
    );
    setMessages((current) =>
      mergeConversationItem(
        current,
        pendingConversationMessageToFeedItem(pendingMessage),
      ),
    );
    void flushPendingConversationMessages({ conversationId }).then(
      (deliveredItems) => {
        const deliveredForConversation = deliveredItems.filter(
          (item) => item.conversationId === conversationId,
        );
        if (deliveredForConversation.length > 0) {
          setMessages((current) =>
            applyDeliveredItems(current, deliveredForConversation),
          );
        }
        void refreshPendingMessages();
      },
    );
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
                  ? conversation.kind === "private"
                    ? "私聊"
                    : "群聊"
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
    minHeight: 0,
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
    minHeight: 0,
    backgroundColor: theme.colors.backgroundAlt,
  },
  messagesContent: {
    paddingHorizontal: 14,
    paddingTop: 18,
    paddingBottom: 18,
    gap: 14,
  },
});
