import Feather from '@expo/vector-icons/Feather';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { ChatComposer } from '@/components/chat-composer';
import { MessageItem } from '@/components/message-item';
import { Avatar, EmptyState, LoadingBlock, ScreenView } from '@/components/ui';
import { api } from '@/lib/api';
import { createId } from '@/lib/ids';
import { useWorkspace } from '@/providers/workspace-provider';
import { theme } from '@/theme/tokens';
import type { ConversationFeedItem } from '@shared';

function sortItems(items: ConversationFeedItem[]) {
  return [...items].sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });
}

export default function ChatDetailScreen() {
  const router = useRouter();
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const { workspaceId } = useWorkspace();
  const scrollRef = useRef<ScrollView | null>(null);
  const [messages, setMessages] = useState<ConversationFeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [title, setTitle] = useState('聊天');
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const canRender = workspaceId && conversationId;

  async function loadConversation(isRefreshing = false) {
    if (!workspaceId || !conversationId) {
      setLoading(false);
      return;
    }

    if (isRefreshing) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const [messagesResponse, conversationsResponse] = await Promise.all([
        api.getConversationMessages(workspaceId, conversationId, 100),
        api.getConversations(workspaceId),
      ]);

      const conversation = conversationsResponse.conversations.find((item) => item.id === conversationId);
      setTitle(conversation?.title || '聊天');
      setAvatarUrl(conversation?.avatarUrl || conversation?.participants[0]?.avatarUrl);
      setMessages(sortItems(messagesResponse.items));
      setError(null);
      await api.markConversationRead(workspaceId, conversationId).catch(() => undefined);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '聊天记录加载失败。');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void loadConversation();
  }, [conversationId, workspaceId]);

  useEffect(() => {
    if (!loading) {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollToEnd({ animated: false });
      });
    }
  }, [loading, messages.length]);

  async function handleSendMessage(contentBlocks: any[]) {
    if (!workspaceId || !conversationId) return;

    const clientMessageId = createId('message');
    await api.sendConversationMessage(workspaceId, conversationId, contentBlocks, clientMessageId);
    await loadConversation(true);
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
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 10 : 0}
      >
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.headerButton}>
            <Feather name="chevron-left" size={20} color={theme.colors.text} />
          </Pressable>
          <View style={styles.headerCenter}>
            <Avatar name={title} uri={avatarUrl} size={36} icon="message-circle" />
            <View style={styles.headerText}>
              <Text numberOfLines={1} style={styles.headerTitle}>
                {title}
              </Text>
              <Text style={styles.headerSubtitle}>支持文字、图片、语音、拍照、录像</Text>
            </View>
          </View>
          <Pressable onPress={() => void loadConversation(true)} style={styles.headerButton}>
            <Feather name="refresh-cw" size={17} color={theme.colors.text} />
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
                <RefreshControl refreshing={refreshing} onRefresh={() => void loadConversation(true)} />
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
            <ChatComposer workspaceId={workspaceId} onSend={handleSendMessage} />
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: 'rgba(244, 239, 231, 0.96)',
  },
  headerButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: theme.colors.text,
  },
  headerSubtitle: {
    fontSize: 12,
    color: theme.colors.textSoft,
  },
  placeholder: {
    flex: 1,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  messages: {
    flex: 1,
  },
  messagesContent: {
    paddingHorizontal: 14,
    paddingTop: 18,
    paddingBottom: 18,
    gap: 14,
  },
});
