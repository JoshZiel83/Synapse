import { useRouter } from "expo-router"
import { useMemo } from "react"
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native"

import { ConversationList } from "@/components/conversation-list"
import { MobileHeaderActions } from "@/components/mobile-header-actions"
import {
  Button,
  EmptyState,
  LoadingBlock,
  MobilePageHeader,
  ScreenView,
  SectionBlock,
} from "@/components/ui"
import { useScanLauncher } from "@/hooks/use-scan-launcher"
import { useChat } from "@/providers/chat-provider"
import { useWorkspace } from "@/providers/workspace-provider"

export default function ChatsTabScreen() {
  const router = useRouter()
  const { openScan, permissionSheet } = useScanLauncher("relationship")
  const { workspaceId, workspaceName } = useWorkspace()
  const {
    conversations,
    error,
    refreshInbox,
    status,
    totalUnreadCount,
    workspaceMemberId,
  } = useChat()
  const loading = status === "loading"
  const refreshing = false
  const unreadCount = totalUnreadCount
  const headerTitle = unreadCount > 0 ? `消息(${unreadCount})` : "消息"
  const emptyDescription = useMemo(() => {
    if (!workspaceId) {
      return "请先进入一个有效工作区。"
    }
    return workspaceName
      ? `${workspaceName} 里还没有任何聊天。`
      : "还没有任何聊天。"
  }, [workspaceId, workspaceName])

  return (
    <ScreenView>
      <View style={styles.pageShell}>
        <View style={styles.headerGutter}>
          <MobilePageHeader
            title={headerTitle}
            action={
              <MobileHeaderActions
                onSearch={() => router.push("/search")}
                onStartGroup={() => router.push("/contacts/group/new")}
                onAddFriend={() => router.push("/contacts/add")}
                onScan={() => void openScan()}
              />
            }
          />
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void refreshInbox()}
            />
          }
        >
          {loading ? (
            <SectionBlock>
              <LoadingBlock label="正在加载会话..." />
            </SectionBlock>
          ) : error ? (
            <SectionBlock>
              <EmptyState
                icon="alert-circle"
                title="会话加载失败"
                description={error}
                action={
                  <View style={styles.retryAction}>
                    <Button
                      label="重试"
                      icon="refresh-cw"
                      onPress={() => void refreshInbox()}
                    />
                  </View>
                }
              />
            </SectionBlock>
          ) : conversations.length > 0 ? (
            <SectionBlock style={styles.listSection}>
              <ConversationList
                conversations={conversations}
                workspaceMemberId={workspaceMemberId}
                onPressConversation={(conversation) =>
                  router.push(`/chat/${conversation.conversationId}`)
                }
              />
            </SectionBlock>
          ) : (
            <SectionBlock>
              <EmptyState
                icon="message-square"
                title="还没有任何聊天"
                description={emptyDescription}
              />
            </SectionBlock>
          )}
        </ScrollView>
      </View>
      {permissionSheet}
    </ScreenView>
  )
}

const styles = StyleSheet.create({
  pageShell: {
    flex: 1,
  },
  headerGutter: {
    paddingHorizontal: 18,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 18,
    paddingBottom: 128,
  },
  listSection: {
    borderTopWidth: 0,
    borderBottomWidth: 0,
    paddingVertical: 0,
    gap: 0,
  },
  retryAction: {
    marginTop: 10,
    width: "100%",
  },
})
