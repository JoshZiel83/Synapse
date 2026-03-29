import Feather from "@expo/vector-icons/Feather";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  Avatar,
  Button,
  EmptyState,
  LoadingBlock,
  ScreenScroll,
  SectionBlock,
  SectionTitleRow,
} from "@/components/ui";
import { actorSummary, titleCase } from "@/lib/contacts";
import { api } from "@/lib/api";
import { useSession } from "@/providers/session-provider";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type { WorkspaceMemberView } from "@/types/api";
import type { Actor } from "@shared";

export default function NewGroupConversationScreen() {
  const router = useRouter();
  const { user } = useSession();
  const { workspaceId } = useWorkspace();
  const { actorId, userId } = useLocalSearchParams<{
    actorId?: string;
    userId?: string;
  }>();
  const [actors, setActors] = useState<Actor[]>([]);
  const [members, setMembers] = useState<WorkspaceMemberView[]>([]);
  const [selectedActorIds, setSelectedActorIds] = useState<string[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const deferredSearch = useDeferredValue(search);
  const normalizedQuery = deferredSearch.trim().toLowerCase();

  useEffect(() => {
    async function loadData() {
      if (!workspaceId) {
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const [actorsResponse, membersResponse] = await Promise.all([
          api.getActors(workspaceId),
          api.getWorkspaceMembers(workspaceId),
        ]);

        const nextActors = actorsResponse.actors.filter(
          (item) => item.isActive,
        );
        const nextMembers = (membersResponse.data ?? []).filter(
          (item) => item.userId !== user?.id,
        );

        setActors(nextActors);
        setMembers(nextMembers);
        setSelectedActorIds(
          actorId && nextActors.some((item) => item.id === actorId)
            ? [actorId]
            : [],
        );
        setSelectedUserIds(
          userId && nextMembers.some((item) => item.userId === userId)
            ? [userId]
            : [],
        );
        setError(null);
      } catch (nextError) {
        setError(
          nextError instanceof Error
            ? nextError.message
            : "群聊发起页加载失败。",
        );
      } finally {
        setLoading(false);
      }
    }

    void loadData();
  }, [actorId, user?.id, userId, workspaceId]);

  const visibleActors = useMemo(() => {
    if (!normalizedQuery) return actors;
    return actors.filter((actor) => {
      const haystack = [
        actor.definition.name,
        actor.definition.title,
        actor.definition.role,
        actorSummary(actor),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [actors, normalizedQuery]);

  const visibleMembers = useMemo(() => {
    if (!normalizedQuery) return members;
    return members.filter((member) =>
      [member.userName || "", member.userEmail || "", member.trustLevel || ""]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [members, normalizedQuery]);

  function toggleActor(actorIdValue: string) {
    setSelectedActorIds((current) =>
      current.includes(actorIdValue)
        ? current.filter((id) => id !== actorIdValue)
        : [...current, actorIdValue],
    );
  }

  function toggleUser(userIdValue: string) {
    setSelectedUserIds((current) =>
      current.includes(userIdValue)
        ? current.filter((id) => id !== userIdValue)
        : [...current, userIdValue],
    );
  }

  async function handleCreateConversation() {
    if (!workspaceId || selectedActorIds.length === 0 || submitting) return;

    setSubmitting(true);
    try {
      const created = await api.createConversation(
        workspaceId,
        selectedActorIds,
      );
      const conversationId = created.conversationId || created.id;

      if (!conversationId) {
        throw new Error("服务器没有返回 conversationId");
      }

      if (selectedUserIds.length > 0) {
        await api.addConversationMembers(workspaceId, conversationId, {
          userIds: selectedUserIds,
        });
      }

      router.replace(`/chat/${conversationId}`);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "发起群聊失败。",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ScreenScroll topPadding={0} bottomPadding={56}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.headerButton}>
          <Feather name="chevron-left" size={20} color={theme.colors.text} />
        </Pressable>
        <Text numberOfLines={1} style={styles.headerTitle}>
          发起群聊
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      <SectionBlock>
        <Text style={styles.tipText}>
          当前版本创建会话时至少需要选择一个角色；如果你还勾选了成员，会在群聊创建后自动加入。
        </Text>
        <View style={styles.searchShell}>
          <Feather name="search" size={16} color={theme.colors.textSoft} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="搜索角色或成员"
            placeholderTextColor={theme.colors.textSoft}
            style={styles.searchInput}
          />
        </View>
      </SectionBlock>

      {loading ? (
        <SectionBlock>
          <LoadingBlock label="正在加载可选联系人..." />
        </SectionBlock>
      ) : error ? (
        <SectionBlock>
          <EmptyState
            icon="alert-circle"
            title="群聊发起页加载失败"
            description={error}
          />
        </SectionBlock>
      ) : (
        <>
          <SectionBlock>
            <SectionTitleRow
              title="选择角色"
              action={
                <Text style={styles.countText}>
                  已选 {selectedActorIds.length} 个
                </Text>
              }
            />
            {visibleActors.length > 0 ? (
              <View style={styles.listShell}>
                {visibleActors.map((actor) => {
                  const selected = selectedActorIds.includes(actor.id);
                  return (
                    <Pressable
                      key={actor.id}
                      onPress={() => toggleActor(actor.id)}
                      style={({ pressed }) => [
                        styles.rowCard,
                        pressed && styles.rowCardPressed,
                      ]}
                    >
                      <Avatar
                        name={actor.definition.name}
                        uri={actor.avatarUrl}
                        icon="cpu"
                        size={44}
                      />
                      <View style={styles.rowBody}>
                        <Text style={styles.rowTitle}>
                          {actor.definition.name}
                        </Text>
                        <Text style={styles.rowSubtitle}>
                          {actor.definition.title ||
                            titleCase(actor.definition.role)}
                        </Text>
                        <Text numberOfLines={2} style={styles.rowCopy}>
                          {actorSummary(actor)}
                        </Text>
                      </View>
                      <CheckBadge selected={selected} />
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              <EmptyState
                icon="cpu"
                title="没有匹配到角色"
                description="换个关键词试试。"
              />
            )}
          </SectionBlock>

          <SectionBlock>
            <SectionTitleRow
              title="选择成员"
              action={
                <Text style={styles.countText}>
                  已选 {selectedUserIds.length} 人
                </Text>
              }
            />
            {visibleMembers.length > 0 ? (
              <View style={styles.listShell}>
                {visibleMembers.map((member) => {
                  const selected = selectedUserIds.includes(member.userId);
                  return (
                    <Pressable
                      key={member.id}
                      onPress={() => toggleUser(member.userId)}
                      style={({ pressed }) => [
                        styles.rowCard,
                        pressed && styles.rowCardPressed,
                      ]}
                    >
                      <Avatar
                        name={member.userName || member.userEmail}
                        uri={member.avatarUrl}
                        icon="user"
                        size={44}
                      />
                      <View style={styles.rowBody}>
                        <Text style={styles.rowTitle}>
                          {member.userName || "未命名成员"}
                        </Text>
                        <Text style={styles.rowSubtitle}>
                          {member.userEmail || "暂无邮箱信息"}
                        </Text>
                        <Text style={styles.rowCopy}>
                          权限级别：{member.trustLevel}
                        </Text>
                      </View>
                      <CheckBadge selected={selected} />
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              <EmptyState
                icon="users"
                title="没有匹配到成员"
                description="换个关键词试试。"
              />
            )}
          </SectionBlock>

          <SectionBlock>
            {selectedActorIds.length === 0 ? (
              <Text style={styles.warningText}>
                至少选择一个角色，才能创建新的群聊。
              </Text>
            ) : null}
            <Button
              label={submitting ? "创建中..." : "创建群聊"}
              icon="message-circle"
              onPress={() => void handleCreateConversation()}
              disabled={selectedActorIds.length === 0 || submitting}
            />
          </SectionBlock>
        </>
      )}
    </ScreenScroll>
  );
}

function CheckBadge({ selected }: { selected: boolean }) {
  return (
    <View style={[styles.checkBadge, selected && styles.checkBadgeSelected]}>
      <Feather
        name={selected ? "check" : "circle"}
        size={16}
        color={selected ? theme.colors.white : theme.colors.textSoft}
      />
    </View>
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
  tipText: {
    fontSize: 13,
    lineHeight: 20,
    color: theme.colors.textMuted,
  },
  searchShell: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 16,
    backgroundColor: theme.colors.surfaceMuted,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: theme.colors.text,
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
  rowCardPressed: {
    backgroundColor: theme.colors.surfaceMuted,
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
  rowCopy: {
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.textSoft,
  },
  checkBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceMuted,
  },
  checkBadgeSelected: {
    backgroundColor: theme.colors.primary,
  },
  warningText: {
    fontSize: 13,
    color: theme.colors.accent,
  },
});
