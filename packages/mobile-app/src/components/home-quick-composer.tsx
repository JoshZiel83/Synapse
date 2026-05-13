import Feather from "@expo/vector-icons/Feather"
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio"
import { useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"

import { Avatar } from "@/components/ui"
import { startMockRealtimeTranscriptionSession } from "@/lib/mock-realtime-transcription"
import { theme } from "@/theme/tokens"
import type { Actor } from "@shared"

type MockSessionHandle = ReturnType<
  typeof startMockRealtimeTranscriptionSession
>

export function HomeQuickComposer({
  actor,
  sending,
  disabled,
  onPressSelectActor,
  onSend,
}: {
  actor: Actor | null
  sending?: boolean
  disabled?: boolean
  onPressSelectActor: () => void
  onSend: (draft: string) => Promise<void>
}) {
  const [draft, setDraft] = useState("")
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  })
  const recorderState = useAudioRecorderState(recorder, 120)
  const transcriptionSessionRef = useRef<MockSessionHandle | null>(null)

  useEffect(() => {
    return () => {
      transcriptionSessionRef.current?.stop()
      if (recorderState.isRecording) {
        void recorder.stop().catch(() => undefined)
      }
    }
  }, [recorder, recorderState.isRecording])

  const hasText = draft.trim().length > 0

  async function appendMockTranscript() {
    transcriptionSessionRef.current?.stop()
    transcriptionSessionRef.current = startMockRealtimeTranscriptionSession({
      onChunk: (chunk) => {
        setDraft((current) => {
          const next = current.trim()
          return next
            ? `${next}${next.endsWith(" ") ? "" : " "}${chunk}`
            : chunk
        })
      },
    })
  }

  async function startVoiceInput() {
    if (disabled || sending) return

    const permission = await requestRecordingPermissionsAsync()
    if (!permission.granted) {
      Alert.alert("无法录音", "请先授权麦克风权限。")
      return
    }

    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      interruptionMode: "duckOthers",
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    })

    await recorder.prepareToRecordAsync()
    recorder.record()
    await appendMockTranscript()
  }

  async function stopVoiceInput() {
    transcriptionSessionRef.current?.stop()
    transcriptionSessionRef.current = null

    if (recorderState.isRecording) {
      await recorder.stop().catch(() => undefined)
    }

    await setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      interruptionMode: "duckOthers",
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    }).catch(() => undefined)
  }

  async function handleSend() {
    const trimmed = draft.trim()
    if (!trimmed || !actor || disabled || sending) return
    await onSend(trimmed)
    setDraft("")
  }

  return (
    <View style={styles.section}>
      <View style={styles.inputRow}>
        <Pressable
          onPress={onPressSelectActor}
          style={({ pressed }) => [
            styles.actorTrigger,
            pressed && styles.actorTriggerPressed,
          ]}
        >
          <View style={styles.actorAvatarWrap}>
            <Avatar
              name={actor?.definition.name || "?"}
              uri={actor?.avatarUrl}
              icon="cpu"
              size={42}
            />
            <View style={styles.actorSwitchBadge}>
              <Feather name="repeat" size={10} color={theme.colors.white} />
            </View>
          </View>
        </Pressable>

        <View style={styles.inputShell}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={
              actor ? `给 ${actor.definition.name} 发消息` : "先选择一个角色"
            }
            placeholderTextColor={theme.colors.textSoft}
            multiline
            style={styles.input}
            editable={!disabled && !sending && Boolean(actor)}
            textAlignVertical="top"
          />
        </View>
      </View>

      <View style={styles.actionRow}>
        {hasText ? (
          <>
            <Pressable
              onLongPress={() => void startVoiceInput()}
              onPressOut={() => void stopVoiceInput()}
              delayLongPress={180}
              disabled={disabled || sending || !actor}
              style={({ pressed }) => [
                styles.recordButton,
                recorderState.isRecording && styles.recordButtonActive,
                (disabled || sending || !actor) && styles.actionDisabled,
                pressed &&
                  !(disabled || sending || !actor) &&
                  styles.actionPressed,
              ]}
            >
              {recorderState.isRecording ? (
                <VoiceWave
                  color={theme.colors.white}
                  metering={recorderState.metering}
                />
              ) : (
                <Feather name="mic" size={18} color={theme.colors.primary} />
              )}
            </Pressable>

            <Pressable
              onPress={() => void handleSend()}
              disabled={disabled || sending || !actor}
              style={({ pressed }) => [
                styles.sendButton,
                (disabled || sending || !actor) && styles.actionDisabled,
                pressed &&
                  !(disabled || sending || !actor) &&
                  styles.actionPressed,
              ]}
            >
              {sending ? (
                <ActivityIndicator color={theme.colors.white} />
              ) : (
                <>
                  <Feather name="send" size={16} color={theme.colors.white} />
                  <Text style={styles.sendButtonText}>发送</Text>
                </>
              )}
            </Pressable>
          </>
        ) : (
          <Pressable
            onLongPress={() => void startVoiceInput()}
            onPressOut={() => void stopVoiceInput()}
            delayLongPress={180}
            disabled={disabled || sending || !actor}
            style={({ pressed }) => [
              styles.voiceButton,
              recorderState.isRecording && styles.voiceButtonActive,
              (disabled || sending || !actor) && styles.actionDisabled,
              pressed &&
                !(disabled || sending || !actor) &&
                styles.actionPressed,
            ]}
          >
            {recorderState.isRecording ? (
              <VoiceWave
                color={theme.colors.white}
                metering={recorderState.metering}
              />
            ) : (
              <Feather name="mic" size={18} color={theme.colors.primary} />
            )}
            <Text
              style={[
                styles.voiceButtonText,
                recorderState.isRecording && styles.voiceButtonTextActive,
              ]}
            >
              {recorderState.isRecording ? "松开结束语音输入" : "长按语音输入"}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  )
}

function normalizeMetering(metering?: number) {
  if (typeof metering !== "number" || Number.isNaN(metering)) {
    return 0.18
  }

  const clamped = Math.max(-60, Math.min(0, metering))
  return (clamped + 60) / 60
}

function VoiceWave({ color, metering }: { color: string; metering?: number }) {
  const level = normalizeMetering(metering)
  const scales = [
    0.45 + level * 0.9,
    0.35 + level * 0.6,
    0.55 + level * 1.15,
    0.4 + level * 0.75,
  ]

  return (
    <View style={styles.waveRow}>
      {scales.map((scale, index) => (
        <View
          key={index}
          style={[
            styles.waveBar,
            {
              backgroundColor: color,
              transform: [{ scaleY: scale }],
            },
          ]}
        />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  section: {
    gap: 12,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  actorTrigger: {
    paddingTop: 4,
  },
  actorTriggerPressed: {
    opacity: 0.7,
  },
  actorAvatarWrap: {
    position: "relative",
    width: 42,
    height: 42,
  },
  actorSwitchBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: theme.colors.background,
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  inputShell: {
    flex: 1,
    minHeight: 76,
    borderRadius: 22,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 6,
  },
  input: {
    minHeight: 52,
    maxHeight: 140,
    fontSize: 16,
    lineHeight: 22,
    color: theme.colors.text,
  },
  waveRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    height: 18,
  },
  waveBar: {
    width: 3,
    height: 16,
    borderRadius: 999,
    transformOrigin: "center bottom",
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: 54,
  },
  recordButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.primarySoft,
  },
  recordButtonActive: {
    backgroundColor: theme.colors.primary,
  },
  sendButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 22,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: theme.colors.primary,
  },
  sendButtonText: {
    fontSize: 15,
    fontWeight: "700",
    color: theme.colors.white,
  },
  voiceButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 22,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: theme.colors.primarySoft,
  },
  voiceButtonActive: {
    backgroundColor: theme.colors.primary,
  },
  voiceButtonText: {
    fontSize: 15,
    fontWeight: "700",
    color: theme.colors.primary,
  },
  voiceButtonTextActive: {
    color: theme.colors.white,
  },
  actionDisabled: {
    opacity: 0.45,
  },
  actionPressed: {
    transform: [{ scale: 0.985 }],
  },
})
