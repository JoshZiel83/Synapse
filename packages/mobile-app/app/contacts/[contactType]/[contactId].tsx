import Feather from "@expo/vector-icons/Feather";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { ConversationItem } from "@/components/conversation-item";
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
import { actorSummary, titleCase } from "@/lib/contacts";
import {
  conversationIncludesActor,
  conversationIncludesUser,
  findConversationForUser,
  findDirectConversationForActor,
  isGroupConversation,
} from "@/lib/conversations";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type { ConversationSummaryView, WorkspaceMemberView } from "@/types/api";
import type { Actor } from "@shared";

export default function ContactDetailScreen() {
  const router = useRouter();
  const { contactType, contactId } = useLocalSearchParams<{
    contactType: "actor" | "member";
    contactId: string;
  }>();
  const { workspaceId } = useWorkspace();
  const [actors, setActors] = useState<Actor[]>([]);
  const [members, setMembers] = useState<WorkspaceMemberView[]>([]);
  const [conversations, setConversations] = useState<ConversationSummaryView[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadData() {
      if (!workspaceId) {
        setLoading(false);
        return;
      }

      setLoading(true);

      try {
        const [actorsResponse, membersResponse, conversationsResponse] =
          await Promise.all([
            api.getActors(workspaceId),
            api.getWorkspaceMembers(workspaceId),
            api.getConversations(workspaceId),
          ]);

        setActors(actorsResponse.actors.filter((actor) => actor.isActive));
        setMembers(membersResponse.data ?? []);
        setConversations(conversationsResponse.conversations);
        setError(null);
      } catch (nextError) {
        setError(
          nextError instanceof Error
            ? nextError.message
            : "联系人详情加载失败。",
        );
      } finally {
        setLoading(false);
      }
    }

    void loadData();
  }, [workspaceId]);

  const actor =
    contactType === "actor"
      ? (actors.find((item) => item.id === contactId) ?? null)
      : null;
  const member =
    contactType === "member"
      ? (members.find((item) => item.userId === contactId) ?? null)
      : null;

  const relatedGroups = useMemo(() => {
    if (contactType === "actor" && actor) {
      return conversations.filter(
        (conversation) =>
          isGroupConversation(conversation) &&
          conversationIncludesActor(conversation, actor.id),
      );
    }

    if (contactType === "member" && member) {
      return conversations.filter(
        (conversation) =>
          isGroupConversation(conversation) &&
          conversationIncludesUser(conversation, member.userId),
      );
    }

    return [];
  }, [actor, contactType, conversations, member]);

  async function handleGoChat() {
    if (!workspaceId || submitting) return;

    setSubmitting(true);
    try {
      if (actor) {
        const existing = findDirectConversationForActor(
          conversations,
          actor.id,
        );
        if (existing) {
          router.push(`/chat/${existing.id}`);
          return;
        }

        const created = await api.createConversation(workspaceId, [actor.id]);
        const conversationId = created.conversationId || created.id;
        if (conversationId) {
          router.replace(`/chat/${conversationId}`);
        }
        return;
      }

      if (member) {
        const existing = findConversationForUser(conversations, member.userId);
        if (existing) {
          router.push(`/chat/${existing.id}`);
          return;
        }

        router.push({
          pathname: "/contacts/group/new",
          params: { userId: member.userId },
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  const title = actor?.definition.name || member?.userName || "联系人详情";
  const subtitle = actor
    ? actor.definition.title || titleCase(actor.definition.role)
    : member?.userEmail || "成员详情";

  return (
    <ScreenScroll topPadding={0} bottomPadding={56}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.headerButton}>
          <Feather name="chevron-left" size={20} color={theme.colors.text} />
        </Pressable>
        <Text numberOfLines={1} style={styles.headerTitle}>
          联系人详情
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <SectionBlock>
          <LoadingBlock label="正在加载联系人详情..." />
        </SectionBlock>
      ) : error ? (
        <SectionBlock>
          <EmptyState
            icon="alert-circle"
            title="联系人详情加载失败"
            description={error}
          />
        </SectionBlock>
      ) : !actor && !member ? (
        <SectionBlock>
          <EmptyState
            icon="user"
            title="没有找到这个联系人"
            description="这个联系人可能已经被移除，或者当前工作区里不存在。"
          />
        </SectionBlock>
      ) : (
        <>
          <SectionBlock>
            <View style={styles.profileRow}>
              <Avatar
                name={title}
                uri={actor?.avatarUrl || member?.avatarUrl}
                size={68}
                icon={actor ? "cpu" : "user"}
              />
              <View style={styles.profileBody}>
                <Text style={styles.profileName}>{title}</Text>
                <Text style={styles.profileSubtitle}>{subtitle}</Text>
              </View>
              <Pill
                label={actor ? "角色" : member?.trustLevel || "成员"}
                tone="primary"
              />
            </View>
            {actor ? (
              <Text style={styles.profileCopy}>{actorSummary(actor)}</Text>
            ) : member ? (
              <Text style={styles.profileCopy}>
                所在工作区权限级别：{member.trustLevel}
              </Text>
            ) : null}
            <Button
              label={
                submitting
                  ? "处理中..."
                  : member
                    ? "去聊天"
                    : `和 ${title} 聊天`
              }
              icon="message-circle"
              onPress={() => void handleGoChat()}
              disabled={submitting}
            />
          </SectionBlock>

          <SectionBlock>
            <SectionTitleRow
              title="所在群聊"
              action={
                <Text style={styles.countText}>{relatedGroups.length} 个</Text>
              }
            />
            {relatedGroups.length > 0 ? (
              <View style={styles.listShell}>
                {relatedGroups.map((conversation) => (
                  <ConversationItem
                    key={conversation.id}
                    conversation={conversation}
                    onPress={() => router.push(`/chat/${conversation.id}`)}
                  />
                ))}
              </View>
            ) : (
              <EmptyState
                icon="users"
                title="暂时还没有群聊"
                description="等这个联系人进入更多群聊后，这里会显示它所在的会话。"
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
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  profileBody: {
    flex: 1,
    gap: 4,
  },
  profileName: {
    fontSize: 20,
    fontWeight: "800",
    color: theme.colors.text,
  },
  profileSubtitle: {
    fontSize: 13,
    color: theme.colors.textMuted,
  },
  profileCopy: {
    fontSize: 14,
    lineHeight: 21,
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
});
