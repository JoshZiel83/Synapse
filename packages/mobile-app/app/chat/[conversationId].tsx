import Feather from "@expo/vector-icons/Feather";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { ChatMessageActionSheet } from "@/components/chat-message-action-sheet";
import { MessageItem } from "@/components/message-item";
import { Button, EmptyState, LoadingBlock, ScreenView } from "@/components/ui";
import {
  buildReplyPreviewText,
  getConversationDisplayName,
  getConversationViewerParticipant,
  type MobileChatItem,
} from "@/lib/chat-data";
import { useChat } from "@/providers/chat-provider";
import { theme } from "@/theme/tokens";
import type { ConversationReplyRef } from "@shared";

export default function ChatDetailScreen() {
  const router = useRouter();
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const scrollRef = useRef<ScrollView | null>(null);
  const lastReportedReadRef = useRef<string>("");
  const {
    getConversation,
    getConversationItems,
    getConversationMeta,
    loadOlderMessages,
    markConversationRead,
    refreshConversation,
    sendMessage,
    status,
    workspaceMemberId,
  } = useChat();
  const [refreshing, setRefreshing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [replyTo, setReplyTo] = useState<ConversationReplyRef | null>(null);
  const [actionMenu, setActionMenu] = useState<{
    item: MobileChatItem;
    x: number;
    y: number;
    mine: boolean;
  } | null>(null);

  const conversation = conversationId ? getConversation(conversationId) : null;
  const items = conversationId ? getConversationItems(conversationId) : [];
  const meta = conversationId ? getConversationMeta(conversationId) : null;
  const viewerParticipantId = getConversationViewerParticipant(
    conversation,
    workspaceMemberId,
  )?.participantId;
  const loading = status === "loading" && !conversation;
  const headerTitle = conversation
    ? getConversationDisplayName(conversation, workspaceMemberId)
    : "聊天";

  useEffect(() => {
    setReplyTo(null);
    setActionMenu(null);
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) {
      return;
    }

    void refreshConversation(conversationId).catch(() => undefined);
  }, [conversationId, refreshConversation]);

  useEffect(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({ animated: false });
    });
  }, [items.length]);

  useEffect(() => {
    if (!conversationId || !conversation || items.length === 0) {
      return;
    }

    const maxSequence = items.reduce(
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
    void markConversationRead(conversationId, maxSequence, maxSequence);
  }, [conversation, conversationId, items, markConversationRead]);

  const messageNodes = useMemo(
    () =>
      items.map((item) => (
        <MessageItem
          key={item.id}
          item={item}
          viewerParticipantId={viewerParticipantId}
          onLongPress={
            item.itemType === "message" && !item.localOnly
              ? (event) =>
                  setActionMenu({
                    item,
                    x: event.nativeEvent.pageX,
                    y: event.nativeEvent.pageY,
                    mine: item.authorParticipantId === viewerParticipantId,
                  })
              : undefined
          }
        />
      )),
    [conversation, items, viewerParticipantId],
  );

  async function handleRefresh() {
    if (!conversationId) {
      return;
    }

    setRefreshing(true);
    try {
      await refreshConversation(conversationId);
    } finally {
      setRefreshing(false);
    }
  }

  async function handleLoadOlder() {
    if (!conversationId || !meta?.hasMoreBefore) {
      return;
    }

    setLoadingOlder(true);
    try {
      await loadOlderMessages(conversationId);
    } finally {
      setLoadingOlder(false);
    }
  }

  if (!conversationId) {
    return (
      <ScreenView>
        <EmptyState
          icon="message-square"
          title="当前无法打开会话"
          description="缺少有效的会话标识。"
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
          <View style={styles.headerRow}>
            <Pressable onPress={() => router.back()} style={styles.headerButton}>
              <Feather name="chevron-left" size={20} color={theme.colors.text} />
            </Pressable>
            <Text numberOfLines={1} style={styles.headerTitle}>
              {headerTitle}
            </Text>
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
        </View>

        {loading ? (
          <View style={styles.placeholder}>
            <LoadingBlock label="正在加载聊天记录..." />
          </View>
        ) : !conversation ? (
          <View style={styles.placeholder}>
            <EmptyState
              icon="message-circle"
              title="会话还没同步下来"
              description="下拉重试一次，或者稍后再进。"
              action={
                <Button
                  label="重试"
                  icon="refresh-cw"
                  onPress={() => void handleRefresh()}
                />
              }
            />
          </View>
        ) : (
          <>
            <ScrollView
              ref={scrollRef}
              style={styles.messages}
              contentContainerStyle={styles.messagesContent}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => void handleRefresh()}
                />
              }
              keyboardShouldPersistTaps="handled"
            >
              {meta?.hasMoreBefore ? (
                <View style={styles.topAction}>
                  <Button
                    label={loadingOlder ? "加载中..." : "加载更早消息"}
                    variant="ghost"
                    icon="chevrons-up"
                    disabled={loadingOlder}
                    onPress={() => void handleLoadOlder()}
                  />
                </View>
              ) : null}

              {messageNodes.length > 0 ? (
                messageNodes
              ) : (
                <EmptyState
                  icon="message-circle"
                  title="还没有消息"
                  description="发一条消息开始对话。"
                />
              )}
            </ScrollView>

            <ChatComposer
              workspaceId={conversation.workspaceId}
              conversationId={conversationId}
              conversation={conversation}
              viewerParticipantId={viewerParticipantId}
              replyTo={replyTo}
              onCancelReply={() => setReplyTo(null)}
              onSend={(payload) => sendMessage(conversationId, payload)}
            />
          </>
        )}
      </KeyboardAvoidingView>
      <ChatMessageActionSheet
        open={Boolean(actionMenu)}
        anchor={
          actionMenu
            ? {
                x: actionMenu.x,
                y: actionMenu.y,
                mine: actionMenu.mine,
              }
            : null
        }
        onClose={() => setActionMenu(null)}
        onQuote={() => {
          if (actionMenu) {
            setReplyTo({
              itemId: actionMenu.item.id,
              itemType: actionMenu.item.itemType,
              subtype: actionMenu.item.subtype,
              author: actionMenu.item.author,
              previewText: actionMenu.item.content.trim(),
              previewBlocks: actionMenu.item.contentBlocks,
              createdAt: actionMenu.item.createdAt,
            });
          }
          setActionMenu(null);
        }}
        onCopy={() => {
          if (actionMenu) {
            void Clipboard.setStringAsync(
              buildReplyPreviewText({
                previewText: actionMenu.item.content,
                previewBlocks: actionMenu.item.contentBlocks,
                subtype: actionMenu.item.subtype,
              }),
            ).catch(() => undefined);
          }
          setActionMenu(null);
        }}
      />
    </ScreenView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    minHeight: 48,
    paddingHorizontal: 18,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    justifyContent: "flex-end",
  },
  headerRow: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  headerButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: "800",
    color: theme.colors.text,
    textAlign: "center",
  },
  placeholder: {
    flex: 1,
    paddingHorizontal: 18,
    justifyContent: "center",
  },
  messages: {
    flex: 1,
  },
  messagesContent: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    gap: 12,
  },
  topAction: {
    alignItems: "center",
    marginBottom: 2,
  },
});
