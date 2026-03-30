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
import {
  actorSummary,
  scopedContactName,
  scopedContactSubtitle,
  scopedContactSummary,
  titleCase,
} from "@/lib/contacts";
import {
  conversationIncludesActor,
  conversationIncludesUser,
  findConversationForUser,
  findDirectConversationForActor,
  findSocialConversationForActor,
  findSocialConversationForUser,
  isGroupConversation,
} from "@/lib/conversations";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type {
  ConversationSummaryView,
  ScopedContactView,
  WorkspaceMemberView,
} from "@/types/api";
import type { Actor } from "@shared";

type ContactType =
  | "actor"
  | "member"
  | "workspace-contact"
  | "personal-contact";

export default function ContactDetailScreen() {
  const router = useRouter();
  const { contactType, contactId } = useLocalSearchParams<{
    contactType: ContactType;
    contactId: string;
  }>();
  const { workspaceId } = useWorkspace();
  const [actors, setActors] = useState<Actor[]>([]);
  const [members, setMembers] = useState<WorkspaceMemberView[]>([]);
  const [workspaceContacts, setWorkspaceContacts] = useState<
    ScopedContactView[]
  >([]);
  const [personalContacts, setPersonalContacts] = useState<ScopedContactView[]>(
    [],
  );
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
        const [
          actorsResponse,
          membersResponse,
          conversationsResponse,
          contactsResponse,
        ] = await Promise.all([
          api.getActors(workspaceId),
          api.getWorkspaceMembers(workspaceId),
          api.getConversations(workspaceId),
          api.getScopedContacts(workspaceId),
        ]);

        setActors(actorsResponse.actors.filter((actor) => actor.isActive));
        setMembers(membersResponse.data ?? []);
        setConversations(conversationsResponse.conversations);
        setWorkspaceContacts(contactsResponse.workspaceContacts);
        setPersonalContacts(contactsResponse.personalContacts);
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
  const workspaceContact =
    contactType === "workspace-contact"
      ? (workspaceContacts.find((item) => item.id === contactId) ?? null)
      : null;
  const personalContact =
    contactType === "personal-contact"
      ? (personalContacts.find((item) => item.id === contactId) ?? null)
      : null;
  const savedContact = workspaceContact || personalContact;

  const relatedGroups = useMemo(() => {
    const targetActorId = actor?.id || savedContact?.actor?.id;
    const targetUserId = member?.userId || savedContact?.user?.id;

    if (targetActorId) {
      return conversations.filter(
        (conversation) =>
          isGroupConversation(conversation) &&
          conversationIncludesActor(conversation, targetActorId),
      );
    }

    if (targetUserId) {
      return conversations.filter(
        (conversation) =>
          isGroupConversation(conversation) &&
          conversationIncludesUser(conversation, targetUserId),
      );
    }

    return [];
  }, [actor, conversations, member, savedContact]);

  async function handleGoChat() {
    if (!workspaceId || submitting) return;

    setSubmitting(true);
    try {
      if (savedContact?.actor) {
        const existing = findSocialConversationForActor(
          conversations,
          savedContact.actor.id,
        );
        if (existing) {
          router.push(`/chat/${existing.id}`);
          return;
        }

        const created = await api.createThread({
          domain: "social",
          kind: "private",
          actorIds: [savedContact.actor.id],
        });
        const conversationId =
          created.threadId || created.conversationId || created.id;
        if (conversationId) {
          router.replace(`/chat/${conversationId}`);
        }
        return;
      }

      if (savedContact?.user) {
        const existing = findSocialConversationForUser(
          conversations,
          savedContact.user.id,
        );
        if (existing) {
          router.push(`/chat/${existing.id}`);
          return;
        }

        const created = await api.createThread({
          domain: "social",
          kind: "private",
          userIds: [savedContact.user.id],
        });
        const conversationId =
          created.threadId || created.conversationId || created.id;
        if (conversationId) {
          router.replace(`/chat/${conversationId}`);
        }
        return;
      }

      if (actor) {
        const existing = findDirectConversationForActor(
          conversations,
          actor.id,
        );
        if (existing) {
          router.push(`/chat/${existing.id}`);
          return;
        }

        const created = await api.createThread({
          domain: "workspace",
          kind: "private",
          workspaceId,
          actorIds: [actor.id],
        });
        const conversationId =
          created.threadId || created.conversationId || created.id;
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

        const created = await api.createThread({
          domain: "workspace",
          kind: "private",
          workspaceId,
          userIds: [member.userId],
        });
        const conversationId =
          created.threadId || created.conversationId || created.id;
        if (conversationId) {
          router.replace(`/chat/${conversationId}`);
        }
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleStartGroup() {
    if (actor) {
      router.push({
        pathname: "/contacts/group/new",
        params: { actorId: actor.id },
      });
      return;
    }

    if (member) {
      router.push({
        pathname: "/contacts/group/new",
        params: { userId: member.userId },
      });
      return;
    }

    if (savedContact) {
      router.push({
        pathname: "/contacts/group/new",
        params: {
          contactScope: savedContact.scope,
          contactId: savedContact.id,
        },
      });
    }
  }

  const title =
    actor?.definition.name ||
    member?.userName ||
    (savedContact ? scopedContactName(savedContact) : "联系人详情");
  const subtitle = actor
    ? actor.definition.title || titleCase(actor.definition.role)
    : member
      ? member.userEmail || "成员详情"
      : savedContact
        ? scopedContactSubtitle(savedContact)
        : "联系人详情";
  const avatarUrl =
    actor?.avatarUrl || member?.avatarUrl || savedContact?.actor?.avatarUrl || savedContact?.user?.avatarUrl;
  const icon = actor || savedContact?.actor ? "cpu" : "user";
  const chipLabel = actor
    ? "本地角色"
    : member
      ? member.trustLevel || "本地成员"
      : savedContact?.scope === "workspace"
        ? "共享联系人"
        : savedContact
          ? "我的联系人"
          : "联系人";
  const profileCopy = actor
    ? actorSummary(actor)
    : member
      ? `所在工作区权限级别：${member.trustLevel}`
      : savedContact
        ? scopedContactSummary(savedContact)
        : null;
  const scopeCopy = savedContact
    ? `来源工作区：${savedContact.targetWorkspace.name}`
    : null;

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
      ) : !actor && !member && !savedContact ? (
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
              <Avatar name={title} uri={avatarUrl} size={68} icon={icon} />
              <View style={styles.profileBody}>
                <Text style={styles.profileName}>{title}</Text>
                <Text style={styles.profileSubtitle}>{subtitle}</Text>
              </View>
              <Pill
                label={chipLabel}
                tone={savedContact ? "accent" : "primary"}
              />
            </View>
            {profileCopy ? (
              <Text style={styles.profileCopy}>{profileCopy}</Text>
            ) : null}
            {scopeCopy ? <Text style={styles.scopeCopy}>{scopeCopy}</Text> : null}
            <View style={styles.actionRow}>
              <Button
                label={submitting ? "处理中..." : "发起私聊"}
                icon="message-circle"
                onPress={() => void handleGoChat()}
                disabled={submitting}
                style={styles.actionButton}
              />
              <Button
                label="拉个群"
                icon="users"
                variant="secondary"
                onPress={handleStartGroup}
                style={styles.actionButton}
              />
            </View>
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
                title="暂时还没有关联群聊"
                description="等你把这个联系人拉进群聊后，这里会显示它所在的会话。"
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
    color: theme.colors.text,
  },
  scopeCopy: {
    fontSize: 13,
    color: theme.colors.textSoft,
  },
  actionRow: {
    flexDirection: "row",
    gap: 10,
  },
  actionButton: {
    flex: 1,
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
