import Feather from "@expo/vector-icons/Feather";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import {
  Avatar,
  Button,
  EmptyState,
  LoadingBlock,
  Pill,
  ScreenScroll,
  SectionBlock,
  SectionTitleRow,
} from "@/components/ui";
import { api } from "@/lib/api";
import {
  conversationDisplayCount,
  conversationScopeLabel,
} from "@/lib/conversations";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type {
  ConversationParticipantView,
  ConversationSummaryView,
} from "@/types/api";

export default function ConversationDetailScreen() {
  const router = useRouter();
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const { workspaceId } = useWorkspace();
  const [conversation, setConversation] =
    useState<ConversationSummaryView | null>(null);
  const [members, setMembers] = useState<ConversationParticipantView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadData() {
      if (!conversationId || !workspaceId) {
        setLoading(false);
        return;
      }

      setLoading(true);

      try {
        const [threadResponse, membersResponse] = await Promise.all([
          api.getThread(workspaceId, conversationId),
          api.getThreadMembers(workspaceId, conversationId),
        ]);

        setConversation(
          (threadResponse.conversation as ConversationSummaryView | null) ??
            null,
        );
        setMembers(membersResponse.members);
        setError(null);
      } catch (nextError) {
        setError(
          nextError instanceof Error ? nextError.message : "群聊详情加载失败。",
        );
      } finally {
        setLoading(false);
      }
    }

    void loadData();
  }, [conversationId, workspaceId]);

  const activeCount = useMemo(
    () => conversationDisplayCount(members),
    [members],
  );

  return (
    <ScreenScroll topPadding={0} bottomPadding={56}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.headerButton}>
          <Feather name="chevron-left" size={20} color={theme.colors.text} />
        </Pressable>
        <Text numberOfLines={1} style={styles.headerTitle}>
          {conversation ? `${conversationScopeLabel(conversation)}详情` : "会话详情"}
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <SectionBlock>
          <LoadingBlock label="正在加载群聊详情..." />
        </SectionBlock>
      ) : error ? (
        <SectionBlock>
          <EmptyState
            icon="alert-circle"
            title="群聊详情加载失败"
            description={error}
          />
        </SectionBlock>
      ) : !conversation ? (
        <SectionBlock>
          <EmptyState
            icon="users"
            title="没有找到这个群聊"
            description="这个会话可能已经结束，或者你当前没有访问权限。"
          />
        </SectionBlock>
      ) : (
        <>
          <SectionBlock>
            <View style={styles.heroRow}>
              <Avatar
                name={conversation.title}
                uri={conversation.avatarUrl}
                size={68}
                icon="message-circle"
              />
              <View style={styles.heroBody}>
                <Text style={styles.heroTitle}>{conversation.title}</Text>
                <Text style={styles.heroSubtitle}>
                  {`${conversationScopeLabel(conversation)} · ${activeCount} 位成员`}
                </Text>
              </View>
              <Pill
                label={conversation.status === "active" ? "进行中" : "已完成"}
                tone="primary"
              />
            </View>
            <Button
              label="打开聊天"
              icon="message-circle"
              onPress={() => router.replace(`/chat/${conversation.id}`)}
            />
          </SectionBlock>

          <SectionBlock>
            <SectionTitleRow
              title="成员"
              action={<Text style={styles.countText}>{activeCount} 人</Text>}
            />
            {members.length > 0 ? (
              <View style={styles.listShell}>
                {members.map((member) => (
                  <View
                    key={member.participantId || member.id}
                    style={styles.rowCard}
                  >
                    <Avatar
                      name={member.name}
                      uri={member.avatarUrl}
                      icon={member.type === "actor" ? "cpu" : "user"}
                      size={42}
                    />
                    <View style={styles.rowBody}>
                      <Text style={styles.rowTitle}>
                        {member.name || "未命名成员"}
                      </Text>
                      <Text style={styles.rowSubtitle}>
                        {member.title ||
                          member.role ||
                          (member.type === "user" ? "成员" : "会话成员")}
                      </Text>
                    </View>
                    <Pill label={member.type === "actor" ? "角色" : "成员"} />
                  </View>
                ))}
              </View>
            ) : (
              <EmptyState
                icon="users"
                title="当前没有成员"
                description="这个群聊的成员数据暂时不可用。"
              />
            )}
          </SectionBlock>
        </>
      )}
    </ScreenScroll>
  );
}

const styles = StyleSheet.create({
  header: {
    marginHorizontal: -18,
    paddingHorizontal: 18,
    minHeight: 62,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  headerButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: "800",
    color: theme.colors.text,
  },
  headerSpacer: {
    width: 38,
  },
  heroRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  heroBody: {
    flex: 1,
    gap: 4,
  },
  heroTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: theme.colors.text,
  },
  heroSubtitle: {
    fontSize: 13,
    color: theme.colors.textMuted,
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
  rowCard: {
    marginHorizontal: -18,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowBody: {
    flex: 1,
    gap: 3,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: theme.colors.text,
  },
  rowSubtitle: {
    fontSize: 13,
    color: theme.colors.textMuted,
  },
});
