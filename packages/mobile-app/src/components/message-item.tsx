import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import { useMemo } from 'react';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/ui';
import { buildAuthenticatedSource } from '@/lib/api';
import { theme } from '@/theme/tokens';
import type { ConversationFeedItem, ConversationFeedMessageItem } from '@shared';
import {
  extractText,
  summarizeConversationEvent,
} from '@shared';

function formatTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function isUserMessage(item: ConversationFeedMessageItem) {
  return item.role === 'user';
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

    if (status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration - 0.1)) {
      await player.seekTo(0);
    }

    player.play();
  }

  return (
    <Pressable onPress={() => void togglePlayback()} style={styles.audioChip}>
      <Feather
        name={status.playing ? 'pause-circle' : 'play-circle'}
        size={18}
        color={theme.colors.primary}
      />
      <Text style={styles.audioChipLabel}>{status.playing ? '暂停语音' : '播放语音'}</Text>
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

function MessageBlocks({
  item,
  mine,
}: {
  item: ConversationFeedMessageItem;
  mine: boolean;
}) {
  const textContent = useMemo(() => {
    const value = extractText(item.contentBlocks).trim();
    return value || item.content?.trim();
  }, [item.content, item.contentBlocks]);

  const attachments = item.contentBlocks.filter((block) => block.type === 'file_ref');

  return (
    <View style={styles.messageBody}>
      {textContent ? (
        <Text style={[styles.messageText, mine && styles.messageTextMine]}>{textContent}</Text>
      ) : null}
      {attachments.map((block) => {
        if (block.type !== 'file_ref') return null;

        const source = buildAuthenticatedSource(block.url);

        if (block.category === 'image') {
          return (
            <Image
              key={block.id}
              source={source}
              style={styles.imageAttachment}
              contentFit="cover"
              transition={150}
            />
          );
        }

        if (block.category === 'video') {
          return <VideoAttachment key={block.id} uri={block.url} />;
        }

        if (block.category === 'audio') {
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

export function MessageItem({ item }: { item: ConversationFeedItem }) {
  if (item.kind === 'event') {
    return (
      <View style={styles.eventWrap}>
        <View style={styles.eventCard}>
          <Text style={styles.eventText}>
            {summarizeConversationEvent(item.eventType, item.payload as Record<string, unknown>)}
          </Text>
        </View>
      </View>
    );
  }

  const mine = isUserMessage(item);

  return (
    <View style={[styles.messageRow, mine ? styles.messageRowMine : styles.messageRowOther]}>
      {!mine ? (
        <Avatar
          name={item.author?.name}
          uri={item.author?.avatarUrl}
          icon={item.author?.memberType === 'actor' ? 'cpu' : 'user'}
          size={34}
        />
      ) : null}
      <View style={[styles.messageColumn, mine && styles.messageColumnMine]}>
        {!mine && item.author?.name ? <Text style={styles.author}>{item.author.name}</Text> : null}
        <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}>
          <MessageBlocks item={item} mine={mine} />
        </View>
        <Text style={[styles.timestamp, mine && styles.timestampMine]}>
          {formatTimestamp(item.createdAt)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  eventWrap: {
    alignItems: 'center',
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
    textAlign: 'center',
  },
  messageRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-end',
  },
  messageRowMine: {
    justifyContent: 'flex-end',
  },
  messageRowOther: {
    justifyContent: 'flex-start',
  },
  messageColumn: {
    maxWidth: '82%',
    gap: 5,
  },
  messageColumnMine: {
    alignItems: 'flex-end',
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
  messageText: {
    fontSize: 15,
    lineHeight: 22,
    color: theme.colors.text,
  },
  messageTextMine: {
    color: theme.colors.white,
  },
  timestamp: {
    fontSize: 11,
    color: theme.colors.textSoft,
    marginLeft: 2,
  },
  timestampMine: {
    textAlign: 'right',
  },
  imageAttachment: {
    width: 220,
    height: 220,
    borderRadius: 18,
    backgroundColor: theme.colors.backgroundAlt,
  },
  videoShell: {
    borderRadius: 18,
    overflow: 'hidden',
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  audioChipLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: theme.colors.primary,
  },
  fileChip: {
    minWidth: 140,
    maxWidth: 220,
    borderRadius: 16,
    backgroundColor: theme.colors.surfaceMuted,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  fileChipLabel: {
    flex: 1,
    fontSize: 13,
    color: theme.colors.text,
  },
});
