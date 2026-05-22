import Feather from "@expo/vector-icons/Feather"
import * as Clipboard from "expo-clipboard"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native"

import { ChatComposer } from "@/components/chat-composer"
import { ActorActivityBubble } from "@/components/actor-activity-bubble"
import { ChatMessageActionSheet } from "@/components/chat-message-action-sheet"
import { MessageItem } from "@/components/message-item"
import { Button, EmptyState, LoadingBlock, ScreenView } from "@/components/ui"
import { useWorkspaceWebSocket } from "@/hooks/use-workspace-websocket"
import {
  buildReplyPreviewText,
  getConfirmedConversationMaxSequence,
  getConversationDisplayName,
  getConversationViewerParticipant,
  type MobileChatItem,
} from "@/lib/chat-data"
import { useChat } from "@/providers/chat-provider"
import { useWorkspace } from "@/providers/workspace-provider"
import { theme } from "@/theme/tokens"
import {
  CONVERSATION_KIND,
  CONVERSATION_PARTICIPANT_TYPE,
  getActorRuntimePriority,
  isActorRuntimeActive,
  isActorRuntimeProcessingWorkspaceMember,
  type ConversationReplyRef,
} from "@shared"

export default function ChatDetailScreen() {
  const router = useRouter()
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>()
  const scrollRef = useRef<ScrollView | null>(null)
  const lastReportedReadRef = useRef<string>("")
  const previousMessageMetricsRef = useRef<{
    conversationId: string
    firstSequence: number
    lastSequence: number
  } | null>(null)
  const {
    getConversation,
    getConversationItems,
    getConversationMeta,
    getConversationRuntimes,
    loadOlderMessages,
    markConversationRead,
    refreshConversation,
    respondInteraction,
    sendMessage,
    status,
    clientInstanceId,
    workspaceMemberId,
  } = useChat()
  const { workspaceId } = useWorkspace()
  const [refreshing, setRefreshing] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [replyTo, setReplyTo] = useState<ConversationReplyRef | null>(null)
  const [actionMenu, setActionMenu] = useState<{
    item: MobileChatItem
    x: number
    y: number
    mine: boolean
  } | null>(null)

  const conversation = conversationId ? getConversation(conversationId) : null
  const items = conversationId ? getConversationItems(conversationId) : []
  const actorRuntimes = conversationId
    ? getConversationRuntimes(conversationId)
    : {}
  const meta = conversationId ? getConversationMeta(conversationId) : null
  const confirmedMaxSequence = useMemo(
    () => getConfirmedConversationMaxSequence(items),
    [items]
  )
  const firstSequence = items[0]?.sequence ?? 0
  const lastSequence = items[items.length - 1]?.sequence ?? 0
  const viewerParticipantId = getConversationViewerParticipant(
    conversation,
    workspaceMemberId
  )?.participantId
  const loading = status === "loading" && !conversation
  const headerTitle = conversation
    ? getConversationDisplayName(conversation, workspaceMemberId)
    : "聊天"
  const directActorParticipant =
    conversation?.kind === CONVERSATION_KIND.PRIVATE
      ? (conversation.participants.find(
          (participant) =>
            participant.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
        ) ?? null)
      : null
  const directActorRuntime = directActorParticipant?.actorId
    ? (actorRuntimes[directActorParticipant.actorId] ?? null)
    : null
  const showTypingHint = Boolean(
    workspaceMemberId &&
    directActorRuntime?.laneState === "running" &&
    isActorRuntimeProcessingWorkspaceMember(
      directActorRuntime,
      workspaceMemberId
    )
  )
  const activeRuntimes = Object.values(actorRuntimes)
    .filter((runtime) => isActorRuntimeActive(runtime))
    .sort(
      (left, right) =>
        getActorRuntimePriority(left) - getActorRuntimePriority(right)
    )
  const currentTurnRuntimes = activeRuntimes.filter((runtime) =>
    Boolean(runtime.currentTurnPreview?.turnId)
  )
  const loadingConversationHistory = Boolean(
    conversation &&
    items.length === 0 &&
    (meta?.loadingLatest || (!meta?.hasLoadedLatest && !meta?.latestLoadError))
  )
  const conversationHistoryLoadFailed = Boolean(
    conversation &&
    items.length === 0 &&
    !meta?.loadingLatest &&
    !meta?.hasLoadedLatest &&
    meta?.latestLoadError
  )

  useWorkspaceWebSocket({
    workspaceId: workspaceId || undefined,
    enabled: Boolean(workspaceId && conversationId),
    subscriptions:
      workspaceId && conversationId
        ? [
            {
              key: `chat-conversation:${workspaceId}:${conversationId}`,
              topic: "conversation",
              conversationId,
            },
          ]
        : [],
  })

  useEffect(() => {
    setReplyTo(null)
    setActionMenu(null)
  }, [conversationId])

  useEffect(() => {
    if (!conversationId || status !== "ready" || !clientInstanceId) {
      return
    }

    void refreshConversation(conversationId).catch(() => undefined)
  }, [clientInstanceId, conversationId, refreshConversation, status])

  useEffect(() => {
    if (!conversationId || items.length === 0) {
      previousMessageMetricsRef.current = conversationId
        ? {
            conversationId,
            firstSequence,
            lastSequence,
          }
        : null
      return
    }

    const previous = previousMessageMetricsRef.current
    const conversationChanged = previous?.conversationId !== conversationId
    const appendedAtTail = Boolean(
      previous &&
      !conversationChanged &&
      lastSequence > previous.lastSequence &&
      firstSequence >= previous.firstSequence
    )

    previousMessageMetricsRef.current = {
      conversationId,
      firstSequence,
      lastSequence,
    }

    if (!conversationChanged && !appendedAtTail) {
      return
    }

    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({ animated: false })
    })
  }, [conversationId, firstSequence, items.length, lastSequence])

  useEffect(() => {
    if (!conversationId || !conversation || confirmedMaxSequence <= 0) {
      return
    }

    const nextKey = `${conversationId}:${confirmedMaxSequence}`
    if (lastReportedReadRef.current === nextKey) {
      return
    }

    lastReportedReadRef.current = nextKey
    // NOTE: we send confirmedMaxSequence for both readUpTo and lastVisible
    // because the mobile list virtualization doesn't currently expose a
    // distinct viewport-top sequence. The wire protocol differentiates them
    // (so a scrolled-up user could send readUpTo < lastVisible) but the
    // mobile UI treats "loaded" as equivalent to "seen".
    void markConversationRead(
      conversationId,
      confirmedMaxSequence,
      confirmedMaxSequence
    )
  }, [confirmedMaxSequence, conversation, conversationId, markConversationRead])

  const messageNodes = useMemo(
    () =>
      items.map((item) => (
        <MessageItem
          key={item.id}
          item={item}
          viewerParticipantId={viewerParticipantId}
          onResolveInteraction={
            conversation
              ? (interactionId, input) =>
                  respondInteraction(
                    conversation.conversationId,
                    interactionId,
                    input
                  )
              : undefined
          }
          onLongPress={
            item.itemType === "message" && !item.localOnly
              ? (event) =>
                  setActionMenu({
                    item,
                    x: event.nativeEvent.pageX,
                    y: event.nativeEvent.pageY,
                    mine: item.authorParticipantId === viewerParticipantId,
                  })
              : undefined
          }
        />
      )),
    [conversation, items, respondInteraction, viewerParticipantId]
  )

  async function handleRefresh() {
    if (!conversationId || status !== "ready" || !clientInstanceId) {
      return
    }

    setRefreshing(true)
    try {
      await refreshConversation(conversationId)
    } finally {
      setRefreshing(false)
    }
  }

  async function handleLoadOlder() {
    if (
      !conversationId ||
      status !== "ready" ||
      !clientInstanceId ||
      !meta?.hasMoreBefore
    ) {
      return
    }

    setLoadingOlder(true)
    try {
      await loadOlderMessages(conversationId)
    } finally {
      setLoadingOlder(false)
    }
  }

  if (!conversationId) {
    return (
      <ScreenView>
        <EmptyState
          icon="message-square"
          title="当前无法打开会话"
          description="缺少有效的会话标识。"
        />
      </ScreenView>
    )
  }

  return (
    <ScreenView>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 10 : 0}
      >
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <Pressable
              onPress={() => router.back()}
              style={styles.headerButton}
            >
              <Feather
                name="chevron-left"
                size={20}
                color={theme.colors.text}
              />
            </Pressable>
            <View style={styles.headerTitleWrap}>
              <Text numberOfLines={1} style={styles.headerTitle}>
                {headerTitle}
              </Text>
              {showTypingHint ? (
                <Text numberOfLines={1} style={styles.headerSubtitle}>
                  对方正在输入中...
                </Text>
              ) : null}
            </View>
            <Pressable
              onPress={() =>
                router.push({
                  pathname: "/conversations/[conversationId]/details",
                  params: { conversationId },
                })
              }
              style={styles.headerButton}
            >
              <Feather
                name="more-horizontal"
                size={18}
                color={theme.colors.text}
              />
            </Pressable>
          </View>
        </View>

        {loading ? (
          <View style={styles.placeholder}>
            <LoadingBlock label="正在加载聊天记录..." />
          </View>
        ) : !conversation ? (
          <View style={styles.placeholder}>
            <EmptyState
              icon="message-circle"
              title="会话还没同步下来"
              description="下拉重试一次，或者稍后再进。"
              action={
                <Button
                  label="重试"
                  icon="refresh-cw"
                  onPress={() => void handleRefresh()}
                />
              }
            />
          </View>
        ) : (
          <>
            <ScrollView
              ref={scrollRef}
              style={styles.messages}
              contentContainerStyle={styles.messagesContent}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => void handleRefresh()}
                />
              }
              keyboardShouldPersistTaps="handled"
            >
              {meta?.hasMoreBefore ? (
                <View style={styles.topAction}>
                  <Button
                    label={loadingOlder ? "加载中..." : "加载更早消息"}
                    variant="ghost"
                    icon="chevrons-up"
                    disabled={loadingOlder}
                    onPress={() => void handleLoadOlder()}
                  />
                </View>
              ) : null}

              {messageNodes.length > 0 ? (
                <>
                  {messageNodes}
                  {currentTurnRuntimes.map((runtime) => (
                    <ActorActivityBubble
                      key={`${runtime.actorId}:${runtime.currentTurnPreview!.turnId}`}
                      conversationId={conversationId}
                      workspaceId={workspaceId || undefined}
                      runtime={runtime}
                      participant={conversation.participants.find(
                        (participant) =>
                          participant.participantType ===
                            CONVERSATION_PARTICIPANT_TYPE.ACTOR &&
                          participant.actorId === runtime.actorId
                      )}
                    />
                  ))}
                </>
              ) : loadingConversationHistory ? (
                <LoadingBlock label="正在加载聊天记录..." />
              ) : conversationHistoryLoadFailed ? (
                <EmptyState
                  icon="alert-circle"
                  title="聊天记录加载失败"
                  description={meta?.latestLoadError || "下拉重试一次。"}
                  action={
                    <Button
                      label="重试"
                      icon="refresh-cw"
                      onPress={() => void handleRefresh()}
                    />
                  }
                />
              ) : (
                <>
                  <EmptyState
                    icon="message-circle"
                    title="还没有消息"
                    description="发一条消息开始对话。"
                  />
                  {currentTurnRuntimes.map((runtime) => (
                    <ActorActivityBubble
                      key={`${runtime.actorId}:${runtime.currentTurnPreview!.turnId}`}
                      conversationId={conversationId}
                      workspaceId={workspaceId || undefined}
                      runtime={runtime}
                      participant={conversation.participants.find(
                        (participant) =>
                          participant.participantType ===
                            CONVERSATION_PARTICIPANT_TYPE.ACTOR &&
                          participant.actorId === runtime.actorId
                      )}
                    />
                  ))}
                </>
              )}
            </ScrollView>

            <ChatComposer
              workspaceId={conversation.workspaceId}
              conversationId={conversationId}
              conversation={conversation}
              viewerParticipantId={viewerParticipantId}
              disabled={status !== "ready" || !clientInstanceId}
              replyTo={replyTo}
              onCancelReply={() => setReplyTo(null)}
              onSend={(payload) => sendMessage(conversationId, payload)}
            />
          </>
        )}
      </KeyboardAvoidingView>
      <ChatMessageActionSheet
        open={Boolean(actionMenu)}
        anchor={
          actionMenu
            ? {
                x: actionMenu.x,
                y: actionMenu.y,
                mine: actionMenu.mine,
              }
            : null
        }
        onClose={() => setActionMenu(null)}
        onQuote={() => {
          if (actionMenu) {
            setReplyTo({
              itemId: actionMenu.item.id,
              itemType: actionMenu.item.itemType,
              subtype: actionMenu.item.subtype,
              author: actionMenu.item.author,
              previewText: actionMenu.item.content.trim(),
              previewBlocks: actionMenu.item.contentBlocks,
              createdAt: actionMenu.item.createdAt,
            })
          }
          setActionMenu(null)
        }}
        onCopy={() => {
          if (actionMenu) {
            void Clipboard.setStringAsync(
              buildReplyPreviewText({
                previewText: actionMenu.item.content,
                previewBlocks: actionMenu.item.contentBlocks,
                subtype: actionMenu.item.subtype,
              })
            ).catch(() => undefined)
          }
          setActionMenu(null)
        }}
      />
    </ScreenView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    minHeight: 48,
    paddingHorizontal: 18,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    justifyContent: "flex-end",
  },
  headerRow: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  headerTitleWrap: {
    flex: 1,
    minWidth: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  headerButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: theme.colors.text,
    textAlign: "center",
  },
  headerSubtitle: {
    marginTop: 2,
    fontSize: 11,
    color: theme.colors.textMuted,
    textAlign: "center",
  },
  placeholder: {
    flex: 1,
    paddingHorizontal: 18,
    justifyContent: "center",
  },
  messages: {
    flex: 1,
  },
  messagesContent: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    gap: 12,
  },
  topAction: {
    alignItems: "center",
    marginBottom: 2,
  },
})
