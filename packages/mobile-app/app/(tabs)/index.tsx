import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import { startTransition, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { ConversationItem } from "@/components/conversation-item";
import { MobileHeaderActions } from "@/components/mobile-header-actions";
import {
  Button,
  EmptyState,
  LoadingBlock,
  MobilePageHeader,
  Pill,
  ScreenScroll,
  SectionBlock,
  SectionTitleRow,
} from "@/components/ui";
import { api } from "@/lib/api";
import { listPendingConversationReads } from "@/lib/chat-sync";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type { ConversationSummaryView } from "@/types/api";
import type { Actor, WorkspaceChiefActorPreference } from "@shared";

function sortConversations<
  T extends { createdAt: string; lastMessage?: { createdAt?: string } },
>(items: T[]) {
  return [...items].sort((left, right) => {
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

export default function HomeTab() {
  const router = useRouter();
  const { workspaceId, workspaceName, needsOnboarding } = useWorkspace();
  const [actors, setActors] = useState<Actor[]>([]);
  const [conversations, setConversations] = useState<ConversationSummaryView[]>(
    [],
  );
  const [preference, setPreference] =
    useState<WorkspaceChiefActorPreference | null>(null);
  const [selectedActorId, setSelectedActorId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedActor = useMemo(
    () =>
      actors.find((actor) => actor.id === selectedActorId) ?? actors[0] ?? null,
    [actors, selectedActorId],
  );

  async function loadData(isRefreshing = false) {
    if (!workspaceId) {
      setActors([]);
      setConversations([]);
      setPreference(null);
      setSelectedActorId(null);
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
      const [actorsResponse, conversationsResponse, preferenceResponse] =
        await Promise.all([
          api.getActors(workspaceId),
          api.getThreads(workspaceId),
          api.getWorkspaceChiefActorPreference(workspaceId).catch(() => null),
        ]);

      const activeActors = actorsResponse.actors.filter(
        (actor) => actor.isActive,
      );
      setActors(activeActors);
      setConversations(
        sortConversations(
          await applyLocalReadState(conversationsResponse.conversations),
        ),
      );
      setPreference(preferenceResponse);
      setSelectedActorId(
        preferenceResponse?.chiefActorId || activeActors[0]?.id || null,
      );
      setError(null);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "加载首页失败。",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, [workspaceId]);

  async function handleStartConversation() {
    if (!workspaceId || !selectedActor || !draft.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const response = await api.createThread({
        domain: "workspace",
        kind: "group",
        workspaceId,
        actorIds: [selectedActor.id],
        title: selectedActor.definition.name,
        content: draft.trim(),
        targetActorIds: [selectedActor.id],
      });
      const conversationId = response.conversationId;
      setDraft("");

      if (conversationId) {
        startTransition(() => {
          router.push(`/chat/${conversationId}`);
        });
      }
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "创建会话失败。",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!workspaceId && needsOnboarding) {
    return (
      <ScreenScroll bottomPadding={56}>
        <EmptyState
          icon="briefcase"
          title="当前账号还没有工作区"
          description="移动端已经连上后端，但这个账号暂时没有可进入的 workspace。先在 Web 端完成组织初始化，再回到 App。"
        />
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll
      topPadding={0}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void loadData(true)}
        />
      }
    >
      <MobilePageHeader
        title={workspaceName || "Synapse"}
        action={
          <MobileHeaderActions
            onSearch={() => router.push("/search")}
            onStartGroup={() => router.push("/contacts/group/new")}
            onAddFriend={() => router.push("/contacts/add")}
            onScan={() => router.push("/scan?intent=relationship")}
          />
        }
      />

      {loading ? (
        <SectionBlock>
          <LoadingBlock label="正在加载首页..." />
        </SectionBlock>
      ) : (
        <>
          <SectionBlock>
            <SectionTitleRow
              title="工作区"
              action={
                <Pill label={`${conversations.length} 个会话`} tone="primary" />
              }
            />
            <View style={styles.summaryRow}>
              <StatCard
                label="联系人"
                value={String(actors.length)}
                icon="users"
              />
              <View style={styles.summaryDivider} />
              <StatCard
                label="消息"
                value={String(conversations.length)}
                icon="message-circle"
              />
            </View>
          </SectionBlock>

          <SectionBlock>
            <SectionTitleRow title="快捷发起" />
            <Text style={styles.sectionCopy}>
              {preference?.chiefActor?.name
                ? `默认推荐：${preference.chiefActor.name}`
                : "先从下方选择一个角色，作为移动端首页的快捷入口。"}
            </Text>

            {actors.length > 0 ? (
              <View style={styles.actorRow}>
                {actors.slice(0, 6).map((actor) => {
                  const active = actor.id === selectedActor?.id;
                  return (
                    <Pressable
                      key={actor.id}
                      onPress={() => setSelectedActorId(actor.id)}
                      style={[
                        styles.actorChip,
                        active && styles.actorChipActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.actorChipLabel,
                          active && styles.actorChipLabelActive,
                        ]}
                      >
                        {actor.definition.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              <Text style={styles.emptyHint}>当前工作区还没有可用角色。</Text>
            )}

            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              placeholder="例如：今天的重点任务帮我排一下优先级。"
              placeholderTextColor={theme.colors.textSoft}
              style={styles.draftInput}
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Button
              label={
                submitting
                  ? "创建中..."
                  : `和 ${selectedActor?.definition.name || "角色"} 开聊`
              }
              icon="send"
              onPress={() => void handleStartConversation()}
              disabled={!selectedActor || !draft.trim() || submitting}
            />
          </SectionBlock>

          <SectionBlock>
            <SectionTitleRow
              title="最近会话"
              action={
                <Pressable onPress={() => router.push("/chats")}>
                  <Text style={styles.linkText}>查看全部</Text>
                </Pressable>
              }
            />
            {conversations.length > 0 ? (
              <View style={styles.listShell}>
                {conversations.slice(0, 3).map((conversation) => (
                  <ConversationItem
                    key={conversation.id}
                    conversation={conversation}
                    onPress={() => router.push(`/chat/${conversation.id}`)}
                  />
                ))}
              </View>
            ) : (
              <EmptyState
                icon="message-square"
                title="还没有会话"
                description="先用上面的快捷输入发起第一条消息，或者去联系人页挑一个角色开始。"
              />
            )}
          </SectionBlock>
        </>
      )}
    </ScreenScroll>
  );
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: keyof typeof Feather.glyphMap;
}) {
  return (
    <View style={styles.statCard}>
      <Feather name={icon} size={18} color={theme.colors.primary} />
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  summaryRow: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  summaryDivider: {
    width: 1,
    backgroundColor: theme.colors.border,
  },
  statCard: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 6,
    paddingHorizontal: 12,
    gap: 5,
  },
  statValue: {
    fontSize: 18,
    fontWeight: "800",
    color: theme.colors.text,
  },
  statLabel: {
    fontSize: 12,
    color: theme.colors.textMuted,
  },
  sectionCopy: {
    fontSize: 14,
    lineHeight: 21,
    color: theme.colors.textMuted,
  },
  actorRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  actorChip: {
    borderRadius: theme.radii.pill,
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: theme.colors.surfaceMuted,
  },
  actorChipActive: {
    backgroundColor: theme.colors.primary,
  },
  actorChipLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.textMuted,
  },
  actorChipLabelActive: {
    color: theme.colors.white,
  },
  draftInput: {
    minHeight: 96,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceMuted,
    paddingHorizontal: 16,
    paddingVertical: 14,
    textAlignVertical: "top",
    fontSize: 16,
    color: theme.colors.text,
  },
  error: {
    fontSize: 13,
    color: theme.colors.danger,
  },
  emptyHint: {
    fontSize: 14,
    color: theme.colors.textSoft,
  },
  linkText: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.primary,
  },
  listShell: {
    marginTop: 2,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
});
