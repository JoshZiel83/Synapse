import Feather from "@expo/vector-icons/Feather";
import * as DocumentPicker from "expo-document-picker";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useRouter, type Href } from "expo-router";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";

import { api } from "@/lib/api";
import {
  buildContentBlocksFromDraftText,
  insertMentionIntoDraft,
  normalizeMentionBackspace,
  reconcileDraftMentions,
  type ChatComposerSendPayload,
  type ChatDraftMention,
} from "@/lib/chat-compose";
import { subscribeMentionSelection } from "@/lib/chat-mention-selection";
import {
  buildReplyPreviewText,
  getEntityDisplayName,
  getMentionableConversationParticipants,
} from "@/lib/chat-data";
import { createId } from "@/lib/ids";
import { theme } from "@/theme/tokens";
import {
  fileRefBlock,
  type ChatConversationView,
  type ConversationReplyRef,
} from "@shared";

type AttachmentKind = "image" | "video" | "audio" | "file";

interface LocalAttachment {
  id: string;
  kind: AttachmentKind;
  uri: string;
  name: string;
  mimeType: string;
}

const DEFAULT_INPUT_HEIGHT = 22;

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

function findInsertedMentionTrigger(previousText: string, nextText: string) {
  if (nextText.length !== previousText.length + 1) {
    return null;
  }

  let index = 0;
  while (
    index < previousText.length &&
    previousText[index] === nextText[index]
  ) {
    index += 1;
  }

  if (nextText[index] !== "@") {
    return null;
  }

  return previousText.slice(index) === nextText.slice(index + 1) ? index : null;
}

function getDraftMeasurementText(text: string) {
  if (text.length === 0) {
    return " ";
  }

  return text.endsWith("\n") ? `${text} ` : text;
}

