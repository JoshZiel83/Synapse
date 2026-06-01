import Feather from "@expo/vector-icons/Feather"
import { useRouter } from "expo-router"
import { useDeferredValue, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  CONTACT_TARGET_TYPE,
  CONVERSATION_KIND,
  IDENTITY_SEARCH_MATCH_STATE,
  IDENTITY_SEARCH_OUTCOME,
} from "@shared"
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native"

import {
  Avatar,
  EmptyState,
  LoadingBlock,
  Pill,
  ScreenScroll,
  SectionBlock,
  SectionTitleRow,
} from "@/components/ui"
import { api } from "@/lib/api"
import { qk } from "@/lib/query-keys"
import { useChat } from "@/providers/chat-provider"
import { useWorkspace } from "@/providers/workspace-provider"
import { theme } from "@/theme/tokens"
import type {
  ContactHubEntryView,
  IdentitySearchMatchView,
  IdentitySearchResponse,
} from "@/types/api"
import type { ChatConversationView } from "@shared"

function matchesConversation(
  conversation: ChatConversationView,
  query: string
) {
  if (!query) return false
  return [conversation.title, conversation.lastItem?.previewText]
    .join(" ")
    .toLowerCase()
    .includes(query)
}

function matchesContact(entry: ContactHubEntryView, query: string) {
  if (!query) return false
  return [
    entry.title,
    entry.subtitle,
    entry.workspace.name,
    entry.relationLabel,
  ]
    .join(" ")
    .toLowerCase()
    .includes(query)
}

function buildSearchDetailParams(match: IdentitySearchMatchView) {
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
  }
}

function friendStateLabel(match: IdentitySearchMatchView) {
  switch (match.state) {
    case IDENTITY_SEARCH_MATCH_STATE.SAME_WORKSPACE_MEMBER:
      return "同 workspace 用户"
    case IDENTITY_SEARCH_MATCH_STATE.FRIEND:
      return "已是好友"
    case IDENTITY_SEARCH_MATCH_STATE.PENDING_REQUEST:
      return "好友申请待处理"
    default:
      return "可发起好友申请"
  }
}

export default function GlobalSearchScreen() {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const { conversations } = useChat()
  const [query, setQuery] = useState("")

  const deferredQuery = useDeferredValue(query.trim().toLowerCase())

  const hubQuery = useQuery({
    queryKey: workspaceId
      ? qk.contactHub(workspaceId)
      : ["contact-hub", "disabled"],
    queryFn: () => api.getContactHub(workspaceId!),
    enabled: !!workspaceId,
  })
  const hub = hubQuery.data ?? null
  const loading = hubQuery.isPending && !!workspaceId

  const identityQuery = useQuery({
    queryKey:
      workspaceId && deferredQuery
        ? qk.identitySearch(workspaceId, deferredQuery)
        : ["identity-search", "disabled"],
    queryFn: () => api.searchIdentity(workspaceId!, deferredQuery),
    enabled: !!workspaceId && !!deferredQuery,
    placeholderData: (prev) => prev, // keep prior results while typing
  })

  const identityResults: IdentitySearchResponse | null =
    !workspaceId || !deferredQuery ? null : (identityQuery.data ?? null)

  const friendIdMessage = useMemo<string | null>(() => {
    if (!workspaceId || !deferredQuery) return null
    if (identityQuery.error) {
      return identityQuery.error instanceof Error
        ? identityQuery.error.message
        : "搜索好友 ID 失败。"
    }
    const result = identityQuery.data
    if (!result) return null
    if (result.outcome === IDENTITY_SEARCH_OUTCOME.INVALID) {
      return "好友 ID 需为 4-32 位，只能包含字母、数字、点、下划线或短横线。"
    }
    if (result.outcome === IDENTITY_SEARCH_OUTCOME.NOT_FOUND) {
      return "没有匹配的好友 ID。"
    }
    if (result.outcome === IDENTITY_SEARCH_OUTCOME.SELF) {
      return "这是你自己的好友 ID。"
    }
    return null
  }, [workspaceId, deferredQuery, identityQuery.data, identityQuery.error])

  const matchedConversations = useMemo(
    () =>
      conversations.filter((item) => matchesConversation(item, deferredQuery)),
    [conversations, deferredQuery]
  )
  const matchedContacts = useMemo(
    () =>
      [
        ...(hub?.workspaceActors || []),
        ...(hub?.workspaceMembers || []),
        ...(hub?.friends || []),
      ].filter((item) => matchesContact(item, deferredQuery)),
    [deferredQuery, hub?.friends, hub?.workspaceActors, hub?.workspaceMembers]
  )

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
              action={
                <Text style={styles.countText}>
                  {matchedConversations.length} 条
                </Text>
              }
            />
            {matchedConversations.length > 0 ? (
              <View style={styles.listShell}>
                {matchedConversations.map((conversation) => (
                  <Pressable
                    key={conversation.conversationId}
                    onPress={() =>
                      router.push(`/chat/${conversation.conversationId}`)
                    }
                    style={({ pressed }) => [
                      styles.rowCard,
                      pressed && styles.rowCardPressed,
                    ]}
                  >
                    <Avatar
                      name={conversation.title}
                      icon="message-circle"
                      size={44}
                    />
                    <View style={styles.rowBody}>
                      <Text style={styles.rowTitle}>{conversation.title}</Text>
                      <Text numberOfLines={1} style={styles.rowSubtitle}>
                        {conversation.lastItem?.previewText?.trim() ||
                          "打开会话"}
                      </Text>
                    </View>
                    <Pill
                      label={
                        conversation.kind === CONVERSATION_KIND.DIRECT
                          ? "单聊"
                          : "群聊"
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
              action={
                <Text style={styles.countText}>
                  {matchedContacts.length} 条
                </Text>
              }
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
                      icon={
                        entry.targetType === CONTACT_TARGET_TYPE.ACTOR
                          ? "cpu"
                          : "user"
                      }
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
                  {identityResults?.matches?.length || 0} 条
                </Text>
              }
            />
            {identityResults?.matches?.length ? (
              <View style={styles.listShell}>
                {identityResults.matches.map((match) => (
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
                        })
                        return
                      }
                      router.push(buildSearchDetailParams(match))
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
                      <Text style={styles.metaText}>
                        {friendStateLabel(match)}
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
                icon="at-sign"
                title="没有匹配的好友 ID"
                description={friendIdMessage || "试试完整输入好友 ID。"}
              />
            )}
          </SectionBlock>
        </>
      )}
    </ScreenScroll>
  )
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
})
