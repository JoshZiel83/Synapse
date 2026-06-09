import Feather from "@expo/vector-icons/Feather"
import { Image } from "expo-image"
import { useRouter } from "expo-router"
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from "react-native"

import { ChatTaskCard } from "@/components/chat-task-card"
import { ChatMarkdown } from "@/components/chat-markdown"
import { Avatar } from "@/components/ui"
import { resolveContentUrl } from "@/lib/config"
import type { ChatTaskResolveInput } from "@/lib/api"
import {
  buildChatFilePreviewHref,
  getAttachmentLabel,
  serializeMarkdownBlocks,
} from "@/lib/chat-rich-content"
import { useAuthenticatedMediaSource } from "@/hooks/use-authenticated-media-source"
import {
  buildReplyPreviewText,
  getEntityAvatarSpec,
  getEntityDisplayName,
  type MobileChatItem,
} from "@/lib/chat-data"
import { theme } from "@/theme/tokens"
import {
  extractText,
  summarizeConversationEvent,
  type TaskSummary,
} from "@shared"
import { formatChatTimestamp } from "@shared/datetime"

function formatTimestamp(timeText: string) {
  return formatChatTimestamp(timeText, "time")
}

function isMine(item: MobileChatItem, viewerParticipantId?: string) {
  return Boolean(
    viewerParticipantId &&
    item.authorParticipantId &&
    item.authorParticipantId === viewerParticipantId
  )
}

function ImageAttachment({
  uri,
  onPress,
}: {
  uri: string
  onPress: () => void
}) {
  const source = useAuthenticatedMediaSource(uri)

  if (!source) {
    return <View style={styles.imageAttachment} />
  }

  return (
    <Pressable onPress={onPress}>
      <Image
        source={source}
        style={styles.imageAttachment}
        contentFit="cover"
        transition={150}
      />
    </Pressable>
  )
}

function MarkdownMessage({
  blocks,
  mine,
}: {
  blocks: MobileChatItem["contentBlocks"]
  mine: boolean
}) {
  const markdown = serializeMarkdownBlocks(
    blocks.filter((block) => block.type !== "file_ref")
  )

  if (!markdown) {
    return null
  }

  return (
    <View style={styles.markdownWrap}>
      <ChatMarkdown markdown={markdown} mine={mine} />
    </View>
  )
}

function FileAttachmentCard({
  category,
  fileName,
  mimeType,
  mine,
  onPress,
}: {
  category: "audio" | "video" | "document"
  fileName: string
  mimeType: string
  mine: boolean
  onPress: () => void
}) {
  const iconName =
    category === "audio" ? "mic" : category === "video" ? "video" : "file-text"

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.fileCard,
        mine && styles.fileCardMine,
        pressed && styles.fileCardPressed,
      ]}
    >
      <View style={[styles.fileCardIcon, mine && styles.fileCardIconMine]}>
        <Feather
          name={iconName}
          size={18}
          color={mine ? theme.colors.white : theme.colors.primary}
        />
      </View>
      <View style={styles.fileCardBody}>
        <Text
          numberOfLines={1}
          style={[styles.fileCardTitle, mine && styles.fileCardTitleMine]}
        >
          {fileName}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.fileCardMeta, mine && styles.fileCardMetaMine]}
        >
          {`${getAttachmentLabel(category)} · ${mimeType}`}
        </Text>
      </View>
      <Feather
        name="arrow-up-right"
        size={16}
        color={mine ? "rgba(255,255,255,0.78)" : theme.colors.textMuted}
      />
    </Pressable>
  )
}

function MessageReplyPreview({
  item,
  mine,
}: {
  item: MobileChatItem
  mine: boolean
}) {
  if (!item.replyTo) {
    return null
  }

  return (
    <View style={[styles.replyPreview, mine && styles.replyPreviewMine]}>
      <View style={[styles.replyRail, mine && styles.replyRailMine]} />
      <View style={styles.replyBody}>
        <Text
          numberOfLines={1}
          style={[styles.replyAuthor, mine && styles.replyAuthorMine]}
        >
          {getEntityDisplayName(item.replyTo.author)}
        </Text>
        <Text
          numberOfLines={2}
          style={[styles.replyText, mine && styles.replyTextMine]}
        >
          {buildReplyPreviewText(item.replyTo)}
        </Text>
      </View>
    </View>
  )
}

