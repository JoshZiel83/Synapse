import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import { useDeferredValue, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

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
import { titleCase } from "@/lib/contacts";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type {
  ContactDiscoveryActorView,
  ContactDiscoveryUserView,
} from "@/types/api";

type SubmitTarget =
  | { kind: "workspace"; type: "actor"; id: string }
  | { kind: "workspace"; type: "user"; id: string }
  | { kind: "personal"; type: "actor"; id: string }
  | { kind: "personal"; type: "user"; id: string }
  | null;

export default function DiscoverContactsScreen() {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const [search, setSearch] = useState("");
  const [actors, setActors] = useState<ContactDiscoveryActorView[]>([]);
  const [users, setUsers] = useState<ContactDiscoveryUserView[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<SubmitTarget>(null);
  const [error, setError] = useState<string | null>(null);
  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    let cancelled = false;

    async function loadDiscoveries() {
      if (!workspaceId) {
        setActors([]);
        setUsers([]);
        setLoading(false);
        return;
      }

      setLoading(true);

      try {
        const response = await api.discoverContacts(
          workspaceId,
          deferredSearch,
          30,
        );
        if (cancelled) return;

        setActors(response.actors);
        setUsers(response.users);
        setError(null);
      } catch (nextError) {
        if (cancelled) return;
        setError(
          nextError instanceof Error
            ? nextError.message
            : "远端联系人发现失败。",
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadDiscoveries();

    return () => {
      cancelled = true;
    };
  }, [deferredSearch, workspaceId]);

  async function handleAddActor(
    actor: ContactDiscoveryActorView,
    scope: "workspace" | "personal",
  ) {
    if (!workspaceId) return;
    const nextSubmitting = {
      kind: scope,
      type: "actor" as const,
      id: actor.actorId,
    };
    setSubmitting(nextSubmitting);

    try {
      if (scope === "workspace") {
        await api.createWorkspaceContact(workspaceId, {
          targetType: "actor",
          targetWorkspaceId: actor.targetWorkspace.id,
          targetActorId: actor.actorId,
        });
      } else {
        await api.createPersonalContact(workspaceId, {
          targetType: "actor",
          targetWorkspaceId: actor.targetWorkspace.id,
          targetActorId: actor.actorId,
        });
      }

      setActors((current) =>
        current.map((item) =>
          item.actorId === actor.actorId
            ? {
                ...item,
                alreadyInWorkspaceContacts:
                  scope === "workspace" ? true : item.alreadyInWorkspaceContacts,
                alreadyInPersonalContacts:
                  scope === "personal" ? true : item.alreadyInPersonalContacts,
              }
            : item,
        ),
      );
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "保存联系人失败。",
      );
    } finally {
      setSubmitting(null);
    }
  }

  async function handleAddUser(
    user: ContactDiscoveryUserView,
    scope: "workspace" | "personal",
  ) {
    if (!workspaceId) return;
    const nextSubmitting = {
      kind: scope,
      type: "user" as const,
      id: user.userId,
    };
    setSubmitting(nextSubmitting);

    try {
      if (scope === "workspace") {
        await api.createWorkspaceContact(workspaceId, {
          targetType: "user",
          targetWorkspaceId: user.targetWorkspace.id,
          targetUserId: user.userId,
        });
      } else {
        await api.createPersonalContact(workspaceId, {
          targetType: "user",
          targetWorkspaceId: user.targetWorkspace.id,
          targetUserId: user.userId,
        });
      }

      setUsers((current) =>
        current.map((item) =>
          item.userId === user.userId &&
          item.targetWorkspace.id === user.targetWorkspace.id
            ? {
                ...item,
                alreadyInWorkspaceContacts:
                  scope === "workspace" ? true : item.alreadyInWorkspaceContacts,
                alreadyInPersonalContacts:
                  scope === "personal" ? true : item.alreadyInPersonalContacts,
              }
            : item,
        ),
      );
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "保存联系人失败。",
      );
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <ScreenScroll topPadding={0} bottomPadding={56}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.headerButton}>
          <Feather name="chevron-left" size={20} color={theme.colors.text} />
        </Pressable>
        <Text numberOfLines={1} style={styles.headerTitle}>
          远端发现
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      <SectionBlock>
        <Text style={styles.tipText}>
          搜索别的工作区里的用户或角色，然后把它们加入当前工作区共享联系人簿，或者只收藏到你自己的联系人里。
        </Text>
        <View style={styles.searchShell}>
          <Feather name="search" size={16} color={theme.colors.textSoft} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="搜索工作区、角色名、用户邮箱"
            placeholderTextColor={theme.colors.textSoft}
            style={styles.searchInput}
          />
        </View>
      </SectionBlock>

      {loading ? (
        <SectionBlock>
          <LoadingBlock label="正在搜索远端联系人..." />
        </SectionBlock>
      ) : error ? (
        <SectionBlock>
          <EmptyState
            icon="alert-circle"
            title="远端联系人发现失败"
            description={error}
          />
        </SectionBlock>
      ) : actors.length === 0 && users.length === 0 ? (
        <SectionBlock>
          <EmptyState
            icon="compass"
            title="没有发现结果"
            description="换个关键词试试，或者先在别的工作区准备好可用角色和成员。"
          />
        </SectionBlock>
      ) : (
        <>
          <SectionBlock>
            <SectionTitleRow
              title="远端角色"
              action={<Text style={styles.countText}>{actors.length} 个</Text>}
            />
            {actors.length > 0 ? (
              <View style={styles.listShell}>
                {actors.map((actor) => (
                  <View key={actor.actorId} style={styles.discoveryCard}>
                    <View style={styles.discoveryHeader}>
                      <Avatar
                        name={actor.name}
                        uri={actor.avatarUrl || undefined}
                        icon="cpu"
                        size={46}
                      />
                      <View style={styles.discoveryBody}>
                        <View style={styles.discoveryTitleLine}>
                          <Text style={styles.rowTitle}>{actor.name}</Text>
                          <Pill label={actor.targetWorkspace.name} tone="accent" />
                        </View>
                        <Text style={styles.rowSubtitle}>
                          {actor.title || titleCase(actor.role || "actor")}
                        </Text>
                        <Text style={styles.rowCopy}>
                          来自 {actor.targetWorkspace.name} 工作区
                        </Text>
                      </View>
                    </View>
                    <View style={styles.actionRow}>
                      <Button
                        label={
                          actor.alreadyInWorkspaceContacts
                            ? "已加入共享"
                            : submitting?.kind === "workspace" &&
                                submitting.type === "actor" &&
                                submitting.id === actor.actorId
                              ? "处理中..."
                              : "加到共享"
                        }
                        variant={
                          actor.alreadyInWorkspaceContacts ? "secondary" : "primary"
                        }
                        onPress={() => void handleAddActor(actor, "workspace")}
                        disabled={actor.alreadyInWorkspaceContacts || !!submitting}
                        style={styles.actionButton}
                      />
                      <Button
                        label={
                          actor.alreadyInPersonalContacts
                            ? "已收藏"
                            : submitting?.kind === "personal" &&
                                submitting.type === "actor" &&
                                submitting.id === actor.actorId
                              ? "处理中..."
                              : "收藏到我"
                        }
                        variant={
                          actor.alreadyInPersonalContacts ? "secondary" : "ghost"
                        }
                        onPress={() => void handleAddActor(actor, "personal")}
                        disabled={actor.alreadyInPersonalContacts || !!submitting}
                        style={styles.actionButton}
                      />
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <EmptyState
                icon="cpu"
                title="没有匹配到远端角色"
                description="可以尝试搜索角色名称、职能或工作区名称。"
              />
            )}
          </SectionBlock>

          <SectionBlock>
            <SectionTitleRow
              title="远端用户"
              action={<Text style={styles.countText}>{users.length} 个</Text>}
            />
            {users.length > 0 ? (
              <View style={styles.listShell}>
                {users.map((user) => (
                  <View
                    key={`${user.userId}:${user.targetWorkspace.id}`}
                    style={styles.discoveryCard}
                  >
                    <View style={styles.discoveryHeader}>
                      <Avatar
                        name={user.name || user.email || "远端用户"}
                        uri={user.avatarUrl || undefined}
                        icon="user"
                        size={46}
                      />
                      <View style={styles.discoveryBody}>
                        <View style={styles.discoveryTitleLine}>
                          <Text style={styles.rowTitle}>
                            {user.name || "未命名用户"}
                          </Text>
                          <Pill label={user.targetWorkspace.name} tone="accent" />
                        </View>
                        <Text style={styles.rowSubtitle}>
                          {user.email || "暂无邮箱信息"}
                        </Text>
                        <Text style={styles.rowCopy}>
                          来自 {user.targetWorkspace.name} 工作区
                        </Text>
                      </View>
                    </View>
                    <View style={styles.actionRow}>
                      <Button
                        label={
                          user.alreadyInWorkspaceContacts
                            ? "已加入共享"
                            : submitting?.kind === "workspace" &&
                                submitting.type === "user" &&
                                submitting.id === user.userId
                              ? "处理中..."
                              : "加到共享"
                        }
                        variant={
                          user.alreadyInWorkspaceContacts ? "secondary" : "primary"
                        }
                        onPress={() => void handleAddUser(user, "workspace")}
                        disabled={user.alreadyInWorkspaceContacts || !!submitting}
                        style={styles.actionButton}
                      />
                      <Button
                        label={
                          user.alreadyInPersonalContacts
                            ? "已收藏"
                            : submitting?.kind === "personal" &&
                                submitting.type === "user" &&
                                submitting.id === user.userId
                              ? "处理中..."
                              : "收藏到我"
                        }
                        variant={
                          user.alreadyInPersonalContacts ? "secondary" : "ghost"
                        }
                        onPress={() => void handleAddUser(user, "personal")}
                        disabled={user.alreadyInPersonalContacts || !!submitting}
                        style={styles.actionButton}
                      />
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <EmptyState
                icon="users"
                title="没有匹配到远端用户"
                description="可以尝试搜索姓名、邮箱或工作区名称。"
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
    gap: 12,
  },
  discoveryCard: {
    marginHorizontal: -18,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    gap: 14,
  },
  discoveryHeader: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
  },
  discoveryBody: {
    flex: 1,
    gap: 3,
  },
  discoveryTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  rowTitle: {
    flexShrink: 1,
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
  actionRow: {
    flexDirection: "row",
    gap: 10,
  },
  actionButton: {
    flex: 1,
  },
});
