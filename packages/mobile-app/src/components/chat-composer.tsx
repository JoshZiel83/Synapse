import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { createId } from '@/lib/ids';
import { theme } from '@/theme/tokens';
import { fileRefBlock, textBlock, type CanonicalContentBlock } from '@shared';

type AttachmentKind = 'image' | 'video' | 'audio';

interface LocalAttachment {
  id: string;
  kind: AttachmentKind;
  uri: string;
  name: string;
  mimeType: string;
}

function inferAttachmentKind(mimeType: string): AttachmentKind {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'image';
}

function assetName(kind: AttachmentKind, uri: string) {
  const extension = uri.split('.').pop()?.toLowerCase();
  if (extension) {
    return `${kind}-${Date.now()}.${extension}`;
  }

  if (kind === 'video') return `video-${Date.now()}.mp4`;
  if (kind === 'audio') return `voice-${Date.now()}.m4a`;
  return `photo-${Date.now()}.jpg`;
}

export function ChatComposer({
  workspaceId,
  disabled,
  onSend,
}: {
  workspaceId: string;
  disabled?: boolean;
  onSend: (contentBlocks: CanonicalContentBlock[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);

  useEffect(() => {
    return () => {
      if (recorderState.isRecording) {
        void recorder.stop().catch(() => undefined);
      }
    };
  }, [recorder, recorderState.isRecording]);

  async function pickLibrary() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('无法访问相册', '请先授权照片和视频访问权限。');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      quality: 0.9,
      selectionLimit: 6,
    });

    if (result.canceled) return;

    setAttachments((current) => [
      ...current,
      ...result.assets.map((asset) => {
        const mimeType = asset.mimeType || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg');
        const kind = inferAttachmentKind(mimeType);
        return {
          id: createId('attachment'),
          kind,
          uri: asset.uri,
          name: asset.fileName || assetName(kind, asset.uri),
          mimeType,
        };
      }),
    ]);
  }

  async function launchCamera() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('无法使用相机', '请先授权相机权限。');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.85,
    });

    if (result.canceled || result.assets.length === 0) return;

    const asset = result.assets[0]!;
    const mimeType = asset.mimeType || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg');
    const kind = inferAttachmentKind(mimeType);
    setAttachments((current) => [
      ...current,
      {
        id: createId('attachment'),
        kind,
        uri: asset.uri,
        name: asset.fileName || assetName(kind, asset.uri),
        mimeType,
      },
    ]);
  }

  async function toggleRecording() {
    if (recorderState.isRecording) {
      await recorder.stop();
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        interruptionMode: 'duckOthers',
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
      });
      const uri = recorder.getStatus().url || recorderState.url;
      if (!uri) return;

      setAttachments((existing) => [
        ...existing,
        {
          id: createId('attachment'),
          kind: 'audio',
          uri,
          name: assetName('audio', uri),
          mimeType: 'audio/mp4',
        },
      ]);
      return;
    }

    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('无法录音', '请先授权麦克风权限。');
      return;
    }

    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      interruptionMode: 'duckOthers',
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    });

    await recorder.prepareToRecordAsync();
    recorder.record();
  }

  async function handleSend() {
    const trimmed = draft.trim();
    if (!trimmed && attachments.length === 0) return;

    setSending(true);

    try {
      const fileBlocks = [];
      for (const attachment of attachments) {
        const uploaded = await api.uploadAsset(workspaceId, {
          uri: attachment.uri,
          name: attachment.name,
          mimeType: attachment.mimeType,
        });

        fileBlocks.push(
          fileRefBlock({
            fileId: uploaded.id,
            storedName: uploaded.storedName,
            url: uploaded.url,
            mimeType: uploaded.mimeType,
            originalName: uploaded.originalName,
            sizeBytes: uploaded.sizeBytes,
            category: attachment.kind === 'audio' ? 'audio' : attachment.kind,
          }),
        );
      }

      const contentBlocks: CanonicalContentBlock[] = [
        ...(trimmed ? [textBlock(trimmed)] : []),
        ...fileBlocks,
      ];

      await onSend(contentBlocks);
      setDraft('');
      setAttachments([]);
    } finally {
      setSending(false);
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  return (
    <View style={styles.wrap}>
      {attachments.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.attachmentRow}
        >
          {attachments.map((attachment) => (
            <View key={attachment.id} style={styles.attachmentChip}>
              {attachment.kind === 'image' ? (
                <Image source={{ uri: attachment.uri }} style={styles.attachmentThumb} contentFit="cover" />
              ) : (
                <View style={styles.attachmentIcon}>
                  <Feather
                    name={attachment.kind === 'video' ? 'video' : 'mic'}
                    size={18}
                    color={theme.colors.primary}
                  />
                </View>
              )}
              <Text numberOfLines={1} style={styles.attachmentLabel}>
                {attachment.name}
              </Text>
              <Pressable onPress={() => removeAttachment(attachment.id)} style={styles.attachmentRemove}>
                <Feather name="x" size={14} color={theme.colors.textMuted} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}

      <View style={styles.composerShell}>
        <View style={styles.actionColumn}>
          <IconAction icon="image" onPress={() => void pickLibrary()} disabled={disabled || sending} />
          <IconAction icon="camera" onPress={() => void launchCamera()} disabled={disabled || sending} />
          <IconAction
            icon={recorderState.isRecording ? 'square' : 'mic'}
            onPress={() => void toggleRecording()}
            disabled={disabled || sending}
            active={recorderState.isRecording}
          />
        </View>
        <View style={styles.inputColumn}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="输入文字，或添加图片 / 语音 / 视频..."
            placeholderTextColor={theme.colors.textSoft}
            multiline
            style={styles.textInput}
            editable={!disabled && !sending}
          />
          <View style={styles.footerRow}>
            <Text style={styles.footerHint}>
              {recorderState.isRecording ? '录音中，再点一次结束' : '支持图片、文字、语音、拍照、录像'}
            </Text>
            <Pressable
              onPress={() => void handleSend()}
              disabled={disabled || sending}
              style={({ pressed }) => [
                styles.sendButton,
                (disabled || sending) && styles.sendButtonDisabled,
                pressed && !disabled && !sending && styles.sendButtonPressed,
              ]}
            >
              {sending ? (
                <ActivityIndicator color={theme.colors.white} />
              ) : (
                <Feather name="send" size={17} color={theme.colors.white} />
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

function IconAction({
  icon,
  onPress,
  disabled,
  active,
}: {
  icon: keyof typeof Feather.glyphMap;
  onPress: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.iconAction,
        active && styles.iconActionActive,
        disabled && styles.iconActionDisabled,
        pressed && !disabled && styles.iconActionPressed,
      ]}
    >
      <Feather
        name={icon}
        size={18}
        color={active ? theme.colors.white : theme.colors.primary}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 10,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 14,
    backgroundColor: 'rgba(244, 239, 231, 0.98)',
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  attachmentRow: {
    gap: 10,
    paddingHorizontal: 2,
  },
  attachmentChip: {
    width: 140,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: 10,
    gap: 8,
  },
  attachmentThumb: {
    width: '100%',
    height: 84,
    borderRadius: 12,
    backgroundColor: theme.colors.backgroundAlt,
  },
  attachmentIcon: {
    width: '100%',
    height: 84,
    borderRadius: 12,
    backgroundColor: theme.colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachmentLabel: {
    fontSize: 12,
    color: theme.colors.text,
  },
  attachmentRemove: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerShell: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-end',
  },
  actionColumn: {
    gap: 10,
    paddingBottom: 6,
  },
  iconAction: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primarySoft,
  },
  iconActionActive: {
    backgroundColor: theme.colors.accent,
  },
  iconActionDisabled: {
    opacity: 0.45,
  },
  iconActionPressed: {
    transform: [{ scale: 0.96 }],
  },
  inputColumn: {
    flex: 1,
    borderRadius: 26,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 10,
  },
  textInput: {
    minHeight: 56,
    maxHeight: 128,
    fontSize: 16,
    lineHeight: 22,
    color: theme.colors.text,
    textAlignVertical: 'top',
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  footerHint: {
    flex: 1,
    fontSize: 12,
    color: theme.colors.textSoft,
  },
  sendButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
  sendButtonPressed: {
    transform: [{ scale: 0.96 }],
  },
});
