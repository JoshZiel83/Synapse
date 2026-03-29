import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  RefreshControl,
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
  MobilePageHeader,
  ScreenScroll,
  SectionBlock,
  SectionTitleRow,
} from "@/components/ui";
import { actorSummary, titleCase } from "@/lib/contacts";
import { api } from "@/lib/api";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type { WorkspaceMemberView } from "@/types/api";
import type { Actor } from "@shared";

type DirectoryMode = "actors" | "people";

export default function ContactsTab() {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const [mode, setMode] = useState<DirectoryMode>("actors");
  const [actors, setActors] = useState<Actor[]>([]);
  const [members, setMembers] = useState<WorkspaceMemberView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const deferredSearch = useDeferredValue(search);
  const normalizedQuery = deferredSearch.trim().toLowerCase();

  async function loadDirectory(isRefreshing = false) {
    if (!workspaceId) {
      setActors([]);
      setMembers([]);
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
      const [membersResponse, actorsResponse] = await Promise.all([
        api.getWorkspaceMembers(workspaceId),
        api.getActors(workspaceId),
      ]);

      setMembers(membersResponse.data ?? []);
      setActors(actorsResponse.actors.filter((actor) => actor.isActive));
      setError(null);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "联系人加载失败。",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void loadDirectory();
  }, [workspaceId]);

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

  return (
    <ScreenScroll
      topPadding={0}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void loadDirectory(true)}
        />
      }
    >
      <MobilePageHeader
        title="联系人"
        action={
          <Pressable
            onPress={() => router.push("/contacts/group/new")}
            style={({ pressed }) => [
              styles.headerAction,
              pressed && styles.headerActionPressed,
            ]}
          >
            <Feather name="plus" size={18} color={theme.colors.text} />
          </Pressable>
        }
      />

      <SectionBlock>
        <View style={styles.segment}>
          <SegmentButton
            label="角色"
            active={mode === "actors"}
            onPress={() => setMode("actors")}
          />
          <SegmentButton
            label="成员"
            active={mode === "people"}
            onPress={() => setMode("people")}
          />
        </View>
        <View style={styles.searchShell}>
          <Feather name="search" size={16} color={theme.colors.textSoft} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder={
              mode === "actors"
                ? "搜索角色名称、职能、标签..."
                : "搜索成员名称或邮箱..."
            }
            placeholderTextColor={theme.colors.textSoft}
            style={styles.searchInput}
          />
        </View>
      </SectionBlock>

      {loading ? (
        <SectionBlock>
          <LoadingBlock label="正在加载联系人..." />
        </SectionBlock>
      ) : error ? (
        <SectionBlock>
          <EmptyState
            icon="alert-circle"
            title="联系人加载失败"
            description={error}
            action={
              <View style={styles.retryAction}>
                <Button
                  label="重试"
                  icon="refresh-cw"
                  onPress={() => void loadDirectory()}
                />
              </View>
            }
          />
        </SectionBlock>
      ) : mode === "actors" ? (
        <SectionBlock>
          <SectionTitleRow
            title="角色目录"
            action={
              <Text style={styles.countText}>
                {visibleActors.length} 个角色
              </Text>
            }
          />
          {visibleActors.length > 0 ? (
            <View style={styles.listShell}>
              {visibleActors.map((actor) => (
                <Pressable
                  key={actor.id}
                  onPress={() =>
                    router.push({
                      pathname: "/contacts/[contactType]/[contactId]",
                      params: {
                        contactType: "actor",
                        contactId: actor.id,
                      },
                    })
                  }
                  style={({ pressed }) => [
                    styles.rowCard,
                    pressed && styles.rowCardPressed,
                  ]}
                >
                  <Avatar
                    name={actor.definition.name}
                    uri={actor.avatarUrl}
                    icon="cpu"
                    size={46}
                  />
                  <View style={styles.rowBody}>
                    <Text style={styles.rowTitle}>{actor.definition.name}</Text>
                    <Text style={styles.rowSubtitle}>
                      {actor.definition.title ||
                        titleCase(actor.definition.role)}
                    </Text>
                    <Text numberOfLines={2} style={styles.rowCopy}>
                      {actorSummary(actor)}
                    </Text>
                  </View>
                  <Feather
                    name="chevron-right"
                    size={18}
                    color={theme.colors.textSoft}
                  />
                </Pressable>
              ))}
            </View>
          ) : (
            <EmptyState
              icon="cpu"
              title="没有匹配到角色"
              description="换个关键词试试，或者先在 Web 端创建并启用数字员工。"
            />
          )}
        </SectionBlock>
      ) : (
        <SectionBlock>
          <SectionTitleRow
            title="工作区成员"
            action={
              <Text style={styles.countText}>{visibleMembers.length} 人</Text>
            }
          />
          {visibleMembers.length > 0 ? (
            <View style={styles.listShell}>
              {visibleMembers.map((member) => (
                <Pressable
                  key={member.id}
                  onPress={() =>
                    router.push({
                      pathname: "/contacts/[contactType]/[contactId]",
                      params: {
                        contactType: "member",
                        contactId: member.userId,
                      },
                    })
                  }
                  style={({ pressed }) => [
                    styles.rowCard,
                    pressed && styles.rowCardPressed,
                  ]}
                >
                  <Avatar
                    name={member.userName || member.userEmail}
                    uri={member.avatarUrl}
                    icon="user"
                    size={46}
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
                  <Feather
                    name="chevron-right"
                    size={18}
                    color={theme.colors.textSoft}
                  />
                </Pressable>
              ))}
            </View>
          ) : (
            <EmptyState
              icon="users"
              title="没有匹配到成员"
              description="当前工作区成员较少，或者这个关键词没有结果。"
            />
          )}
        </SectionBlock>
      )}
    </ScreenScroll>
  );
}

function SegmentButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.segmentButton, active && styles.segmentButtonActive]}
    >
      <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headerAction: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  headerActionPressed: {
    opacity: 0.86,
  },
  segment: {
    flexDirection: "row",
    gap: 6,
    padding: 4,
    borderRadius: theme.radii.pill,
    backgroundColor: theme.colors.surfaceMuted,
  },
  segmentButton: {
    flex: 1,
    borderRadius: theme.radii.pill,
    paddingVertical: 10,
    alignItems: "center",
  },
  segmentButtonActive: {
    backgroundColor: theme.colors.surface,
  },
  segmentLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: theme.colors.textSoft,
  },
  segmentLabelActive: {
    color: theme.colors.text,
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
  retryAction: {
    marginTop: 10,
    width: "100%",
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
});
