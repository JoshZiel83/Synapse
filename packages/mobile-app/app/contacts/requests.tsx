import Feather from "@expo/vector-icons/Feather"
import { useRouter } from "expo-router"
import { useEffect, useState } from "react"
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
import type {
  ActorAccessRequestListResponse,
  FriendRequestListResponse,
} from "@/types/api"

export default function ContactRequestsScreen() {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const [friendRequests, setFriendRequests] =
    useState<FriendRequestListResponse | null>(null)
  const [actorAccessRequests, setActorAccessRequests] =
    useState<ActorAccessRequestListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [submittingId, setSubmittingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function loadRequests() {
    if (!workspaceId) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [friends, actorAccess] = await Promise.all([
        api.getFriendRequests(workspaceId),
        api.getActorAccessRequests(workspaceId),
      ])
      setFriendRequests(friends)
      setActorAccessRequests(actorAccess)
      setError(null)
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "申请加载失败。"
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadRequests()
  }, [workspaceId])

  async function handleResolveFriend(
    requestId: string,
    decision: "approve" | "reject"
  ) {
    if (!workspaceId || submittingId) return
    setSubmittingId(requestId)
    try {
      if (decision === "approve") {
        await api.approveFriendRequest(workspaceId, requestId)
      } else {
        await api.rejectFriendRequest(workspaceId, requestId)
      }
      await loadRequests()
    } finally {
      setSubmittingId(null)
    }
  }

  async function handleResolveActorAccess(
    requestId: string,
    decision: "approve" | "reject"
  ) {
    if (!workspaceId || submittingId) return
    setSubmittingId(requestId)
    try {
      if (decision === "approve") {
        await api.approveActorAccessRequest(workspaceId, requestId)
      } else {
        await api.rejectActorAccessRequest(workspaceId, requestId)
      }
      await loadRequests()
    } finally {
      setSubmittingId(null)
    }
  }

  const friendIncoming = friendRequests?.incoming || []
  const friendOutgoing = friendRequests?.outgoing || []
  const actorIncoming = actorAccessRequests?.incoming || []
  const actorOutgoing = actorAccessRequests?.outgoing || []

  return (
    <ScreenScroll topPadding={0} bottomPadding={56}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.headerButton}>
          <Feather name="chevron-left" size={20} color={theme.colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>好友申请</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <SectionBlock>
          <LoadingBlock label="正在加载申请..." />
        </SectionBlock>
      ) : error ? (
        <SectionBlock>
          <EmptyState
            icon="alert-circle"
            title="申请加载失败"
            description={error}
          />
        </SectionBlock>
      ) : (
        <>
          <SectionBlock>
            <SectionTitleRow
              title="待处理好友申请"
              action={
                <Text style={styles.countText}>{friendIncoming.length} 条</Text>
              }
            />
            {friendIncoming.length > 0 ? (
              <View style={styles.listShell}>
                {friendIncoming.map((request) => (
                  <View key={request.id} style={styles.rowCard}>
                    <Avatar
                      name={request.requester?.name || "User"}
                      icon={request.targetType === "actor" ? "cpu" : "user"}
                    />
                    <View style={styles.rowBody}>
                      <Text style={styles.rowTitle}>
                        {request.requester?.name || "未命名用户"}
                      </Text>
                      <Text style={styles.rowSubtitle}>
                        {request.targetType === "actor"
                          ? `申请添加 Actor：${request.targetActor?.name || "未知 Actor"}`
                          : `申请添加好友 · ${request.requester?.workspace.name || ""}`}
                      </Text>
                    </View>
                    <View style={styles.actionColumn}>
                      <Button
                        label={submittingId === request.id ? "处理中" : "批准"}
                        disabled={submittingId === request.id}
                        onPress={() =>
                          void handleResolveFriend(request.id, "approve")
                        }
                      />
                      <Button
                        label="拒绝"
                        variant="ghost"
                        disabled={submittingId === request.id}
                        onPress={() =>
                          void handleResolveFriend(request.id, "reject")
                        }
                      />
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <EmptyState
                icon="inbox"
                title="没有待处理好友申请"
                description="新的好友申请会出现在这里。"
              />
            )}
          </SectionBlock>

          <SectionBlock>
            <SectionTitleRow
              title="待处理 Actor 访问申请"
              action={
                <Text style={styles.countText}>{actorIncoming.length} 条</Text>
              }
            />
            {actorIncoming.length > 0 ? (
              <View style={styles.listShell}>
                {actorIncoming.map((request) => (
                  <View key={request.id} style={styles.rowCard}>
                    <Avatar name={request.actor?.name || "Actor"} icon="cpu" />
                    <View style={styles.rowBody}>
                      <Text style={styles.rowTitle}>
                        {request.actor?.name || "未知 Actor"}
                      </Text>
                      <Text style={styles.rowSubtitle}>
                        {request.requester?.name || "某位用户"} 想发起私聊
                      </Text>
                    </View>
                    <View style={styles.actionColumn}>
                      <Button
                        label={submittingId === request.id ? "处理中" : "批准"}
                        disabled={submittingId === request.id}
                        onPress={() =>
                          void handleResolveActorAccess(request.id, "approve")
                        }
                      />
                      <Button
                        label="拒绝"
                        variant="ghost"
                        disabled={submittingId === request.id}
                        onPress={() =>
                          void handleResolveActorAccess(request.id, "reject")
                        }
                      />
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <EmptyState
                icon="cpu"
                title="没有待处理 Actor 访问申请"
                description="当 Actor 需要人工批准时，请求会出现在这里。"
              />
            )}
          </SectionBlock>

          <SectionBlock>
            <SectionTitleRow
              title="我发出的申请"
              action={
                <Text style={styles.countText}>
                  {friendOutgoing.length + actorOutgoing.length} 条
                </Text>
              }
            />
            {friendOutgoing.length + actorOutgoing.length > 0 ? (
              <View style={styles.outgoingShell}>
                {friendOutgoing.map((request) => (
                  <View key={request.id} style={styles.outgoingRow}>
                    <Text style={styles.rowTitle}>
                      {request.targetType === "actor"
                        ? request.targetActor?.name || "未知 Actor"
                        : request.targetMember?.name ||
                          request.targetMember?.email ||
                          "未知成员"}
                    </Text>
                    <Pill label="好友申请中" tone="accent" />
                  </View>
                ))}
                {actorOutgoing.map((request) => (
                  <View key={request.id} style={styles.outgoingRow}>
                    <Text style={styles.rowTitle}>
                      {request.actor?.name || "未知 Actor"}
                    </Text>
                    <Pill label="访问申请中" tone="accent" />
                  </View>
                ))}
              </View>
            ) : (
              <EmptyState
                icon="clock"
                title="没有待回执的申请"
                description="你发出的好友申请或 Actor 访问申请会显示在这里。"
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
    lineHeight: 18,
    color: theme.colors.textMuted,
  },
  actionColumn: {
    gap: 8,
    alignItems: "flex-end",
  },
  outgoingShell: {
    gap: 10,
  },
  outgoingRow: {
    padding: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
})
