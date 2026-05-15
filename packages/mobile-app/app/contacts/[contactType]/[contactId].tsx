import Feather from "@expo/vector-icons/Feather"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useEffect, useState } from "react"
import {
  CONTACT_DIRECT_STATE,
  CONTACT_TARGET_TYPE,
  DIRECT_CONVERSATION_OPEN_STATUS,
} from "@shared"
import { Pressable, StyleSheet, Text, View } from "react-native"

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
import { useWorkspace } from "@/providers/workspace-provider"
import { theme } from "@/theme/tokens"
import type { ContactHubDetailResponse, ContactHubEntryView } from "@/types/api"

type ContactType = ContactHubEntryView["kind"]

function directButtonLabel(entry: ContactHubEntryView) {
  switch (entry.directState.status) {
    case CONTACT_DIRECT_STATE.EXISTING:
      return "进入已有私聊"
    case CONTACT_DIRECT_STATE.PENDING_APPROVAL:
      return "等待批准"
    case CONTACT_DIRECT_STATE.APPROVAL_REQUIRED:
      return "申请访问并发起私聊"
    default:
      return "发起私聊"
  }
}

export default function ContactDetailScreen() {
  const router = useRouter()
  const { contactType, contactId } = useLocalSearchParams<{
    contactType: ContactType
    contactId: string
  }>()
  const { workspaceId } = useWorkspace()
  const [detail, setDetail] = useState<ContactHubDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)

  useEffect(() => {
    async function loadDetail() {
      if (!workspaceId || !contactType || !contactId) {
        setLoading(false)
        return
      }

      setLoading(true)
      try {
        const nextDetail = await api.getContactHubDetail(
          workspaceId,
          contactType,
          contactId
        )
        setDetail(nextDetail)
        setError(null)
      } catch (nextError) {
        setError(
          nextError instanceof Error
            ? nextError.message
            : "联系人详情加载失败。"
        )
      } finally {
        setLoading(false)
      }
    }

    void loadDetail()
  }, [contactId, contactType, workspaceId])

  async function handleOpenDirect() {
    if (!workspaceId || !detail?.contact || submitting) return

    if (
      detail.contact.directState.status === CONTACT_DIRECT_STATE.EXISTING &&
      detail.contact.directState.conversationId
    ) {
      router.push(`/chat/${detail.contact.directState.conversationId}`)
      return
    }

    setSubmitting(true)
    setActionMessage(null)
    try {
      const result = await api.openDirectConversation(workspaceId, {
        contactKind: detail.contact.kind,
        contactId: detail.contact.id,
      })

      if (result.status === DIRECT_CONVERSATION_OPEN_STATUS.PENDING_APPROVAL) {
        setActionMessage("已提交申请，等待对方批准后才能发起私聊。")
        return
      }

      if (result.conversationId) {
        router.replace(`/chat/${result.conversationId}`)
      }
    } catch (nextError) {
      setActionMessage(
        nextError instanceof Error ? nextError.message : "发起私聊失败。"
      )
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
      ) : !detail?.contact ? (
        <SectionBlock>
          <EmptyState
            icon="users"
            title="没有找到这个联系人"
            description="这个联系人可能已经不存在，或者你当前没有访问权限。"
          />
        </SectionBlock>
      ) : (
        <>
          <SectionBlock>
            <View style={styles.heroRow}>
              <Avatar
                name={detail.contact.title}
                uri={detail.contact.avatarUrl}
                size={68}
                icon={
                  detail.contact.targetType === CONTACT_TARGET_TYPE.ACTOR
                    ? "cpu"
                    : detail.contact.targetType ===
                        CONTACT_TARGET_TYPE.REMOTE_AGENT
                      ? "terminal"
                      : "user"
                }
              />
              <View style={styles.heroBody}>
                <Text style={styles.heroTitle}>{detail.contact.title}</Text>
                <Text style={styles.heroSubtitle}>
                  {detail.contact.subtitle || detail.contact.workspace.name}
                </Text>
              </View>
              <Pill label={detail.contact.relationLabel} />
            </View>
            <Button
              label={directButtonLabel(detail.contact)}
              icon="message-circle"
              onPress={() => void handleOpenDirect()}
              disabled={submitting}
            />
            {actionMessage ? (
              <Text style={styles.actionMessage}>{actionMessage}</Text>
            ) : null}
          </SectionBlock>

          <SectionBlock>
            <SectionTitleRow title="关系与范围" />
            <View style={styles.metaCard}>
              <View style={styles.metaRow}>
                <Text style={styles.metaLabel}>类型</Text>
                <Text style={styles.metaValue}>
                  {detail.contact.targetType === CONTACT_TARGET_TYPE.ACTOR
                    ? "Actor"
                    : detail.contact.targetType ===
                        CONTACT_TARGET_TYPE.REMOTE_AGENT
                      ? "Remote agent"
                      : "成员"}
                </Text>
              </View>
              <View style={styles.metaRow}>
                <Text style={styles.metaLabel}>来源工作区</Text>
                <Text style={styles.metaValue}>
                  {detail.contact.workspace.name}
                </Text>
              </View>
              <View style={styles.metaRow}>
                <Text style={styles.metaLabel}>私聊状态</Text>
                <Text style={styles.metaValue}>
                  {detail.contact.directState.status ===
                  CONTACT_DIRECT_STATE.EXISTING
                    ? "已有单聊"
                    : detail.contact.directState.status ===
                        CONTACT_DIRECT_STATE.PENDING_APPROVAL
                      ? "等待批准"
                      : detail.contact.directState.status ===
                          CONTACT_DIRECT_STATE.APPROVAL_REQUIRED
                        ? "需要申请"
                        : "可直接发起"}
                </Text>
              </View>
            </View>
          </SectionBlock>

          <SectionBlock>
            <SectionTitleRow
              title="共同所在群聊"
              action={
                <Text style={styles.countText}>{detail.groups.length} 个</Text>
              }
            />
            {detail.groups.length > 0 ? (
              <View style={styles.listShell}>
                {detail.groups.map((conversation) => (
                  <Pressable
                    key={conversation.id}
                    onPress={() => router.push(`/chat/${conversation.id}`)}
                    style={({ pressed }) => [
                      styles.groupRow,
                      pressed && styles.groupRowPressed,
                    ]}
                  >
                    <Avatar
                      name={
                        conversation.presentation?.title || conversation.title
                      }
                      uri={
                        conversation.presentation?.avatarUrl ||
                        conversation.avatarUrl
                      }
                      icon="message-circle"
                      size={42}
                    />
                    <View style={styles.groupBody}>
                      <Text style={styles.rowTitle}>
                        {conversation.presentation?.title || conversation.title}
                      </Text>
                      <Text numberOfLines={1} style={styles.rowSubtitle}>
                        {conversation.lastMessage?.content?.trim() ||
                          "打开群聊查看消息"}
                      </Text>
                    </View>
                    <Pill label="群聊" />
                  </Pressable>
                ))}
              </View>
            ) : (
              <EmptyState
                icon="message-circle"
                title="暂时没有共同群聊"
                description="你可以直接发起私聊，或者先创建一个群聊。"
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
    fontSize: 13,
    color: theme.colors.textMuted,
  },
  actionMessage: {
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.textMuted,
  },
  metaCard: {
    gap: 12,
    padding: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  metaLabel: {
    fontSize: 13,
    color: theme.colors.textSoft,
  },
  metaValue: {
    flex: 1,
    textAlign: "right",
    fontSize: 14,
    fontWeight: "600",
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
  groupRow: {
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
  groupRowPressed: {
    backgroundColor: theme.colors.surfaceMuted,
  },
  groupBody: {
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
})
