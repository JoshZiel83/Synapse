import Feather from "@expo/vector-icons/Feather";
import { Image } from "expo-image";
import { useMemo } from "react";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useVideoPlayer, VideoView } from "expo-video";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from "react-native";

import { Avatar } from "@/components/ui";
import { buildAuthenticatedSource } from "@/lib/api";
import {
  buildReplyPreviewText,
  getEntityAvatarSpec,
  getEntityDisplayName,
  type MobileChatItem,
} from "@/lib/chat-data";
import { theme } from "@/theme/tokens";
import {
  extractText,
  formatMentionText,
  summarizeConversationEvent,
} from "@shared";

function formatTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function isMine(item: MobileChatItem, viewerParticipantId?: string) {
  return Boolean(
    viewerParticipantId &&
      item.authorParticipantId &&
      item.authorParticipantId === viewerParticipantId,
  );
}

function AudioAttachment({ uri }: { uri: string }) {
  const source = useMemo(() => buildAuthenticatedSource(uri), [uri]);
  const player = useAudioPlayer(source);
  const status = useAudioPlayerStatus(player);

  async function togglePlayback() {
    if (status.playing) {
      player.pause();
      return;
    }

    if (
      status.didJustFinish ||
      (status.duration > 0 && status.currentTime >= status.duration - 0.1)
    ) {
      await player.seekTo(0);
    }

    player.play();
  }

  return (
    <Pressable onPress={() => void togglePlayback()} style={styles.audioChip}>
      <Feather
        name={status.playing ? "pause-circle" : "play-circle"}
        size={18}
        color={theme.colors.primary}
      />
      <Text style={styles.audioChipLabel}>
        {status.playing ? "暂停语音" : "播放语音"}
      </Text>
    </Pressable>
  );
}

function VideoAttachment({ uri }: { uri: string }) {
  const source = useMemo(() => buildAuthenticatedSource(uri), [uri]);
  const player = useVideoPlayer(source);

  return (
    <View style={styles.videoShell}>
      <VideoView
        player={player}
        style={styles.videoAttachment}
        nativeControls
        contentFit="cover"
        allowsFullscreen
      />
    </View>
  );
}

function ImageAttachment({ uri }: { uri: string }) {
  const source = useMemo(() => buildAuthenticatedSource(uri), [uri]);

  return (
    <Image
      source={source}
      style={styles.imageAttachment}
      contentFit="cover"
      transition={150}
    />
  );
}

function InlineMessageText({
  item,
  mine,
}: {
  item: MobileChatItem;
  mine: boolean;
}) {
  const inlineBlocks = item.contentBlocks.filter((block) => block.type !== "file_ref");
  if (inlineBlocks.length === 0) {
    return null;
  }

  return (
    <Text style={[styles.messageText, mine && styles.messageTextMine]}>
      {inlineBlocks.map((block) => {
        if (block.type === "text") {
          return <Text key={block.id}>{block.text}</Text>;
        }

        if (block.type === "mention") {
          return (
            <Text
              key={block.id}
              style={[
                styles.mentionText,
                mine && styles.mentionTextMine,
              ]}
            >
              {formatMentionText(block)}
            </Text>
          );
        }

        return null;
      })}
    </Text>
  );
}

function MessageReplyPreview({
  item,
  mine,
}: {
  item: MobileChatItem;
  mine: boolean;
}) {
  if (!item.replyTo) {
    return null;
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
  );
}

