import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  Avatar,
  EmptyState,
  LoadingBlock,
  Pill,
  ScreenScroll,
  SectionBlock,
  SectionTitleRow,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type {
  ContactHubEntryView,
  ContactHubResponse,
  ConversationSummaryView,
  FriendIdSearchMatchView,
  FriendIdSearchResponse,
} from "@/types/api";

function matchesConversation(conversation: ConversationSummaryView, query: string) {
  if (!query) return false;
  return [
    conversation.title,
    conversation.presentation?.title,
    conversation.lastMessage?.content,
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function matchesContact(entry: ContactHubEntryView, query: string) {
  if (!query) return false;
  return [entry.title, entry.subtitle, entry.workspace.name, entry.relationLabel]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function buildSearchDetailParams(match: FriendIdSearchMatchView) {
  return {
    pathname: "/contacts/search/[profileId]" as const,
    params: {
      profileId: match.profileId,
      title: match.title,
      subtitle: match.subtitle || "",
      avatarUrl: match.avatarUrl || "",
      workspaceName: match.workspace.name,
      workspaceSlug: match.workspace.slug,
      state: match.state,
    },
  };
}

function friendStateLabel(match: FriendIdSearchMatchView) {
  switch (match.state) {
    case "same_workspace_user":
      return "同 workspace 用户";
    case "friend":
      return "已是好友";
    case "pending_request":
      return "好友申请待处理";
    default:
      return "可发起好友申请";
  }
}

export default function GlobalSearchScreen() {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [conversations, setConversations] = useState<ConversationSummaryView[]>([]);
  const [hub, setHub] = useState<ContactHubResponse | null>(null);
  const [friendIdResults, setFriendIdResults] =
    useState<FriendIdSearchResponse | null>(null);
  const [friendIdMessage, setFriendIdMessage] = useState<string | null>(null);

  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  useEffect(() => {
    if (!workspaceId) {
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    void Promise.all([api.getThreads(workspaceId), api.getContactHub(workspaceId)])
      .then(([threadResponse, hubResponse]) => {
        if (!active) return;
        setConversations(threadResponse.conversations);
        setHub(hubResponse);
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId || !deferredQuery) {
      setFriendIdResults(null);
      setFriendIdMessage(null);
      return;
    }

    let active = true;
    void api
      .searchFriendId(workspaceId, deferredQuery)
      .then((result) => {
        if (!active) return;
        setFriendIdResults(result);
        if (result.outcome === "invalid") {
          setFriendIdMessage("好友 ID 需为 4-32 位，只能包含字母、数字、点、下划线或短横线。");
        } else if (result.outcome === "not_found") {
          setFriendIdMessage("没有匹配的好友 ID。");
        } else if (result.outcome === "self") {
          setFriendIdMessage("这是你自己的好友 ID。");
        } else {
          setFriendIdMessage(null);
        }
      })
      .catch((error) => {
        if (!active) return;
        setFriendIdResults(null);
        setFriendIdMessage(error instanceof Error ? error.message : "搜索好友 ID 失败。");
      });

    return () => {
      active = false;
    };
  }, [deferredQuery, workspaceId]);

  const matchedConversations = useMemo(
    () => conversations.filter((item) => matchesConversation(item, deferredQuery)),
    [conversations, deferredQuery],
  );
  const matchedContacts = useMemo(
    () =>
      [
        ...(hub?.workspaceActors || []),
        ...(hub?.workspaceUsers || []),
        ...(hub?.friends || []),
      ].filter((item) => matchesContact(item, deferredQuery)),
    [deferredQuery, hub?.friends, hub?.workspaceActors, hub?.workspaceUsers],
  );

  return (
    <ScreenScroll topPadding={0} bottomPadding={56}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.headerButton}>
          <Feather name="chevron-left" size={20} color={theme.colors.text} />
        </Pressable>
        <Text numberOfLines={1} style={styles.headerTitle}>
          搜索
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      <SectionBlock>
        <View style={styles.searchShell}>
          <Feather name="search" size={16} color={theme.colors.textSoft} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="搜索群聊记录、联系人或好友 ID"
            placeholderTextColor={theme.colors.textSoft}
            style={styles.searchInput}
            autoFocus
          />
        </View>
      </SectionBlock>

      {loading ? (
        <SectionBlock>
          <LoadingBlock label="正在准备搜索..." />
        </SectionBlock>
      ) : !deferredQuery ? (
        <SectionBlock>
          <EmptyState
            icon="search"
            title="输入关键词开始搜索"
            description="这里会同时搜索会话记录、已有联系人和好友 ID。"
          />
        </SectionBlock>
      ) : (
        <>
          <SectionBlock>
            <SectionTitleRow
              title="会话记录"
              action={<Text style={styles.countText}>{matchedConversations.length} 条</Text>}
            />
            {matchedConversations.length > 0 ? (
              <View style={styles.listShell}>
                {matchedConversations.map((conversation) => (
                  <Pressable
                    key={conversation.id}
                    onPress={() => router.push(`/chat/${conversation.id}`)}
                    style={({ pressed }) => [
                      styles.rowCard,
                      pressed && styles.rowCardPressed,
                    ]}
                  >
                    <Avatar
                      name={conversation.presentation?.title || conversation.title}
                      uri={conversation.presentation?.avatarUrl || conversation.avatarUrl}
                      icon="message-circle"
                      size={44}
                    />
                    <View style={styles.rowBody}>
                      <Text style={styles.rowTitle}>
                        {conversation.presentation?.title || conversation.title}
                      </Text>
                      <Text numberOfLines={1} style={styles.rowSubtitle}>
                        {conversation.lastMessage?.content?.trim() || "打开会话"}
                      </Text>
                    </View>
                    <Pill
                      label={
                        conversation.presentation?.chatType === "direct" ? "单聊" : "群聊"
                      }
                    />
                  </Pressable>
                ))}
              </View>
            ) : (
              <EmptyState
                icon="message-square"
                title="没有匹配的会话"
                description="试试别的关键词。"
              />
            )}
          </SectionBlock>

          <SectionBlock>
            <SectionTitleRow
              title="已有联系人"
              action={<Text style={styles.countText}>{matchedContacts.length} 条</Text>}
            />
            {matchedContacts.length > 0 ? (
              <View style={styles.listShell}>
                {matchedContacts.map((entry) => (
                  <Pressable
                    key={`${entry.kind}:${entry.id}`}
                    onPress={() =>
                      router.push({
                        pathname: "/contacts/[contactType]/[contactId]",
                        params: {
                          contactType: entry.kind,
                          contactId: entry.id,
                        },
                      })
                    }
                    style={({ pressed }) => [
                      styles.rowCard,
                      pressed && styles.rowCardPressed,
                    ]}
                  >
                    <Avatar
                      name={entry.title}
                      uri={entry.avatarUrl}
                      icon={entry.targetType === "actor" ? "cpu" : "user"}
                      size={44}
                    />
                    <View style={styles.rowBody}>
                      <Text style={styles.rowTitle}>{entry.title}</Text>
                      <Text numberOfLines={2} style={styles.rowSubtitle}>
                        {entry.subtitle || entry.workspace.name}
                      </Text>
                    </View>
                    <Pill label={entry.relationLabel} />
                  </Pressable>
                ))}
              </View>
            ) : (
              <EmptyState
                icon="users"
                title="没有匹配的联系人"
                description="试试姓名、邮箱、Workspace 名称或角色名。"
              />
            )}
          </SectionBlock>

          <SectionBlock>
            <SectionTitleRow
              title="好友 ID"
              action={
                <Text style={styles.countText}>
                  {friendIdResults?.matches?.length || 0} 条
                </Text>
              }
            />
            {friendIdResults?.matches?.length ? (
              <View style={styles.listShell}>
                {friendIdResults.matches.map((match) => (
                  <Pressable
                    key={match.profileId}
                    onPress={() => {
                      if (match.contact) {
                        router.push({
                          pathname: "/contacts/[contactType]/[contactId]",
                          params: {
                            contactType: match.contact.kind,
                            contactId: match.contact.id,
                          },
                        });
                        return;
                      }
                      router.push(buildSearchDetailParams(match));
                    }}
                    style={({ pressed }) => [
                      styles.rowCard,
                      pressed && styles.rowCardPressed,
                    ]}
                  >
                    <Avatar
                      name={match.title}
                      uri={match.avatarUrl}
                      icon="user"
                      size={44}
                    />
                    <View style={styles.rowBody}>
                      <Text style={styles.rowTitle}>{match.title}</Text>
                      <Text numberOfLines={2} style={styles.rowSubtitle}>
                        {match.subtitle}
                      </Text>
                      <Text style={styles.metaText}>{friendStateLabel(match)}</Text>
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
                icon="at-sign"
                title="没有匹配的好友 ID"
                description={friendIdMessage || "试试完整输入好友 ID。"}
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
    paddingBottom: 10,
    minHeight: 62,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 12,
  },
  headerButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    fontSize: 22,
    fontWeight: "800",
    color: theme.colors.text,
  },
  headerSpacer: {
    width: 32,
  },
  searchShell: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
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
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowCardPressed: {
    backgroundColor: theme.colors.backgroundAlt,
  },
  rowBody: {
    flex: 1,
    gap: 4,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: theme.colors.text,
  },
  rowSubtitle: {
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.textMuted,
  },
  metaText: {
    fontSize: 12,
    color: theme.colors.textSoft,
  },
});
