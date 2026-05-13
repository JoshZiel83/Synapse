import Feather from "@expo/vector-icons/Feather"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"

import {
  Avatar,
  Button,
  ScreenScroll,
  SectionBlock,
  SectionTitleRow,
} from "@/components/ui"
import { api } from "@/lib/api"
import { useWorkspace } from "@/providers/workspace-provider"
import { theme } from "@/theme/tokens"

type SearchState =
  | "same_workspace_member"
  | "friend"
  | "pending_request"
  | "requestable"

function statusLabel(state: SearchState) {
  switch (state) {
    case "same_workspace_member":
      return "同 workspace 用户"
    case "friend":
      return "已是好友"
    case "pending_request":
      return "好友申请待处理"
    default:
      return "可发起好友申请"
  }
}

export default function SearchContactDetailScreen() {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const params = useLocalSearchParams<{
    profileId: string
    title?: string
    subtitle?: string
    avatarUrl?: string
    workspaceName?: string
    workspaceSlug?: string
    state?: SearchState
  }>()
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const state = (params.state || "requestable") as SearchState

  async function handleRequestFriend() {
    if (!workspaceId || !params.profileId || submitting) return

    setSubmitting(true)
    setMessage(null)
    try {
      const result = await api.requestIdentityProfile(
        workspaceId,
        params.profileId
      )

      if (result.contact) {
        router.replace({
          pathname: "/contacts/[contactType]/[contactId]",
          params: {
            contactType: result.contact.kind,
            contactId: result.contact.id,
          },
        })
        return
      }

      setMessage(
        result.outcome === "friend_request_created"
          ? "好友申请已发出。"
          : result.outcome === "friend_request_pending"
            ? "好友申请正在等待处理。"
            : result.outcome === "friend_active"
              ? "已经是好友了。"
              : "操作已提交。"
      )
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "发起好友申请失败。")
    } finally {
      setSubmitting(false)
    }
  }

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

      <SectionBlock>
        <View style={styles.heroRow}>
          <Avatar
            name={params.title || "用户"}
            uri={params.avatarUrl}
            size={68}
            icon="user"
          />
          <View style={styles.heroBody}>
            <Text style={styles.heroTitle}>{params.title || "未命名用户"}</Text>
            <Text style={styles.heroSubtitle}>
              {params.subtitle || params.workspaceName || "外部用户"}
            </Text>
          </View>
        </View>
        <Button
          label={
            state === "pending_request"
              ? "等待处理"
              : submitting
                ? "提交中..."
                : "加好友"
          }
          icon="user-plus"
          onPress={() => void handleRequestFriend()}
          disabled={state === "pending_request" || submitting}
        />
        {message ? <Text style={styles.message}>{message}</Text> : null}
      </SectionBlock>

      <SectionBlock>
        <SectionTitleRow title="基础信息" />
        <View style={styles.metaCard}>
          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>状态</Text>
            <Text style={styles.metaValue}>{statusLabel(state)}</Text>
          </View>
          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>来源工作区</Text>
            <Text style={styles.metaValue}>
              {params.workspaceName || "未知工作区"}
            </Text>
          </View>
          {params.workspaceSlug ? (
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Workspace ID</Text>
              <Text style={styles.metaValue}>{params.workspaceSlug}</Text>
            </View>
          ) : null}
        </View>
      </SectionBlock>
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
  heroRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  heroBody: {
    flex: 1,
    gap: 4,
  },
  heroTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: theme.colors.text,
  },
  heroSubtitle: {
    fontSize: 14,
    lineHeight: 20,
    color: theme.colors.textMuted,
  },
  message: {
    fontSize: 13,
    color: theme.colors.textSoft,
  },
  metaCard: {
    marginTop: 4,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    overflow: "hidden",
  },
  metaRow: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 16,
  },
  metaLabel: {
    fontSize: 13,
    color: theme.colors.textSoft,
  },
  metaValue: {
    flex: 1,
    textAlign: "right",
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.text,
  },
})
