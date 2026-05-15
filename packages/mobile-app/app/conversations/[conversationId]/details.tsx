import Feather from "@expo/vector-icons/Feather"
import {
  CONVERSATION_BOUNDARY,
  CONVERSATION_KIND,
  CONVERSATION_PARTICIPANT_STATE,
  CONVERSATION_PARTICIPANT_TYPE,
} from "@shared"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useEffect, useMemo } from "react"
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
import {
  getConversationAvatarSpec,
  getParticipantDisplayName,
} from "@/lib/chat-data"
import { useChat } from "@/providers/chat-provider"
import { theme } from "@/theme/tokens"

export default function ConversationDetailScreen() {
  const router = useRouter()
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>()
  const {
    clientInstanceId,
    getConversation,
    refreshConversation,
    status,
    workspaceMemberId,
  } = useChat()
  const conversation = conversationId ? getConversation(conversationId) : null
  const members = conversation?.participants ?? []
  const loading = status === "loading" && !conversation
  const heroAvatar = conversation
    ? getConversationAvatarSpec(conversation, workspaceMemberId)
    : null

  useEffect(() => {
    if (
      !conversationId ||
      conversation ||
      status !== "ready" ||
      !clientInstanceId
    ) {
      return
    }

    void refreshConversation(conversationId).catch(() => undefined)
  }, [
    clientInstanceId,
    conversation,
    conversationId,
    refreshConversation,
    status,
  ])

  const activeCount = useMemo(
    () =>
      members.filter(
        (member) => member.state !== CONVERSATION_PARTICIPANT_STATE.REMOVED
      ).length,
    [members]
  )

  return (
    <ScreenScroll topPadding={0} bottomPadding={56}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.headerButton}>
          <Feather name="chevron-left" size={20} color={theme.colors.text} />
        </Pressable>
        <Text numberOfLines={1} style={styles.headerTitle}>
          会话详情
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <SectionBlock>
          <LoadingBlock label="正在加载会话详情..." />
        </SectionBlock>
      ) : !conversation ? (
        <SectionBlock>
          <EmptyState
            icon="users"
            title="没有找到这个会话"
            description="这个会话可能还没同步下来，或者你当前没有访问权限。"
          />
        </SectionBlock>
      ) : (
        <>
          <SectionBlock>
            <View style={styles.heroRow}>
              <Avatar
                name={heroAvatar?.name || conversation.title}
                uri={heroAvatar?.uri}
                icon={heroAvatar?.icon}
                size={68}
              />
              <View style={styles.heroBody}>
                <Text style={styles.heroTitle}>{conversation.title}</Text>
                <Text style={styles.heroSubtitle}>
                  {`${conversation.kind === CONVERSATION_KIND.PRIVATE ? "单聊" : "群聊"} · ${activeCount} 位成员`}
                </Text>
              </View>
              <Pill
                label={
                  conversation.boundary === CONVERSATION_BOUNDARY.EXTERNAL
                    ? "外部"
                    : "内部"
                }
                tone="primary"
              />
            </View>
            <Button
              label="打开聊天"
              icon="message-circle"
              onPress={() =>
                router.replace(`/chat/${conversation.conversationId}`)
              }
            />
          </SectionBlock>

          <SectionBlock>
            <SectionTitleRow
              title="成员"
              action={<Text style={styles.countText}>{activeCount} 人</Text>}
            />
            {members.length > 0 ? (
              <View style={styles.listShell}>
                {members.map((member) => (
                  <View key={member.participantId} style={styles.rowCard}>
                    <Avatar
                      name={getParticipantDisplayName(member)}
                      uri={member.avatarUrl}
                      icon={
                        member.participantType ===
                        CONVERSATION_PARTICIPANT_TYPE.ACTOR
                          ? "cpu"
                          : member.participantType ===
                              CONVERSATION_PARTICIPANT_TYPE.EXTERNAL
                            ? "globe"
                            : "user"
                      }
                      size={42}
                    />
                    <View style={styles.rowBody}>
                      <Text style={styles.rowTitle}>
                        {getParticipantDisplayName(member)}
                      </Text>
                      <Text style={styles.rowSubtitle}>
                        {member.title ||
                          (member.participantType ===
                          CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER
                            ? "成员"
                            : member.participantType ===
                                CONVERSATION_PARTICIPANT_TYPE.ACTOR
                              ? "Actor"
                              : "会话成员")}
                      </Text>
                    </View>
                    <Pill
                      label={
                        member.participantType ===
                        CONVERSATION_PARTICIPANT_TYPE.ACTOR
                          ? "角色"
                          : "成员"
                      }
                    />
                  </View>
                ))}
              </View>
            ) : (
              <EmptyState
                icon="users"
                title="当前没有成员"
                description="这个会话的成员信息暂时不可用。"
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
    backgroundColor: theme.colors.surface,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowBody: {
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
