import { useRouter } from "expo-router"
import { useMemo } from "react"
import { RefreshControl, StyleSheet, View } from "react-native"

import { ConversationListView } from "@/components/conversation-list"
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

        {loading ? (
          <View style={styles.stateWrap}>
            <SectionBlock>
              <LoadingBlock label="正在加载会话..." />
            </SectionBlock>
          </View>
        ) : error ? (
          <View style={styles.stateWrap}>
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
          </View>
        ) : (
          <View style={styles.listShell}>
            <ConversationListView
              conversations={conversations}
              workspaceMemberId={workspaceMemberId}
              onPressConversation={(conversation) =>
                router.push(`/chat/${conversation.conversationId}`)
              }
              contentContainerStyle={{
                paddingHorizontal: 18,
                paddingBottom: 128,
              }}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => void refreshInbox()}
                />
              }
              ListEmptyComponent={
                <SectionBlock>
                  <EmptyState
                    icon="message-square"
                    title="还没有任何聊天"
                    description={emptyDescription}
                  />
                </SectionBlock>
              }
            />
          </View>
        )}
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
  listShell: {
    flex: 1,
  },
  stateWrap: {
    paddingHorizontal: 18,
  },
  retryAction: {
    marginTop: 10,
    width: "100%",
  },
})
