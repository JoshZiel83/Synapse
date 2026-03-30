import Feather from "@expo/vector-icons/Feather";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
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
import {
  actorSummary,
  scopedContactName,
  scopedContactSubtitle,
  scopedContactSummary,
  titleCase,
} from "@/lib/contacts";
import { api } from "@/lib/api";
import { useSession } from "@/providers/session-provider";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type { ScopedContactView, WorkspaceMemberView } from "@/types/api";
import type { Actor } from "@shared";

export default function NewGroupConversationScreen() {
  const router = useRouter();
  const { user } = useSession();
  const { workspaceId } = useWorkspace();
  const { actorId, userId, contactScope, contactId } = useLocalSearchParams<{
    actorId?: string;
    userId?: string;
    contactScope?: "workspace" | "personal";
    contactId?: string;
  }>();
  const [actors, setActors] = useState<Actor[]>([]);
  const [members, setMembers] = useState<WorkspaceMemberView[]>([]);
  const [workspaceContacts, setWorkspaceContacts] = useState<
    ScopedContactView[]
  >([]);
  const [personalContacts, setPersonalContacts] = useState<ScopedContactView[]>(
    [],
  );
  const [selectedActorIds, setSelectedActorIds] = useState<string[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [selectedWorkspaceContactIds, setSelectedWorkspaceContactIds] =
    useState<string[]>([]);
  const [selectedPersonalContactIds, setSelectedPersonalContactIds] = useState<
    string[]
  >([]);
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
        const [actorsResponse, membersResponse, contactsResponse] =
          await Promise.all([
            api.getActors(workspaceId),
            api.getWorkspaceMembers(workspaceId),
            api.getScopedContacts(workspaceId),
          ]);

        const nextActors = actorsResponse.actors.filter(
          (item) => item.isActive,
        );
        const nextMembers = (membersResponse.data ?? []).filter(
          (item) => item.userId !== user?.id,
        );

        setActors(nextActors);
        setMembers(nextMembers);
        setWorkspaceContacts(contactsResponse.workspaceContacts);
        setPersonalContacts(contactsResponse.personalContacts);
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
        setSelectedWorkspaceContactIds(
          contactScope === "workspace" &&
            contactId &&
            contactsResponse.workspaceContacts.some((item) => item.id === contactId)
            ? [contactId]
            : [],
        );
        setSelectedPersonalContactIds(
          contactScope === "personal" &&
            contactId &&
            contactsResponse.personalContacts.some((item) => item.id === contactId)
            ? [contactId]
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
  }, [actorId, contactId, contactScope, user?.id, userId, workspaceId]);

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

  const selectedRemoteContacts = useMemo(
    () => [
      ...workspaceContacts.filter((contact) =>
        selectedWorkspaceContactIds.includes(contact.id),
      ),
      ...personalContacts.filter((contact) =>
        selectedPersonalContactIds.includes(contact.id),
      ),
    ],
    [
      personalContacts,
      selectedPersonalContactIds,
      selectedWorkspaceContactIds,
      workspaceContacts,
    ],
  );

  const remoteActorIds = useMemo(
    () =>
      selectedRemoteContacts
        .map((contact) => contact.actor?.id)
        .filter((value): value is string => Boolean(value)),
    [selectedRemoteContacts],
  );
  const remoteUserIds = useMemo(
    () =>
      selectedRemoteContacts
        .map((contact) => contact.user?.id)
        .filter((value): value is string => Boolean(value)),
    [selectedRemoteContacts],
  );

  const hasRemoteSelection =
    remoteActorIds.length > 0 || remoteUserIds.length > 0;
  const selectedCount =
    selectedActorIds.length +
    selectedUserIds.length +
    selectedWorkspaceContactIds.length +
    selectedPersonalContactIds.length;

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

  function toggleWorkspaceContact(contactIdValue: string) {
    setSelectedWorkspaceContactIds((current) =>
      current.includes(contactIdValue)
        ? current.filter((id) => id !== contactIdValue)
        : [...current, contactIdValue],
    );
  }

  function togglePersonalContact(contactIdValue: string) {
    setSelectedPersonalContactIds((current) =>
      current.includes(contactIdValue)
        ? current.filter((id) => id !== contactIdValue)
        : [...current, contactIdValue],
    );
  }

  async function handleCreateConversation() {
    if (!workspaceId || selectedCount === 0 || submitting) {
      return;
    }

    setSubmitting(true);
    try {
      const created = await api.createThread({
        domain: hasRemoteSelection ? "social" : "workspace",
        kind: "group",
        workspaceId: hasRemoteSelection ? undefined : workspaceId,
        actorIds: Array.from(
          new Set([...selectedActorIds, ...remoteActorIds]),
        ),
        userIds: Array.from(new Set([...selectedUserIds, ...remoteUserIds])),
      });
      const conversationId =
        created.threadId || created.conversationId || created.id;

      if (!conversationId) {
        throw new Error("服务器没有返回 conversationId");
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
          选择至少一个角色、成员或跨工作区联系人。当前工作区中的你会自动加入这个群聊。
        </Text>
        <View style={styles.modeRow}>
          <Pill
            label={hasRemoteSelection ? "Social 群聊" : "Workspace 群聊"}
            tone={hasRemoteSelection ? "accent" : "primary"}
          />
          <Text style={styles.modeCopy}>
            {hasRemoteSelection
              ? "已选择跨工作区联系人，创建后会走 social thread。"
              : "当前只选择了本地成员，创建后会留在当前 workspace。"}
          </Text>
        </View>
        <View style={styles.searchShell}>
          <Feather name="search" size={16} color={theme.colors.textSoft} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="搜索角色、成员或远端联系人"
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
              title="选择本地角色"
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
              title="选择本地成员"
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
            <Text style={styles.sectionHint}>
              整个工作区都可见的跨工作区联系人
            </Text>
            <SectionTitleRow
              title="选择共享联系人"
              action={
                <Text style={styles.countText}>
                  已选 {selectedWorkspaceContactIds.length} 个
                </Text>
              }
            />
            {visibleWorkspaceContacts.length > 0 ? (
              <View style={styles.listShell}>
                {visibleWorkspaceContacts.map((contact) => (
                  <SelectableScopedContactRow
                    key={contact.id}
                    contact={contact}
                    selected={selectedWorkspaceContactIds.includes(contact.id)}
                    onPress={() => toggleWorkspaceContact(contact.id)}
                  />
                ))}
              </View>
            ) : (
              <EmptyState
                icon="briefcase"
                title="还没有共享联系人"
                description="先去联系人页把远端用户或角色加入共享联系人簿。"
              />
            )}
          </SectionBlock>

          <SectionBlock>
            <Text style={styles.sectionHint}>
              只属于你自己的跨工作区联系人
            </Text>
            <SectionTitleRow
              title="选择我的联系人"
              action={
                <Text style={styles.countText}>
                  已选 {selectedPersonalContactIds.length} 个
                </Text>
              }
            />
            {visiblePersonalContacts.length > 0 ? (
              <View style={styles.listShell}>
                {visiblePersonalContacts.map((contact) => (
                  <SelectableScopedContactRow
                    key={contact.id}
                    contact={contact}
                    selected={selectedPersonalContactIds.includes(contact.id)}
                    onPress={() => togglePersonalContact(contact.id)}
                  />
                ))}
              </View>
            ) : (
              <EmptyState
                icon="bookmark"
                title="还没有个人联系人"
                description="先去远端发现页保存一些个人联系人。"
              />
            )}
          </SectionBlock>

          <SectionBlock>
            {selectedCount === 0 ? (
              <Text style={styles.warningText}>
                至少选择一个角色、成员或联系人，才能创建新的群聊。
              </Text>
            ) : null}
            <Button
              label={submitting ? "创建中..." : "创建群聊"}
              icon="message-circle"
              onPress={() => void handleCreateConversation()}
              disabled={selectedCount === 0 || submitting}
            />
          </SectionBlock>
        </>
      )}
    </ScreenScroll>
  );
}

function SelectableScopedContactRow({
  contact,
  selected,
  onPress,
}: {
  contact: ScopedContactView;
  selected: boolean;
  onPress: () => void;
}) {
  const name = scopedContactName(contact);
  const subtitle = scopedContactSubtitle(contact);
  const copy = scopedContactSummary(contact);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.rowCard, pressed && styles.rowCardPressed]}
    >
      <Avatar
        name={name}
        uri={contact.actor?.avatarUrl || contact.user?.avatarUrl || undefined}
        icon={contact.targetType === "actor" ? "cpu" : "user"}
        size={44}
      />
      <View style={styles.rowBody}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle}>{name}</Text>
          <Pill
            label={contact.scope === "workspace" ? "共享" : "我的"}
            tone={contact.scope === "workspace" ? "primary" : "accent"}
          />
        </View>
        <Text style={styles.rowSubtitle}>{subtitle}</Text>
        <Text numberOfLines={2} style={styles.rowCopy}>
          {copy}
        </Text>
      </View>
      <CheckBadge selected={selected} />
    </Pressable>
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
  modeRow: {
    gap: 8,
  },
  modeCopy: {
    fontSize: 13,
    color: theme.colors.textSoft,
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