function MessageBlocks({
  item,
  mine,
  onOpenAttachment,
}: {
  item: MobileChatItem
  mine: boolean
  onOpenAttachment: (
    uri: string,
    mimeType: string,
    name: string,
    category: "image" | "video" | "audio" | "document"
  ) => void
}) {
  const attachments = item.contentBlocks.filter(
    (block) => block.type === "file_ref"
  )

  return (
    <View style={styles.messageBody}>
      <MarkdownMessage blocks={item.contentBlocks} mine={mine} />
      {attachments.map((block) => {
        if (block.type !== "file_ref") return null

        const blockUrl = resolveContentUrl(block.sha256) ?? ""

        if (block.category === "image") {
          return (
            <ImageAttachment
              key={block.id}
              uri={blockUrl}
              onPress={() =>
                onOpenAttachment(blockUrl, block.mimeType, block.name, "image")
              }
            />
          )
        }

        if (block.category === "audio") {
          return (
            <FileAttachmentCard
              key={block.id}
              category="audio"
              fileName={block.name}
              mimeType={block.mimeType}
              mine={mine}
              onPress={() =>
                onOpenAttachment(blockUrl, block.mimeType, block.name, "audio")
              }
            />
          )
        }

        return (
          <FileAttachmentCard
            key={block.id}
            category={block.category === "video" ? "video" : "document"}
            fileName={block.name}
            mimeType={block.mimeType}
            mine={mine}
            onPress={() =>
              onOpenAttachment(
                blockUrl,
                block.mimeType,
                block.name,
                block.category
              )
            }
          />
        )
      })}
    </View>
  )
}

export function MessageItem({
  item,
  viewerParticipantId,
  onResolveTask,
  onLongPress,
  onRetry,
}: {
  item: MobileChatItem
  viewerParticipantId?: string
  onResolveTask?: (
    taskId: string,
    input: ChatTaskResolveInput
  ) => Promise<TaskSummary>
  onLongPress?: (event: GestureResponderEvent) => void
  /** Invoked when the user taps "Retry" on a failed outbox entry. */
  onRetry?: (clientMessageId: string) => void
}) {
  if (item.itemType === "event") {
    const task =
      item.subtype === "task_requested" &&
      item.eventPayload &&
      typeof item.eventPayload === "object" &&
      "task" in item.eventPayload
        ? ((item.eventPayload as { task?: unknown }).task as
            | TaskSummary
            | undefined)
        : undefined

    if (task) {
      return <ChatTaskCard task={task} onResolveTask={onResolveTask} />
    }

    const eventText =
      summarizeConversationEvent(item.subtype, item.eventPayload) ||
      extractText(item.contentBlocks).trim() ||
      `[${item.subtype}]`
    return (
      <View style={styles.eventWrap}>
        <View style={styles.eventCard}>
          <Text style={styles.eventText}>{eventText}</Text>
        </View>
      </View>
    )
  }

  const mine = isMine(item, viewerParticipantId)
  const router = useRouter()
  const localDeliveryStatus = item.localDeliveryStatus
  const author = item.author
  const authorName = getEntityDisplayName(author)
  const authorAvatar = getEntityAvatarSpec(author)
  const avatarNode = (
    <Avatar
      name={authorAvatar.name}
      uri={authorAvatar.uri}
      icon={authorAvatar.icon}
      size={34}
    />
  )
  const bubbleNode = (
    <View
      style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}
    >
      <MessageBlocks
        item={item}
        mine={mine}
        onOpenAttachment={(uri, mimeType, name, category) =>
          router.push(
            buildChatFilePreviewHref({
              uri,
              mimeType,
              name,
              category,
              source: "remote",
            })
          )
        }
      />
    </View>
  )
  const messageNode = (
    <View style={[styles.messageStack, mine && styles.messageStackMine]}>
      {item.replyTo ? <MessageReplyPreview item={item} mine={mine} /> : null}
      {bubbleNode}
    </View>
  )

  return (
    <View
      style={[
        styles.messageRow,
        mine ? styles.messageRowMine : styles.messageRowOther,
      ]}
    >
      {!mine ? avatarNode : null}
      <View style={[styles.messageColumn, mine && styles.messageColumnMine]}>
        {!mine ? <Text style={styles.author}>{authorName}</Text> : null}
        {onLongPress ? (
          <Pressable
            onLongPress={onLongPress}
            delayLongPress={240}
            style={styles.longPressSurface}
          >
            {messageNode}
          </Pressable>
        ) : (
          messageNode
        )}
        <View style={[styles.metaRow, mine && styles.metaRowMine]}>
          {localDeliveryStatus ? (
            <Text
              style={[styles.deliveryStatus, mine && styles.deliveryStatusMine]}
            >
              {localDeliveryStatus === "retrying" ? "待重试" : "发送中"}
            </Text>
          ) : null}
          {localDeliveryStatus === "retrying" &&
          onRetry &&
          item.localOnly &&
          item.clientMessageId ? (
            <Pressable
              onPress={() => onRetry(item.clientMessageId!)}
              hitSlop={6}
            >
              <Text
                style={[
                  styles.deliveryStatus,
                  mine && styles.deliveryStatusMine,
                  styles.retryButton,
                ]}
              >
                重试
              </Text>
            </Pressable>
          ) : null}
          <Text style={[styles.timestamp, mine && styles.timestampMine]}>
            {formatTimestamp(item.createdAt)}
          </Text>
        </View>
      </View>
      {mine ? avatarNode : null}
    </View>
  )
}

