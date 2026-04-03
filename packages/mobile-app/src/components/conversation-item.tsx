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
  showDivider = true,
}: {
  conversation: ConversationSummaryView;
  onPress: () => void;
  showDivider?: boolean;
}) {
  const title = conversation.presentation?.title || conversation.title;
  const avatarUrl =
    conversation.presentation?.avatarUrl ||
    conversation.avatarUrl ||
    conversation.participants[0]?.avatarUrl;
  const preview =
    conversation.lastMessage?.content?.trim() || "打开会话继续沟通";
  const messageAt =
    conversation.lastMessage?.createdAt || conversation.createdAt;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.container,
        !showDivider && styles.containerWithoutDivider,
        pressed && styles.containerPressed,
      ]}
    >
      <View style={styles.avatarWrap}>
        <Avatar name={title} uri={avatarUrl} size={40} />
        {conversation.unreadCount > 0 ? (
          <View style={styles.unreadBadge}>
            <Text style={styles.unreadText}>
              {conversation.unreadCount > 99
                ? "99+"
                : conversation.unreadCount}
            </Text>
          </View>
        ) : null}
      </View>
      <View style={styles.content}>
        <View style={styles.headerRow}>
          <Text numberOfLines={1} style={styles.title}>
            {title}
          </Text>
          <Text style={styles.time}>{formatMessageTime(messageAt)}</Text>
        </View>
        <Text numberOfLines={1} style={styles.preview}>
          {preview}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: -18,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  containerPressed: {
    backgroundColor: theme.colors.surfaceMuted,
  },
  containerWithoutDivider: {
    borderBottomWidth: 0,
  },
  avatarWrap: {
    position: "relative",
    width: 40,
    height: 40,
  },
  content: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    fontWeight: "700",
    color: theme.colors.text,
  },
  time: {
    fontSize: 11,
    color: theme.colors.textSoft,
    flexShrink: 0,
  },
  preview: {
    fontSize: 14,
    lineHeight: 18,
    color: theme.colors.textMuted,
  },
  unreadBadge: {
    position: "absolute",
    top: -2,
    right: -5,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: theme.colors.surface,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadText: {
    color: theme.colors.white,
    fontSize: 10,
    fontWeight: "800",
  },
});
