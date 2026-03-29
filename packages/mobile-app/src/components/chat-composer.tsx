import Feather from "@expo/vector-icons/Feather";
import * as DocumentPicker from "expo-document-picker";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { api } from "@/lib/api";
import { createId } from "@/lib/ids";
import { theme } from "@/theme/tokens";
import { fileRefBlock, textBlock, type CanonicalContentBlock } from "@shared";

type AttachmentKind = "image" | "video" | "audio" | "file";

interface LocalAttachment {
  id: string;
  kind: AttachmentKind;
  uri: string;
  name: string;
  mimeType: string;
}

function inferAttachmentKind(mimeType: string): AttachmentKind {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("image/")) return "image";
  return "file";
}

function assetName(kind: AttachmentKind, uri: string) {
  const extension = uri.split(".").pop()?.toLowerCase();
  if (extension) {
    return `${kind}-${Date.now()}.${extension}`;
  }

  if (kind === "video") return `video-${Date.now()}.mp4`;
  if (kind === "audio") return `voice-${Date.now()}.m4a`;
  if (kind === "file") return `file-${Date.now()}`;
  return `photo-${Date.now()}.jpg`;
}

function attachmentIconName(
  kind: AttachmentKind,
): keyof typeof Feather.glyphMap {
  if (kind === "video") return "video";
  if (kind === "audio") return "mic";
  if (kind === "file") return "file-text";
  return "image";
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
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
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
      Alert.alert("无法访问相册", "请先授权照片和视频访问权限。");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      allowsMultipleSelection: true,
      quality: 0.9,
      selectionLimit: 6,
    });

    if (result.canceled) return;

    setMenuVisible(false);
    setAttachments((current) => [
      ...current,
      ...result.assets.map((asset) => {
        const mimeType =
          asset.mimeType ||
          (asset.type === "video" ? "video/mp4" : "image/jpeg");
        const kind = inferAttachmentKind(mimeType);
        return {
          id: createId("attachment"),
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
      Alert.alert("无法使用相机", "请先授权相机权限。");
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images", "videos"],
      quality: 0.85,
    });

    if (result.canceled || result.assets.length === 0) return;

    const asset = result.assets[0]!;
    const mimeType =
      asset.mimeType || (asset.type === "video" ? "video/mp4" : "image/jpeg");
    const kind = inferAttachmentKind(mimeType);

    setMenuVisible(false);
    setAttachments((current) => [
      ...current,
      {
        id: createId("attachment"),
        kind,
        uri: asset.uri,
        name: asset.fileName || assetName(kind, asset.uri),
        mimeType,
      },
    ]);
  }

  async function pickDocument() {
    const result = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
    });

    if (result.canceled) return;

    setMenuVisible(false);
    setAttachments((current) => [
      ...current,
      ...result.assets.map((asset) => {
        const mimeType = asset.mimeType || "application/octet-stream";
        const kind = inferAttachmentKind(mimeType);
        return {
          id: createId("attachment"),
          kind,
          uri: asset.uri,
          name: asset.name || assetName(kind, asset.uri),
          mimeType,
        };
      }),
    ]);
  }

  async function toggleRecording() {
    setMenuVisible(false);

    if (recorderState.isRecording) {
      await recorder.stop();
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        interruptionMode: "duckOthers",
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
      });
      const uri = recorder.getStatus().url || recorderState.url;
      if (!uri) return;

      setAttachments((existing) => [
        ...existing,
        {
          id: createId("attachment"),
          kind: "audio",
          uri,
          name: assetName("audio", uri),
          mimeType: "audio/mp4",
        },
      ]);
      return;
    }

    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("无法录音", "请先授权麦克风权限。");
      return;
    }

    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      interruptionMode: "duckOthers",
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    });

    await recorder.prepareToRecordAsync();
    recorder.record();
  }

  async function handleSend() {
    const trimmed = draft.trim();
    if (!trimmed && attachments.length === 0) return;

    setMenuVisible(false);
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
            category: attachment.kind === "file" ? "document" : attachment.kind,
          }),
        );
      }

      const contentBlocks: CanonicalContentBlock[] = [
        ...(trimmed ? [textBlock(trimmed)] : []),
        ...fileBlocks,
      ];

      await onSend(contentBlocks);
      setDraft("");
      setAttachments([]);
    } finally {
      setSending(false);
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) =>
      current.filter((attachment) => attachment.id !== id),
    );
  }

  const sendDisabled =
    disabled || sending || (!draft.trim() && attachments.length === 0);

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
              {attachment.kind === "image" ? (
                <Image
                  source={{ uri: attachment.uri }}
                  style={styles.attachmentThumb}
                  contentFit="cover"
                />
              ) : (
                <View style={styles.attachmentIcon}>
                  <Feather
                    name={attachmentIconName(attachment.kind)}
                    size={18}
                    color={theme.colors.primary}
                  />
                </View>
              )}
              <Text numberOfLines={1} style={styles.attachmentLabel}>
                {attachment.name}
              </Text>
              <Pressable
                onPress={() => removeAttachment(attachment.id)}
                style={styles.attachmentRemove}
              >
                <Feather name="x" size={14} color={theme.colors.textMuted} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}

      {recorderState.isRecording ? (
        <Text style={styles.recordingHint}>录音中，再点一次麦克风结束</Text>
      ) : null}

      <View style={styles.composerShell}>
        <RoundAction
          icon={recorderState.isRecording ? "square" : "mic"}
          onPress={() => void toggleRecording()}
          disabled={disabled || sending}
          active={recorderState.isRecording}
        />

        <View style={styles.inputShell}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onFocus={() => setMenuVisible(false)}
            placeholder="发消息"
            placeholderTextColor={theme.colors.textSoft}
            multiline
            style={styles.textInput}
            editable={!disabled && !sending}
          />
        </View>

        <View style={styles.actionRow}>
          <RoundAction
            icon="plus"
            onPress={() => setMenuVisible((current) => !current)}
            disabled={disabled || sending}
            active={menuVisible}
          />
          <Pressable
            onPress={() => void handleSend()}
            disabled={sendDisabled}
            style={({ pressed }) => [
              styles.sendButton,
              sendDisabled && styles.sendButtonDisabled,
              pressed && !sendDisabled && styles.sendButtonPressed,
            ]}
          >
            {sending ? (
              <ActivityIndicator color={theme.colors.white} />
            ) : (
              <Feather name="send" size={16} color={theme.colors.white} />
            )}
          </Pressable>
        </View>

        {menuVisible ? (
          <View style={styles.quickMenu}>
            <MenuAction
              icon="image"
              label="相册"
              onPress={() => void pickLibrary()}
            />
            <MenuAction
              icon="camera"
              label="拍摄"
              onPress={() => void launchCamera()}
            />
            <MenuAction
              icon="file-text"
              label="文件"
              onPress={() => void pickDocument()}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

function RoundAction({
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
        styles.roundAction,
        active && styles.roundActionActive,
        disabled && styles.roundActionDisabled,
        pressed && !disabled && styles.roundActionPressed,
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

function MenuAction({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.menuAction}>
      <View style={styles.menuActionIcon}>
        <Feather name={icon} size={18} color={theme.colors.primary} />
      </View>
      <Text style={styles.menuActionLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 10,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 14,
    backgroundColor: theme.colors.surface,
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
    backgroundColor: theme.colors.surfaceMuted,
    padding: 10,
    gap: 8,
  },
  attachmentThumb: {
    width: "100%",
    height: 84,
    borderRadius: 12,
    backgroundColor: theme.colors.backgroundAlt,
  },
  attachmentIcon: {
    width: "100%",
    height: 84,
    borderRadius: 12,
    backgroundColor: theme.colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  attachmentLabel: {
    fontSize: 12,
    color: theme.colors.text,
  },
  attachmentRemove: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  recordingHint: {
    fontSize: 12,
    color: theme.colors.accent,
    paddingHorizontal: 2,
  },
  composerShell: {
    position: "relative",
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
  },
  inputShell: {
    flex: 1,
    minHeight: 42,
    maxHeight: 120,
    borderRadius: 22,
    backgroundColor: theme.colors.surfaceMuted,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 14,
    paddingVertical: 9,
    justifyContent: "center",
  },
  textInput: {
    minHeight: 22,
    maxHeight: 96,
    fontSize: 16,
    lineHeight: 22,
    color: theme.colors.text,
    textAlignVertical: "center",
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  roundAction: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.primarySoft,
  },
  roundActionActive: {
    backgroundColor: theme.colors.primary,
  },
  roundActionDisabled: {
    opacity: 0.45,
  },
  roundActionPressed: {
    transform: [{ scale: 0.96 }],
  },
  sendButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonDisabled: {
    opacity: 0.45,
  },
  sendButtonPressed: {
    transform: [{ scale: 0.96 }],
  },
  quickMenu: {
    position: "absolute",
    right: 52,
    bottom: 52,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    shadowColor: theme.colors.black,
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  menuAction: {
    width: 64,
    alignItems: "center",
    gap: 8,
  },
  menuActionIcon: {
    width: 44,
    height: 44,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.primarySoft,
  },
  menuActionLabel: {
    fontSize: 12,
    color: theme.colors.text,
  },
});
