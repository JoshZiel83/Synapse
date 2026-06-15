import Feather from "@expo/vector-icons/Feather"
import { useEffect, useMemo, useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"

import { api } from "@/lib/api"
import { Avatar } from "@/components/ui"
import { theme } from "@/theme/tokens"
import {
  ACTOR_RUNTIME_HEALTH,
  getActorRuntimeCurrentTool,
  getActorRuntimeProcessingTargets,
  isActorRuntimeActive,
  resolvePresentation,
  ActorRuntimeState,
  ActorRuntimeTurnActivityDetail,
  CanonicalContentBlock,
  ChatParticipantSummary,
} from "@shared"

function formatTargetsLabel(runtime: ActorRuntimeState) {
  const targets = getActorRuntimeProcessingTargets(runtime)
  if (targets.length === 0) {
    return "当前 turn 正在处理中"
  }

  const names = targets.map((target) => target.name).filter(Boolean)
  if (names.length <= 2) {
    return `正在处理 ${names.join("、")}`
  }
  return `正在处理 ${names.slice(0, 2).join("、")} 等 ${names.length} 人`
}

function formatToolStateLabel(state: string) {
  switch (state) {
    case "running":
      return "运行中"
    case "pending":
      return "等待中"
    case "input_required":
      return "等待输入"
    case "completed":
      return "已完成"
    case "failed":
      return "失败"
    case "cancelled":
      return "已取消"
    case "skipped":
      return "已跳过"
    default:
      return "处理中"
  }
}

function getToolStateColor(state: string) {
  switch (state) {
    case "completed":
      return {
        bg: "rgba(16, 185, 129, 0.12)",
        border: "rgba(16, 185, 129, 0.18)",
        text: "#047857",
      }
    case "failed":
    case "cancelled":
      return {
        bg: "rgba(239, 68, 68, 0.1)",
        border: "rgba(239, 68, 68, 0.18)",
        text: theme.colors.danger,
      }
    case "input_required":
      return {
        bg: "rgba(245, 158, 11, 0.12)",
        border: "rgba(245, 158, 11, 0.18)",
        text: "#b45309",
      }
    default:
      return {
        bg: "rgba(14, 165, 233, 0.1)",
        border: "rgba(14, 165, 233, 0.18)",
        text: "#0369a1",
      }
  }
}

function getAvatarStatus(runtime: ActorRuntimeState) {
  if (
    runtime.health === ACTOR_RUNTIME_HEALTH.ERROR ||
    runtime.phase === "error"
  )
    return "error"
  if (runtime.phase === "tool") return "tool"
  if (runtime.phase === "responding") return "responding"
  if (isActorRuntimeActive(runtime)) {
    return "thinking"
  }
  return "idle"
}

function ActivityBlocks({ blocks }: { blocks: CanonicalContentBlock[] }) {
  if (blocks.length === 0) {
    return (
      <View style={styles.emptyBlock}>
        <Text style={styles.emptyBlockText}>暂无细节</Text>
      </View>
    )
  }

  return (
    <View style={styles.blockList}>
      {blocks.map((block) => {
        if (block.type === "text") {
          return (
            <View key={block.id} style={styles.textBlock}>
              <Text style={styles.textBlockText}>{block.text}</Text>
            </View>
          )
        }

        if (block.type === "mention") {
          return (
            <View key={block.id} style={styles.inlineBlock}>
              <Feather
                name="at-sign"
                size={12}
                color={theme.colors.textMuted}
              />
              <Text style={styles.inlineBlockText}>
                {block.mention.name || block.mention.participantType}
              </Text>
            </View>
          )
        }

        return (
          <View key={block.id} style={styles.inlineBlock}>
            <Feather name="file" size={12} color={theme.colors.textMuted} />
            <Text numberOfLines={1} style={styles.inlineBlockText}>
              {block.name}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

interface ActorActivityBubbleProps {
  conversationId: string
  workspaceId?: string
  runtime: ActorRuntimeState
  participant?: ChatParticipantSummary
}

export function ActorActivityBubble({
  conversationId,
  workspaceId,
  runtime,
  participant,
}: ActorActivityBubbleProps) {
  const preview = runtime.currentTurnPreview
  const previewTool = getActorRuntimeCurrentTool(runtime)
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<ActorRuntimeTurnActivityDetail | null>(
    null
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setExpanded(false)
    setDetail(null)
    setError(null)
  }, [runtime.actorId, preview?.turnId])

  useEffect(() => {
    if (!expanded || !workspaceId || !preview?.turnId) {
      return
    }

    let cancelled = false
    setLoading(true)

    void api
      .getChatConversationRuntimeTurnDetail(
        workspaceId,
        conversationId,
        runtime.actorId,
        preview.turnId
      )
      .then((response) => {
        if (cancelled) return
        setDetail(response)
        setError(null)
      })
      .catch((fetchError) => {
        if (cancelled) return
        setError(
          fetchError instanceof Error
            ? fetchError.message
            : "加载当前 turn 细节失败"
        )
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [
    conversationId,
    expanded,
    preview?.turnId,
    runtime.actorId,
    runtime.updatedAt,
    workspaceId,
  ])

  const countsLabel = useMemo(() => {
    if (!preview || preview.totalToolCallCount === 0) return null
    const parts = [`${preview.totalToolCallCount} 个工具调用`]
    if (preview.completedToolCallCount > 0) {
      parts.push(`${preview.completedToolCallCount} 已完成`)
    }
    if (preview.failedToolCallCount > 0) {
      parts.push(`${preview.failedToolCallCount} 失败`)
    }
    return parts.join(" · ")
  }, [preview])

  const previewTone = getToolStateColor(previewTool?.state || "running")

  return (
    <View style={styles.row}>
      <Avatar
        name={runtime.actorDisplayName}
        uri={participant?.avatarUrl}
        size={38}
        status={getAvatarStatus(runtime)}
      />
      <View style={styles.body}>
        <Pressable
          disabled={!preview?.turnId}
          onPress={() => setExpanded((current) => !current)}
          style={({ pressed }) => [
            styles.summaryCard,
            pressed && preview?.turnId ? styles.summaryCardPressed : null,
          ]}
        >
          <View style={styles.summaryHeader}>
            <View style={styles.summaryText}>
              <Text numberOfLines={1} style={styles.actorName}>
                {runtime.actorDisplayName}
              </Text>
              <Text style={styles.summaryLine}>
                {formatTargetsLabel(runtime)}
              </Text>
            </View>
            {preview?.turnId ? (
              <Feather
                name={expanded ? "chevron-down" : "chevron-right"}
                size={16}
                color={theme.colors.textMuted}
              />
            ) : null}
          </View>

          {previewTool ? (
            <View style={styles.toolRow}>
              <View
                style={[
                  styles.statePill,
                  {
                    backgroundColor: previewTone.bg,
                    borderColor: previewTone.border,
                  },
                ]}
              >
                <Text
                  style={[styles.statePillText, { color: previewTone.text }]}
                >
                  {formatToolStateLabel(previewTool.state)}
                </Text>
              </View>
              <Text numberOfLines={2} style={styles.toolText}>
                <Text style={styles.toolTitle}>
                  {resolvePresentation(previewTool.titlePresentation) ??
                    previewTool.displayTitle}
                </Text>
                {previewTool.displayDetail
                  ? ` · ${previewTool.displayDetail}`
                  : ""}
              </Text>
            </View>
          ) : null}

          {countsLabel ? (
            <Text style={styles.countsText}>{countsLabel}</Text>
          ) : null}
        </Pressable>

        {expanded ? (
          <View style={styles.detailCard}>
            {loading && !detail ? (
              <View style={styles.loadingRow}>
                <Feather
                  name="loader"
                  size={14}
                  color={theme.colors.textMuted}
                />
                <Text style={styles.loadingText}>
                  正在加载当前 turn 活动...
                </Text>
              </View>
            ) : error ? (
              <Text style={styles.errorText}>{error}</Text>
            ) : detail && detail.items.length > 0 ? (
              <View style={styles.itemsList}>
                {detail.items.map((item) => {
                  const tone = getToolStateColor(item.state)
                  return (
                    <View key={item.toolCallId} style={styles.itemCard}>
                      <View style={styles.itemHeader}>
                        <View
                          style={[
                            styles.statePill,
                            {
                              backgroundColor: tone.bg,
                              borderColor: tone.border,
                            },
                          ]}
                        >
                          <Text
                            style={[styles.statePillText, { color: tone.text }]}
                          >
                            {formatToolStateLabel(item.state)}
                          </Text>
                        </View>
                        <Text style={styles.itemTitle}>
                          {resolvePresentation(item.titlePresentation) ??
                            item.displayTitle}
                        </Text>
                      </View>
                      {item.displayDetail ? (
                        <Text style={styles.itemDetail}>
                          {item.displayDetail}
                        </Text>
                      ) : null}
                      <View style={styles.section}>
                        <Text style={styles.sectionLabel}>调用</Text>
                        <ActivityBlocks blocks={item.requestBlocks} />
                      </View>
                      <View style={styles.section}>
                        <Text style={styles.sectionLabel}>结果</Text>
                        {resolvePresentation(item.resultSummary) ? (
                          <Text style={styles.itemDetail}>
                            {resolvePresentation(item.resultSummary)}
                          </Text>
                        ) : null}
                        <ActivityBlocks blocks={item.resultBlocks} />
                      </View>
                    </View>
                  )
                })}
              </View>
            ) : (
              <View style={styles.emptyBlock}>
                <Text style={styles.emptyBlockText}>
                  这个 turn 里还没有工具调用
                </Text>
              </View>
            )}
          </View>
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  body: {
    flex: 1,
    gap: 8,
  },
  summaryCard: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  summaryCardPressed: {
    opacity: 0.9,
  },
  summaryHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },
  summaryText: {
    flex: 1,
    gap: 4,
  },
  actorName: {
    fontSize: 15,
    fontWeight: "700",
    color: theme.colors.text,
  },
  summaryLine: {
    fontSize: 12,
    lineHeight: 18,
    color: theme.colors.textMuted,
  },
  toolRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  statePill: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  statePillText: {
    fontSize: 11,
    fontWeight: "700",
  },
  toolText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
    color: theme.colors.textMuted,
  },
  toolTitle: {
    color: theme.colors.text,
    fontWeight: "700",
  },
  countsText: {
    fontSize: 11,
    color: theme.colors.textSoft,
  },
  detailCard: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: 12,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  loadingText: {
    fontSize: 13,
    color: theme.colors.textMuted,
  },
  errorText: {
    fontSize: 12,
    lineHeight: 18,
    color: theme.colors.danger,
  },
  itemsList: {
    gap: 10,
  },
  itemCard: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: "rgba(255,255,255,0.45)",
    padding: 12,
    gap: 10,
  },
  itemHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  itemTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.text,
  },
  itemDetail: {
    fontSize: 12,
    lineHeight: 18,
    color: theme.colors.textMuted,
  },
  section: {
    gap: 6,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: theme.colors.textSoft,
  },
  blockList: {
    gap: 6,
  },
  textBlock: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  textBlockText: {
    fontSize: 12,
    lineHeight: 18,
    color: theme.colors.text,
  },
  inlineBlock: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  inlineBlockText: {
    maxWidth: 220,
    fontSize: 12,
    color: theme.colors.text,
  },
  emptyBlock: {
    borderRadius: 14,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.colors.border,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  emptyBlockText: {
    fontSize: 12,
    color: theme.colors.textMuted,
  },
})