const styles = StyleSheet.create({
  eventWrap: {
    alignItems: "center",
    paddingVertical: 8,
  },
  eventCard: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: theme.radii.pill,
    backgroundColor: theme.colors.surfaceMuted,
  },
  eventText: {
    fontSize: 12,
    color: theme.colors.textMuted,
    textAlign: "center",
  },
  messageRow: {
    flexDirection: "row",
    gap: 10,
    alignItems: "flex-end",
    minWidth: 0,
  },
  messageRowMine: {
    justifyContent: "flex-end",
  },
  messageRowOther: {
    justifyContent: "flex-start",
  },
  messageColumn: {
    maxWidth: "82%",
    minWidth: 0,
    flexShrink: 1,
    gap: 5,
  },
  messageColumnMine: {
    alignItems: "flex-end",
  },
  longPressSurface: {
    minWidth: 0,
    maxWidth: "100%",
  },
  messageStack: {
    gap: 6,
    alignItems: "flex-start",
    minWidth: 0,
    maxWidth: "100%",
  },
  messageStackMine: {
    alignItems: "flex-end",
  },
  author: {
    fontSize: 12,
    color: theme.colors.textSoft,
    marginLeft: 2,
  },
  bubble: {
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
    minWidth: 0,
    maxWidth: "100%",
    overflow: "hidden",
  },
  bubbleMine: {
    backgroundColor: theme.colors.primary,
  },
  bubbleOther: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  messageBody: {
    gap: 10,
    minWidth: 0,
    maxWidth: "100%",
  },
  markdownWrap: {
    width: "100%",
    maxWidth: "100%",
    minWidth: 0,
    overflow: "hidden",
  },
  replyPreview: {
    maxWidth: 248,
    borderRadius: 14,
    backgroundColor: theme.colors.backgroundAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 10,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "stretch",
    gap: 9,
  },
  replyPreviewMine: {
    backgroundColor: theme.colors.primarySoft,
    borderColor: "rgba(37, 99, 235, 0.24)",
  },
  replyRail: {
    width: 3,
    borderRadius: 999,
    backgroundColor: theme.colors.primary,
  },
  replyRailMine: {
    backgroundColor: theme.colors.primary,
  },
  replyBody: {
    flex: 1,
    gap: 2,
  },
  replyAuthor: {
    fontSize: 12,
    fontWeight: "700",
    color: theme.colors.primary,
  },
  replyAuthorMine: {
    color: theme.colors.primary,
  },
  replyText: {
    fontSize: 12,
    lineHeight: 17,
    color: theme.colors.textMuted,
  },
  replyTextMine: {
    color: theme.colors.text,
  },
  timestamp: {
    fontSize: 11,
    color: theme.colors.textSoft,
    marginLeft: 2,
  },
  timestampMine: {
    textAlign: "right",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  metaRowMine: {
    justifyContent: "flex-end",
  },
  deliveryStatus: {
    fontSize: 11,
    color: theme.colors.textSoft,
    fontWeight: "700",
  },
  deliveryStatusMine: {
    color: theme.colors.primary,
  },
  retryButton: {
    color: theme.colors.primary,
    textDecorationLine: "underline",
  },
  imageAttachment: {
    width: 220,
    height: 220,
    borderRadius: 18,
    backgroundColor: theme.colors.backgroundAlt,
  },
  fileCard: {
    minWidth: 180,
    maxWidth: 250,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.backgroundAlt,
    paddingHorizontal: 12,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  fileCardMine: {
    backgroundColor: "rgba(255,255,255,0.12)",
    borderColor: "rgba(255,255,255,0.18)",
  },
  fileCardPressed: {
    opacity: 0.82,
  },
  fileCardIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.primarySoft,
  },
  fileCardIconMine: {
    backgroundColor: "rgba(255,255,255,0.16)",
  },
  fileCardBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  fileCardTitle: {
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.text,
    fontWeight: "700",
  },
  fileCardTitleMine: {
    color: theme.colors.white,
  },
  fileCardMeta: {
    fontSize: 11,
    lineHeight: 15,
    color: theme.colors.textMuted,
  },
  fileCardMetaMine: {
    color: "rgba(255,255,255,0.74)",
  },
})
