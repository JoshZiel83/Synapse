import Feather from "@expo/vector-icons/Feather";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import {
  Avatar,
  Button,
  EmptyState,
  Field,
  MobilePageHeader,
  Pill,
  ScreenScroll,
  SectionBlock,
  SectionTitleRow,
} from "@/components/ui";
import { api } from "@/lib/api";
import { API_BASE } from "@/lib/config";
import { useSession } from "@/providers/session-provider";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type { FriendIdProfileView } from "@/types/api";

export default function MeTab() {
  const { user, signOut, updateProfile } = useSession();
  const {
    workspaceId,
    workspaceName,
    workspaces,
    setWorkspaceId,
    needsOnboarding,
  } = useWorkspace();
  const [name, setName] = useState(user?.name || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [friendIdProfile, setFriendIdProfile] =
    useState<FriendIdProfileView | null>(null);
  const [friendIdDraft, setFriendIdDraft] = useState("");
  const [friendIdSaving, setFriendIdSaving] = useState(false);
  const [friendIdMessage, setFriendIdMessage] = useState<string | null>(null);

  useEffect(() => {
    setName(user?.name || "");
  }, [user?.name]);

  useEffect(() => {
    if (!workspaceId) {
      setFriendIdProfile(null);
      setFriendIdDraft("");
      return;
    }

    let active = true;
    void api
      .getMyFriendIdProfile(workspaceId)
      .then((profile) => {
        if (!active) return;
        setFriendIdProfile(profile);
        setFriendIdDraft(profile.friendId);
      })
      .catch(() => {
        if (!active) return;
        setFriendIdProfile(null);
      });

    return () => {
      active = false;
    };
  }, [workspaceId]);

  async function handleSaveProfile() {
    if (!name.trim()) {
      setError("名称不能为空。");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await updateProfile({ name: name.trim() });
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "保存资料失败。",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveFriendId() {
    if (!workspaceId) return;

    setFriendIdSaving(true);
    setFriendIdMessage(null);
    try {
      const nextProfile = await api.updateMyFriendIdProfile(workspaceId, {
        friendId: friendIdDraft,
        searchByIdEnabled: friendIdProfile?.searchByIdEnabled,
      });
      setFriendIdProfile(nextProfile);
      setFriendIdDraft(nextProfile.friendId);
      setFriendIdMessage(`好友 ID 已更新为 ${nextProfile.friendId}`);
    } catch (nextError) {
      setFriendIdMessage(
        nextError instanceof Error ? nextError.message : "保存好友 ID 失败。",
      );
    } finally {
      setFriendIdSaving(false);
    }
  }

  async function handleToggleFriendIdSearch() {
    if (!workspaceId || !friendIdProfile) return;

    setFriendIdSaving(true);
    setFriendIdMessage(null);
    try {
      const nextProfile = await api.updateMyFriendIdProfile(workspaceId, {
        friendId: friendIdProfile.friendId,
        searchByIdEnabled: !friendIdProfile.searchByIdEnabled,
      });
      setFriendIdProfile(nextProfile);
      setFriendIdDraft(nextProfile.friendId);
      setFriendIdMessage(
        nextProfile.searchByIdEnabled
          ? "已开启通过好友 ID 搜索。"
          : "已关闭通过好友 ID 搜索。",
      );
    } catch (nextError) {
      setFriendIdMessage(
        nextError instanceof Error ? nextError.message : "更新搜索开关失败。",
      );
    } finally {
      setFriendIdSaving(false);
    }
  }

  return (
    <ScreenScroll bottomPadding={52} topPadding={0}>
      <MobilePageHeader title="我的" />

      <SectionBlock>
        <View style={styles.profileCard}>
          <Avatar
            name={user?.name || user?.email}
            uri={user?.avatarUrl}
            size={62}
            icon="user"
          />
          <View style={styles.profileBody}>
            <Text style={styles.profileName}>{user?.name || "未命名用户"}</Text>
            <Text style={styles.profileEmail}>{user?.email || "未登录"}</Text>
          </View>
          {workspaceName ? <Pill label={workspaceName} tone="primary" /> : null}
        </View>
      </SectionBlock>

      <SectionBlock>
        <SectionTitleRow title="个人资料" />
        <Field
          label="显示名称"
          value={name}
          onChangeText={setName}
          placeholder="输入你希望在移动端展示的名称"
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button
          label={saving ? "保存中..." : "保存个人资料"}
          icon="save"
          onPress={() => void handleSaveProfile()}
          disabled={saving}
        />
      </SectionBlock>

      <SectionBlock>
        <SectionTitleRow title="好友 ID" />
        <Field
          label="唯一 ID"
          value={friendIdDraft}
          onChangeText={setFriendIdDraft}
          placeholder="输入你的好友 ID"
          autoCapitalize="none"
          autoCorrect={false}
          hint="好友 ID 整个平台唯一，默认关闭被搜索。"
        />
        {friendIdMessage ? (
          <Text style={styles.workspaceMeta}>{friendIdMessage}</Text>
        ) : null}
        <View style={styles.friendIdActions}>
          <Button
            label={friendIdSaving ? "保存中..." : "保存 ID"}
            icon="save"
            variant="secondary"
            onPress={() => void handleSaveFriendId()}
            disabled={friendIdSaving || !friendIdDraft.trim()}
            style={styles.friendIdButton}
          />
          <Button
            label={
              friendIdProfile?.searchByIdEnabled ? "关闭搜索" : "开启搜索"
            }
            icon={friendIdProfile?.searchByIdEnabled ? "eye-off" : "eye"}
            variant="secondary"
            onPress={() => void handleToggleFriendIdSearch()}
            disabled={friendIdSaving || !friendIdProfile}
            style={styles.friendIdButton}
          />
        </View>
      </SectionBlock>

      <SectionBlock>
        <SectionTitleRow
          title="工作区"
          action={
            !needsOnboarding ? (
              <Text style={styles.workspaceMeta}>{workspaces.length} 个</Text>
            ) : null
          }
        />
        {needsOnboarding ? (
          <EmptyState
            icon="briefcase"
            title="当前还没有工作区"
            description="请先在 Web 端创建 workspace，再回到移动端继续。"
          />
        ) : (
          <View style={styles.listShell}>
            {workspaces.map((workspace) => {
              const active = workspace.id === workspaceId;
              return (
                <Pressable
                  key={workspace.id}
                  onPress={() => void setWorkspaceId(workspace.id)}
                  style={[
                    styles.workspaceRow,
                    active && styles.workspaceRowActive,
                  ]}
                >
                  <View style={styles.workspaceText}>
                    <Text
                      style={[
                        styles.workspaceName,
                        active && styles.workspaceNameActive,
                      ]}
                    >
                      {workspace.name}
                    </Text>
                    <Text
                      style={[
                        styles.workspaceSlug,
                        active && styles.workspaceSlugActive,
                      ]}
                    >
                      {workspace.slug}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.workspaceBadge,
                      active && styles.workspaceBadgeActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.workspaceState,
                        active && styles.workspaceStateActive,
                      ]}
                    >
                      {active ? "当前" : "切换"}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </SectionBlock>

      <SectionBlock>
        <SectionTitleRow title="设备操作" />
        <View style={styles.listShell}>
          <ActionRow
            label="退出登录"
            icon="log-out"
            danger
            onPress={() => void signOut()}
          />
        </View>
        <Text style={styles.connectionHint}>API：{API_BASE}</Text>
      </SectionBlock>
    </ScreenScroll>
  );
}

function ActionRow({
  label,
  icon,
  onPress,
  danger = false,
}: {
  label: string;
  icon: keyof typeof Feather.glyphMap;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionRow,
        pressed && styles.actionRowPressed,
      ]}
    >
      <View style={styles.actionRowLead}>
        <Feather
          name={icon}
          size={18}
          color={danger ? theme.colors.danger : theme.colors.primary}
        />
        <Text style={[styles.actionLabel, danger && styles.actionLabelDanger]}>
          {label}
        </Text>
      </View>
      <Feather name="chevron-right" size={18} color={theme.colors.textSoft} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  profileBody: {
    flex: 1,
    gap: 4,
  },
  profileName: {
    fontSize: 18,
    fontWeight: "800",
    color: theme.colors.text,
  },
  profileEmail: {
    fontSize: 13,
    color: theme.colors.textMuted,
  },
  error: {
    fontSize: 13,
    color: theme.colors.danger,
  },
  workspaceMeta: {
    fontSize: 12,
    color: theme.colors.textSoft,
  },
  friendIdActions: {
    flexDirection: "row",
    gap: 10,
  },
  friendIdButton: {
    flex: 1,
  },
  listShell: {
    marginTop: 2,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  workspaceRow: {
    marginHorizontal: -18,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    backgroundColor: theme.colors.surface,
  },
  workspaceRowActive: {
    backgroundColor: theme.colors.primarySoft,
  },
  workspaceText: {
    flex: 1,
    gap: 4,
  },
  workspaceName: {
    fontSize: 15,
    fontWeight: "700",
    color: theme.colors.text,
  },
  workspaceNameActive: {
    color: theme.colors.text,
  },
  workspaceSlug: {
    fontSize: 12,
    color: theme.colors.textSoft,
  },
  workspaceSlugActive: {
    color: theme.colors.primary,
  },
  workspaceBadge: {
    minWidth: 48,
    borderRadius: theme.radii.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: theme.colors.surfaceMuted,
    alignItems: "center",
  },
  workspaceBadgeActive: {
    backgroundColor: theme.colors.primary,
  },
  workspaceState: {
    fontSize: 12,
    fontWeight: "800",
    color: theme.colors.textMuted,
  },
  workspaceStateActive: {
    color: theme.colors.white,
  },
  actionRow: {
    marginHorizontal: -18,
    paddingHorizontal: 18,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: theme.colors.surface,
  },
  actionRowPressed: {
    backgroundColor: theme.colors.surfaceMuted,
  },
  actionRowLead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  actionLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: theme.colors.text,
  },
  actionLabelDanger: {
    color: theme.colors.danger,
  },
  connectionHint: {
    fontSize: 12,
    color: theme.colors.textSoft,
  },
});
