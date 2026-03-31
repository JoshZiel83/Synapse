import Feather from "@expo/vector-icons/Feather";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Avatar } from "@/components/ui";
import { theme } from "@/theme/tokens";
import type { ConversationSummaryView } from "@/types/api";

function formatMessageTime(value?: string) {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function ConversationItem({
  conversation,
  onPress,
}: {
  conversation: ConversationSummaryView;
  onPress: () => void;
}) {
  const avatarUrl =
    conversation.avatarUrl || conversation.participants[0]?.avatarUrl;
  const preview =
    conversation.lastMessage?.content?.trim() || "打开会话继续沟通";
  const messageAt =
    conversation.lastMessage?.createdAt || conversation.createdAt;
  const metaLabel = conversation.kind === "private" ? "私聊" : "群聊";

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.container,
        pressed && styles.containerPressed,
      ]}
    >
      <Avatar name={conversation.title} uri={avatarUrl} />
      <View style={styles.content}>
        <View style={styles.headerRow}>
          <Text numberOfLines={1} style={styles.title}>
            {conversation.title}
          </Text>
          <Text style={styles.time}>{formatMessageTime(messageAt)}</Text>
        </View>
        <Text numberOfLines={1} style={styles.meta}>
          {metaLabel}
        </Text>
        <View style={styles.previewRow}>
          <Text numberOfLines={1} style={styles.preview}>
            {preview}
          </Text>
          {conversation.unreadCount > 0 ? (
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadText}>
                {conversation.unreadCount > 99
                  ? "99+"
                  : conversation.unreadCount}
              </Text>
            </View>
          ) : conversation.status === "active" ? (
            <Feather
              name="chevron-right"
              size={18}
              color={theme.colors.textSoft}
            />
          ) : (
            <Text style={styles.stateLabel}>已完成</Text>
          )}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: -18,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  containerPressed: {
    backgroundColor: theme.colors.surfaceMuted,
  },
  content: {
    flex: 1,
    gap: 6,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  title: {
    flex: 1,
    fontSize: 16,
    fontWeight: "700",
    color: theme.colors.text,
  },
  time: {
    fontSize: 11,
    color: theme.colors.textSoft,
  },
  previewRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  meta: {
    fontSize: 11,
    color: theme.colors.textSoft,
  },
  preview: {
    flex: 1,
    fontSize: 14,
    lineHeight: 19,
    color: theme.colors.textMuted,
  },
  stateLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: theme.colors.textSoft,
  },
  unreadBadge: {
    minWidth: 24,
    height: 24,
    paddingHorizontal: 7,
    borderRadius: 12,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadText: {
    color: theme.colors.white,
    fontSize: 12,
    fontWeight: "800",
  },
});
