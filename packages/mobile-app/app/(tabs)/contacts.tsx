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
  Pill,
  ScreenScroll,
  SectionBlock,
  SectionTitleRow,
} from "@/components/ui";
import {
  actorSummary,
  scopedContactName,
  scopedContactSubtitle,
  scopedContactSummary,
  titleCase,
} from "@/lib/contacts";
import { api } from "@/lib/api";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type {
  ScopedContactView,
  WorkspaceMemberView,
} from "@/types/api";
import type { Actor } from "@shared";

type DirectoryMode = "actors" | "people";

export default function ContactsTab() {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const [mode, setMode] = useState<DirectoryMode>("actors");
  const [actors, setActors] = useState<Actor[]>([]);
  const [members, setMembers] = useState<WorkspaceMemberView[]>([]);
  const [workspaceContacts, setWorkspaceContacts] = useState<
    ScopedContactView[]
  >([]);
  const [personalContacts, setPersonalContacts] = useState<ScopedContactView[]>(
    [],
  );
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
      setWorkspaceContacts([]);
      setPersonalContacts([]);
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
      const [membersResponse, actorsResponse, contactsResponse] =
        await Promise.all([
          api.getWorkspaceMembers(workspaceId),
          api.getActors(workspaceId),
          api.getScopedContacts(workspaceId),
        ]);

      setMembers(membersResponse.data ?? []);
      setActors(actorsResponse.actors.filter((actor) => actor.isActive));
      setWorkspaceContacts(contactsResponse.workspaceContacts);
      setPersonalContacts(contactsResponse.personalContacts);
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

  const visibleWorkspaceContacts = useMemo(() => {
    if (!normalizedQuery) return workspaceContacts;
    return workspaceContacts.filter((contact) =>
      [
        scopedContactName(contact),
        scopedContactSubtitle(contact),
        scopedContactSummary(contact),
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [normalizedQuery, workspaceContacts]);

  const visiblePersonalContacts = useMemo(() => {
    if (!normalizedQuery) return personalContacts;
    return personalContacts.filter((contact) =>
      [
        scopedContactName(contact),
        scopedContactSubtitle(contact),
        scopedContactSummary(contact),
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [normalizedQuery, personalContacts]);

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
          <View style={styles.headerActions}>
            <Pressable
              onPress={() => router.push("/contacts/discover")}
              style={({ pressed }) => [
                styles.headerAction,
                pressed && styles.headerActionPressed,
              ]}
            >
              <Feather
                name="compass"
                size={18}
                color={theme.colors.text}
              />
            </Pressable>
            <Pressable
              onPress={() => router.push("/contacts/group/new")}
              style={({ pressed }) => [
                styles.headerAction,
                pressed && styles.headerActionPressed,
              ]}
            >
              <Feather name="plus" size={18} color={theme.colors.text} />
            </Pressable>
          </View>
        }
      />

      <SectionBlock>
        <Text style={styles.tipText}>
          这里会同时展示当前工作区目录，以及你保存的跨工作区联系人。
        </Text>
        <View style={styles.searchShell}>
          <Feather name="search" size={16} color={theme.colors.textSoft} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="搜索联系人、工作区、邮箱或角色说明"
            placeholderTextColor={theme.colors.textSoft}
            style={styles.searchInput}
          />
        </View>
        <View style={styles.segment}>
          <SegmentButton
            label="角色目录"
            active={mode === "actors"}
            onPress={() => setMode("actors")}
          />
          <SegmentButton
            label="成员目录"
            active={mode === "people"}
            onPress={() => setMode("people")}
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
      ) : (
        <>
          <SectionBlock>
            <Text style={styles.sectionHint}>
              整个工作区共用的跨工作区联系人簿
            </Text>
            <SectionTitleRow
              title="工作区共享联系人"
              action={
                <Text style={styles.countText}>
                  {visibleWorkspaceContacts.length} 个
                </Text>
              }
            />
            {visibleWorkspaceContacts.length > 0 ? (
              <View style={styles.listShell}>
                {visibleWorkspaceContacts.map((contact) => (
                  <ScopedContactRow
                    key={contact.id}
                    contact={contact}
                    onPress={() =>
                      router.push({
                        pathname: "/contacts/[contactType]/[contactId]",
                        params: {
                          contactType: "workspace-contact",
                          contactId: contact.id,
                        },
                      })
                    }
                  />
                ))}
              </View>
            ) : (
              <EmptyState
                icon="briefcase"
                title="还没有共享联系人"
                description="去远端发现页把别的工作区用户或角色加入这个工作区的联系人簿。"
              />
            )}
          </SectionBlock>

          <SectionBlock>
            <Text style={styles.sectionHint}>
              只属于你自己的跨工作区联系人
            </Text>
            <SectionTitleRow
              title="我的联系人"
              action={
                <Text style={styles.countText}>
                  {visiblePersonalContacts.length} 个
                </Text>
              }
            />
            {visiblePersonalContacts.length > 0 ? (
              <View style={styles.listShell}>
                {visiblePersonalContacts.map((contact) => (
                  <ScopedContactRow
                    key={contact.id}
                    contact={contact}
                    onPress={() =>
                      router.push({
                        pathname: "/contacts/[contactType]/[contactId]",
                        params: {
                          contactType: "personal-contact",
                          contactId: contact.id,
                        },
                      })
                    }
                  />
                ))}
              </View>
            ) : (
              <EmptyState
                icon="bookmark"
                title="还没有个人联系人"
                description="你可以把远端用户或角色先收藏为个人联系人，再单独发起私聊或拉群。"
              />
            )}
          </SectionBlock>

          {mode === "actors" ? (
            <SectionBlock>
              <SectionTitleRow
                title="当前工作区角色目录"
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
                title="当前工作区成员目录"
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
        </>
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

function ScopedContactRow({
  contact,
  onPress,
}: {
  contact: ScopedContactView;
  onPress: () => void;
}) {
  const name = scopedContactName(contact);
  const subtitle = scopedContactSubtitle(contact);
  const copy = scopedContactSummary(contact);
  const icon = contact.targetType === "actor" ? "cpu" : "user";
  const avatarUri = contact.actor?.avatarUrl || contact.user?.avatarUrl;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.rowCard, pressed && styles.rowCardPressed]}
    >
      <Avatar name={name} uri={avatarUri || undefined} icon={icon} size={46} />
      <View style={styles.rowBody}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle}>{name}</Text>
          <Pill
            label={contact.scope === "workspace" ? "共享" : "我的"}
            tone={contact.scope === "workspace" ? "primary" : "accent"}
          />
        </View>
        <Text style={styles.rowSubtitle}>{subtitle}</Text>
        <Text style={styles.rowCopy}>{copy}</Text>
      </View>
      <Feather
        name="chevron-right"
        size={18}
        color={theme.colors.textSoft}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headerActions: {
    flexDirection: "row",
    gap: 8,
  },
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
  tipText: {
    fontSize: 13,
    lineHeight: 20,
    color: theme.colors.textMuted,
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
  sectionHint: {
    fontSize: 13,
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
  rowTitleLine: {
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
});