function MessageBlocks({
  item,
  mine,
}: {
  item: MobileChatItem;
  mine: boolean;
}) {
  const attachments = item.contentBlocks.filter((block) => block.type === "file_ref");

  return (
    <View style={styles.messageBody}>
      <InlineMessageText item={item} mine={mine} />
      {attachments.map((block) => {
        if (block.type !== "file_ref") return null;

        if (block.category === "image") {
          return <ImageAttachment key={block.id} uri={block.url} />;
        }

        if (block.category === "video") {
          return <VideoAttachment key={block.id} uri={block.url} />;
        }

        if (block.category === "audio") {
          return <AudioAttachment key={block.id} uri={block.url} />;
        }

        return (
          <View key={block.id} style={styles.fileChip}>
            <Feather name="file-text" size={16} color={theme.colors.textMuted} />
            <Text numberOfLines={1} style={styles.fileChipLabel}>
              {block.originalName}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export function MessageItem({
  item,
  viewerParticipantId,
  onLongPress,
}: {
  item: MobileChatItem;
  viewerParticipantId?: string;
  onLongPress?: (event: GestureResponderEvent) => void;
}) {
  if (item.itemType === "event") {
    const eventText =
      summarizeConversationEvent(item.subtype, item.eventPayload) ||
      extractText(item.contentBlocks).trim() ||
      `[${item.subtype}]`;
    return (
      <View style={styles.eventWrap}>
        <View style={styles.eventCard}>
          <Text style={styles.eventText}>{eventText}</Text>
        </View>
      </View>
    );
  }

  const mine = isMine(item, viewerParticipantId);
  const localDeliveryStatus = item.localDeliveryStatus;
  const author = item.author;
  const authorName = getEntityDisplayName(author);
  const authorAvatar = getEntityAvatarSpec(author);
  const avatarNode = (
    <Avatar
      name={authorAvatar.name}
      uri={authorAvatar.uri}
      icon={authorAvatar.icon}
      size={34}
    />
  );
  const bubbleNode = (
    <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}>
      <MessageBlocks item={item} mine={mine} />
    </View>
  );
  const messageNode = (
    <View style={[styles.messageStack, mine && styles.messageStackMine]}>
      {item.replyTo ? <MessageReplyPreview item={item} mine={mine} /> : null}
      {bubbleNode}
    </View>
  );

  return (
    <View style={[styles.messageRow, mine ? styles.messageRowMine : styles.messageRowOther]}>
      {!mine ? avatarNode : null}
      <View style={[styles.messageColumn, mine && styles.messageColumnMine]}>
        {!mine ? <Text style={styles.author}>{authorName}</Text> : null}
        {onLongPress ? (
          <Pressable onLongPress={onLongPress} delayLongPress={240}>
            {messageNode}
          </Pressable>
        ) : (
          messageNode
        )}
        <View style={[styles.metaRow, mine && styles.metaRowMine]}>
          {localDeliveryStatus ? (
            <Text style={[styles.deliveryStatus, mine && styles.deliveryStatusMine]}>
              {localDeliveryStatus === "retrying" ? "待重试" : "发送中"}
            </Text>
          ) : null}
          <Text style={[styles.timestamp, mine && styles.timestampMine]}>
            {formatTimestamp(item.createdAt)}
          </Text>
        </View>
      </View>
      {mine ? avatarNode : null}
    </View>
  );
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
  },
  messageRowMine: {
    justifyContent: "flex-end",
  },
  messageRowOther: {
    justifyContent: "flex-start",
  },
  messageColumn: {
    maxWidth: "82%",
    gap: 5,
  },
  messageColumnMine: {
    alignItems: "flex-end",
  },
  messageStack: {
    gap: 6,
    alignItems: "flex-start",
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
  messageText: {
    fontSize: 15,
    lineHeight: 22,
    color: theme.colors.text,
  },
  messageTextMine: {
    color: theme.colors.white,
  },
  mentionText: {
    color: theme.colors.primary,
    fontWeight: "700",
  },
  mentionTextMine: {
    color: theme.colors.white,
    fontWeight: "800",
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
  imageAttachment: {
    width: 220,
    height: 220,
    borderRadius: 18,
    backgroundColor: theme.colors.backgroundAlt,
  },
  videoShell: {
    borderRadius: 18,
    overflow: "hidden",
  },
  videoAttachment: {
    width: 220,
    height: 220,
    backgroundColor: theme.colors.black,
  },
  audioChip: {
    minWidth: 128,
    borderRadius: theme.radii.pill,
    backgroundColor: theme.colors.primarySoft,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  audioChipLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.primary,
  },
  fileChip: {
    minWidth: 148,
    maxWidth: 220,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.backgroundAlt,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  fileChipLabel: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.text,
  },
});
