import Feather from "@expo/vector-icons/Feather"
import { useRouter } from "expo-router"
import { useDeferredValue, useEffect, useState } from "react"
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native"

import {
  Avatar,
  Button,
  EmptyState,
  LoadingBlock,
  Pill,
  ScreenScroll,
  SectionBlock,
  SectionTitleRow,
} from "@/components/ui"
import { api } from "@/lib/api"
import { titleCase } from "@/lib/contacts"
import { useWorkspace } from "@/providers/workspace-provider"
import { theme } from "@/theme/tokens"
import type { IdentitySearchMatchView } from "@/types/api"

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

function requestStateLabel(match: IdentitySearchMatchView) {
  switch (match.state) {
    case "same_workspace_member":
      return "同工作区成员"
    case "friend":
    case "existing":
      return "已建立关系"
    case "pending_request":
    case "pending_approval":
      return "等待处理"
    case "approval_required":
      return "需要批准"
    case "available":
      return "可直接发起"
    default:
      return "可发起连接"
  }
}

export default function DiscoverContactsScreen() {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const [search, setSearch] = useState("")
  const [matches, setMatches] = useState<IdentitySearchMatchView[]>([])
  const [loading, setLoading] = useState(true)
  const [submittingProfileId, setSubmittingProfileId] = useState<string | null>(
    null
  )
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const deferredSearch = useDeferredValue(search)

  const actors = matches.filter((match) => match.targetType === "actor")
  const members = matches.filter((match) => match.targetType === "member")

  useEffect(() => {
    let cancelled = false

    async function loadDiscoveries() {
      if (!workspaceId) {
        setMatches([])
        setLoading(false)
        return
      }

      setLoading(true)

      try {
        const response = await api.searchIdentity(workspaceId, deferredSearch)
        if (cancelled) return

        setMatches(response.matches || [])
        setError(null)
      } catch (nextError) {
        if (cancelled) return
        setError(
          nextError instanceof Error
            ? nextError.message
            : "远端联系人发现失败。"
        )
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadDiscoveries()

    return () => {
      cancelled = true
    }
  }, [deferredSearch, workspaceId])

  async function handleRequest(match: IdentitySearchMatchView) {
    if (!workspaceId || submittingProfileId) return

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

    setSubmittingProfileId(match.profileId)
    setMessage(null)
    try {
      const result = await api.requestIdentityProfile(
        workspaceId,
        match.profileId
      )
      if (result.contact) {
        router.push({
          pathname: "/contacts/[contactType]/[contactId]",
          params: {
            contactType: result.contact.kind,
            contactId: result.contact.id,
          },
        })
        return
      }

      setMatches((current) =>
        current.map((item) =>
          item.profileId === match.profileId
            ? { ...item, state: "pending_request", requestId: result.requestId }
            : item
        )
      )
      setMessage("连接请求已提交，等待对方处理。")
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "发起连接失败。"
      )
    } finally {
      setSubmittingProfileId(null)
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
          搜索别的工作区里的成员或角色，然后直接发起关系请求；已经建立关系的对象会直接带你进入联系人详情。
        </Text>
        <View style={styles.searchShell}>
          <Feather name="search" size={16} color={theme.colors.textSoft} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="搜索工作区、成员名、邮箱或角色名"
            placeholderTextColor={theme.colors.textSoft}
            style={styles.searchInput}
          />
        </View>
        {message ? <Text style={styles.rowCopy}>{message}</Text> : null}
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
      ) : actors.length === 0 && members.length === 0 ? (
        <SectionBlock>
          <EmptyState
            icon="compass"
            title="没有发现结果"
            description="换个关键词试试，或者确认对方开启了身份搜索。"
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
                  <View
                    key={actor.actorId || actor.profileId}
                    style={styles.discoveryCard}
                  >
                    <View style={styles.discoveryHeader}>
                      <Avatar
                        name={actor.title}
                        uri={actor.avatarUrl || undefined}
                        icon="cpu"
                        size={46}
                      />
                      <View style={styles.discoveryBody}>
                        <View style={styles.discoveryTitleLine}>
                          <Text style={styles.rowTitle}>{actor.title}</Text>
                          <Pill label={actor.workspace.name} tone="accent" />
                        </View>
                        <Text style={styles.rowSubtitle}>
                          {actor.subtitle || titleCase(actor.targetType)}
                        </Text>
                        <Text style={styles.rowCopy}>
                          {requestStateLabel(actor)}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.actionRow}>
                      <Button
                        label={
                          actor.contact
                            ? "查看详情"
                            : submittingProfileId === actor.profileId
                              ? "处理中..."
                              : actor.state === "pending_request" ||
                                  actor.state === "pending_approval"
                                ? "等待处理"
                                : "发起连接"
                        }
                        variant={actor.contact ? "secondary" : "primary"}
                        onPress={() => void handleRequest(actor)}
                        disabled={
                          !!submittingProfileId ||
                          actor.state === "pending_request" ||
                          actor.state === "pending_approval"
                        }
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
              title="远端成员"
              action={<Text style={styles.countText}>{members.length} 个</Text>}
            />
            {members.length > 0 ? (
              <View style={styles.listShell}>
                {members.map((member) => (
                  <View key={member.profileId} style={styles.discoveryCard}>
                    <View style={styles.discoveryHeader}>
                      <Avatar
                        name={member.title || "远端成员"}
                        uri={member.avatarUrl || undefined}
                        icon="user"
                        size={46}
                      />
                      <View style={styles.discoveryBody}>
                        <View style={styles.discoveryTitleLine}>
                          <Text style={styles.rowTitle}>
                            {member.title || "未命名成员"}
                          </Text>
                          <Pill label={member.workspace.name} tone="accent" />
                        </View>
                        <Text style={styles.rowSubtitle}>
                          {member.subtitle || "暂无补充信息"}
                        </Text>
                        <Text style={styles.rowCopy}>
                          {requestStateLabel(member)}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.actionRow}>
                      <Button
                        label={
                          member.contact
                            ? "查看详情"
                            : submittingProfileId === member.profileId
                              ? "处理中..."
                              : member.state === "pending_request" ||
                                  member.state === "pending_approval"
                                ? "等待处理"
                                : "发起连接"
                        }
                        variant={member.contact ? "secondary" : "primary"}
                        onPress={() => void handleRequest(member)}
                        disabled={
                          !!submittingProfileId ||
                          member.state === "pending_request" ||
                          member.state === "pending_approval"
                        }
                        style={styles.actionButton}
                      />
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <EmptyState
                icon="users"
                title="没有匹配到远端成员"
                description="可以尝试搜索姓名、邮箱或工作区名称。"
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
})