export function ChatComposer({
  workspaceId,
  conversationId,
  conversation,
  viewerParticipantId,
  disabled,
  replyTo,
  onCancelReply,
  onSend,
}: {
  workspaceId: string;
  conversationId: string;
  conversation: ChatConversationView;
  viewerParticipantId?: string;
  disabled?: boolean;
  replyTo?: ConversationReplyRef | null;
  onCancelReply?: () => void;
  onSend: (payload: ChatComposerSendPayload) => Promise<void>;
}) {
  const router = useRouter();
  const { height: windowHeight } = useWindowDimensions();
  const [draftText, setDraftText] = useState("");
  const [draftMentions, setDraftMentions] = useState<ChatDraftMention[]>([]);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [inputHeight, setInputHeight] = useState(DEFAULT_INPUT_HEIGHT);
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);
  const draftTextRef = useRef(draftText);
  const draftMentionsRef = useRef(draftMentions);
  const selectionRef = useRef(selection);
  const pendingMentionInsertIndexRef = useRef<number | null>(null);
  const maxInputHeight = Math.max(120, Math.floor(windowHeight * 0.4));
  const mentionsEnabled = conversation.kind !== "private";

  const mentionCandidates = useMemo(
    () =>
      getMentionableConversationParticipants(conversation, viewerParticipantId),
    [conversation, viewerParticipantId],
  );

  const draftBlocks = useMemo(
    () => buildContentBlocksFromDraftText(draftText, draftMentions),
    [draftMentions, draftText],
  );

  useEffect(() => {
    draftTextRef.current = draftText;
  }, [draftText]);

  useEffect(() => {
    draftMentionsRef.current = draftMentions;
  }, [draftMentions]);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    return () => {
      if (recorderState.isRecording) {
        void recorder.stop().catch(() => undefined);
      }
    };
  }, [recorder, recorderState.isRecording]);

  useEffect(() => {
    return subscribeMentionSelection(conversationId, (mention) => {
      const insertIndex = pendingMentionInsertIndexRef.current;
      pendingMentionInsertIndexRef.current = null;
      if (insertIndex === null) {
        return;
      }

      const inserted = insertMentionIntoDraft(
        draftTextRef.current,
        draftMentionsRef.current,
        mention,
        insertIndex,
      );
      setDraftText(inserted.text);
      setDraftMentions(inserted.mentions);
      setSelection({
        start: inserted.selection,
        end: inserted.selection,
      });
    });
  }, [conversationId]);

  function openMentionPicker() {
    if (
      !mentionsEnabled ||
      disabled ||
      sending ||
      mentionCandidates.length === 0
    ) {
      return false;
    }

    router.push(
      `/chat/mention?conversationId=${encodeURIComponent(conversationId)}` as Href,
    );
    return true;
  }

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
    if (draftBlocks.length === 0 && attachments.length === 0) return;

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

      await onSend({
        contentBlocks: [...draftBlocks, ...fileBlocks],
        replyToItemId: replyTo?.itemId,
        replyTo: replyTo ?? undefined,
      });
      setDraftText("");
      setDraftMentions([]);
      setSelection({ start: 0, end: 0 });
      setInputHeight(DEFAULT_INPUT_HEIGHT);
      setAttachments([]);
      onCancelReply?.();
    } finally {
      setSending(false);
    }
  }

  function handleChangeText(nextText: string) {
    const previousText = draftTextRef.current;
    const normalizedDeletion = normalizeMentionBackspace(
      previousText,
      nextText,
      draftMentionsRef.current,
      selectionRef.current,
    );

    if (normalizedDeletion) {
      setDraftText(normalizedDeletion.text);
      setDraftMentions(normalizedDeletion.mentions);
      if (normalizedDeletion.text.length === 0) {
        setInputHeight(DEFAULT_INPUT_HEIGHT);
      }
      setSelection({
        start: normalizedDeletion.selection,
        end: normalizedDeletion.selection,
      });
      return;
    }

    const nextMentions = reconcileDraftMentions(
      previousText,
      nextText,
      draftMentionsRef.current,
    );

    setDraftText(nextText);
    setDraftMentions(nextMentions);
    if (nextText.length === 0) {
      setInputHeight(DEFAULT_INPUT_HEIGHT);
    }

    const mentionTriggerIndex = findInsertedMentionTrigger(previousText, nextText);
    if (
      mentionsEnabled &&
      mentionTriggerIndex !== null &&
      !nextMentions.some(
        (mention) =>
          mentionTriggerIndex >= mention.start &&
          mentionTriggerIndex < mention.end,
      )
    ) {
      pendingMentionInsertIndexRef.current = mentionTriggerIndex;
      if (!openMentionPicker()) {
        pendingMentionInsertIndexRef.current = null;
      }
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) =>
      current.filter((attachment) => attachment.id !== id),
    );
  }

  const sendDisabled =
    disabled || sending || (draftBlocks.length === 0 && attachments.length === 0);

  return (
    <View style={styles.wrap}>
      {replyTo ? (
        <View style={styles.replyBar}>
          <Feather
            name="corner-up-left"
            size={15}
            color={theme.colors.primary}
          />
          <Text numberOfLines={1} style={styles.replyBarText}>
            {`${getEntityDisplayName(replyTo.author)}: ${buildReplyPreviewText(replyTo)}`}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="取消引用"
            onPress={onCancelReply}
            style={styles.replyBarClose}
          >
            <Feather name="x" size={16} color={theme.colors.textMuted} />
          </Pressable>
        </View>
      ) : null}

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
          <View pointerEvents="none" style={styles.textMeasureLayer}>
            <Text
              onLayout={(event) => {
                setInputHeight(
                  Math.max(
                    DEFAULT_INPUT_HEIGHT,
                    Math.min(
                      maxInputHeight,
                      Math.ceil(event.nativeEvent.layout.height),
                    ),
                  ),
                );
              }}
              style={styles.textMeasure}
            >
              {getDraftMeasurementText(draftText)}
            </Text>
          </View>
          <TextInput
            value={draftText}
            selection={selection}
            onChangeText={handleChangeText}
            onFocus={() => setMenuVisible(false)}
            onSelectionChange={(event) => {
              setSelection(event.nativeEvent.selection);
              selectionRef.current = event.nativeEvent.selection;
            }}
            onContentSizeChange={(event) => {
              setInputHeight(
                Math.max(
                  DEFAULT_INPUT_HEIGHT,
                  Math.min(
                    maxInputHeight,
                    Math.ceil(event.nativeEvent.contentSize.height),
                  ),
                ),
              );
            }}
            placeholder="发消息"
            placeholderTextColor={theme.colors.textSoft}
            multiline
            scrollEnabled={inputHeight >= maxInputHeight}
            style={[
              styles.textInput,
              {
                height: inputHeight,
                maxHeight: maxInputHeight,
              },
            ]}
            textAlignVertical="top"
            editable={!disabled && !sending}
          />
        </View>

        <RoundAction
          icon="plus"
          onPress={() => setMenuVisible((current) => !current)}
          disabled={disabled || sending}
          active={menuVisible}
        />

        <RoundAction
          icon="send"
          onPress={() => void handleSend()}
          disabled={sendDisabled}
          active={!sendDisabled}
        />
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
            label="拍照"
            onPress={() => void launchCamera()}
          />
          <MenuAction
            icon="paperclip"
            label="文件"
            onPress={() => void pickDocument()}
          />
        </View>
      ) : null}

      {sending ? (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
        </View>
      ) : null}
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
        color={active ? theme.colors.white : theme.colors.text}
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
      <View style={styles.menuIcon}>
        <Feather name={icon} size={18} color={theme.colors.text} />
      </View>
      <Text style={styles.menuLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 8,
    gap: 8,
    backgroundColor: theme.colors.background,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  replyBar: {
    minHeight: 36,
    borderRadius: 14,
    backgroundColor: theme.colors.backgroundAlt,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  replyBarText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.textMuted,
  },
  replyBarClose: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  attachmentRow: {
    gap: 10,
  },
  attachmentChip: {
    minWidth: 154,
    maxWidth: 190,
    borderRadius: 18,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 10,
    gap: 10,
  },
  attachmentThumb: {
    width: "100%",
    height: 112,
    borderRadius: 14,
    backgroundColor: theme.colors.backgroundAlt,
  },
  attachmentIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.primarySoft,
  },
  attachmentLabel: {
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.text,
    fontWeight: "600",
  },
  attachmentRemove: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(255,255,255,0.92)",
    alignItems: "center",
    justifyContent: "center",
  },
  recordingHint: {
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.primary,
    fontWeight: "700",
  },
  composerShell: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  roundAction: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  roundActionActive: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  roundActionDisabled: {
    opacity: 0.45,
  },
  roundActionPressed: {
    opacity: 0.7,
  },
  inputShell: {
    flex: 1,
    minHeight: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 5,
    justifyContent: "center",
  },
  textMeasureLayer: {
    position: "absolute",
    left: 12,
    right: 12,
    top: 5,
    opacity: 0,
  },
  textInput: {
    minHeight: DEFAULT_INPUT_HEIGHT,
    fontSize: 15,
    lineHeight: 22,
    color: theme.colors.text,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  textMeasure: {
    fontSize: 15,
    lineHeight: 22,
    color: theme.colors.text,
  },
  quickMenu: {
    flexDirection: "row",
    gap: 10,
  },
  menuAction: {
    flex: 1,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingVertical: 12,
    paddingHorizontal: 10,
    alignItems: "center",
    gap: 8,
  },
  menuIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.backgroundAlt,
  },
  menuLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.text,
  },
  loadingOverlay: {
    position: "absolute",
    top: 10,
    right: 16,
  },
});
