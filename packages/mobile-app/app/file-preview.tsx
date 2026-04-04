import Feather from "@expo/vector-icons/Feather";
import { Image } from "expo-image";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system/legacy";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";

import FilePreviewDom from "@/components/file-preview-dom";
import { ScreenView } from "@/components/ui";
import {
  isPdfMimeType,
  isTextPreviewMimeType,
  sanitizeDownloadName,
} from "@/lib/chat-rich-content";
import { buildAuthenticatedSource, reportApiUnauthorized } from "@/lib/api";
import { useAuthenticatedMediaSource } from "@/hooks/use-authenticated-media-source";
import { useSession } from "@/providers/session-provider";
import { theme } from "@/theme/tokens";

type PreviewSource = "local" | "remote";
type PreviewCategory = "image" | "video" | "audio" | "document";

function AudioPreview({
  source,
  fileName,
}: {
  source: { uri: string; headers?: Record<string, string> };
  fileName: string;
}) {
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
    <View style={styles.audioCard}>
      <Text style={styles.audioTitle}>{fileName}</Text>
      <Pressable onPress={() => void togglePlayback()} style={styles.audioButton}>
        <Feather
          name={status.playing ? "pause" : "play"}
          size={20}
          color={theme.colors.white}
        />
        <Text style={styles.audioButtonLabel}>
          {status.playing ? "暂停" : "播放"}
        </Text>
      </Pressable>
    </View>
  );
}

export default function FilePreviewScreen() {
  const router = useRouter();
  const { token } = useSession();
  const params = useLocalSearchParams<{
    uri?: string;
    mimeType?: string;
    name?: string;
    category?: PreviewCategory;
    source?: PreviewSource;
  }>();
  const [downloading, setDownloading] = useState(false);

  const uri = params.uri || "";
  const mimeType = params.mimeType || "application/octet-stream";
  const fileName = params.name || "文件";
  const category = (params.category || "document") as PreviewCategory;
  const sourceType = (params.source || "remote") as PreviewSource;
  const remoteSource = useAuthenticatedMediaSource(
    sourceType === "remote" && (category === "image" || category === "video")
      ? uri
      : undefined,
  );
  const remoteAudioSource = useMemo(
    () =>
      sourceType === "remote" && category === "audio"
        ? buildAuthenticatedSource(uri)
        : null,
    [category, sourceType, uri],
  );
  const localSource = useMemo(
    () => (sourceType === "local" ? { uri } : null),
    [sourceType, uri],
  );
  const mediaSource =
    sourceType === "remote"
      ? category === "audio"
        ? remoteAudioSource
        : remoteSource
      : localSource;

  const isTextLike = isTextPreviewMimeType(mimeType);
  const usesDomPreview =
    category === "document" || isTextLike || isPdfMimeType(mimeType);

  async function handleDownload() {
    if (!uri || downloading) {
      return;
    }

    setDownloading(true);
    try {
      if (Platform.OS === "web") {
        const source =
          sourceType === "remote"
            ? buildAuthenticatedSource(uri)
            : { uri };
        const response = await fetch(source.uri, {
          headers: sourceType === "remote" ? source.headers : undefined,
        });

        if (response.status === 401) {
          reportApiUnauthorized(401);
          return;
        }

        if (!response.ok) {
          throw new Error(`下载失败 (${response.status})`);
        }

        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = sanitizeDownloadName(fileName);
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
        return;
      }

      if (sourceType === "local") {
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(uri);
        } else {
          Alert.alert("当前设备不支持导出该文件。");
        }
        return;
      }

      const targetPath = `${FileSystem.cacheDirectory ?? ""}${Date.now()}-${sanitizeDownloadName(fileName)}`;
      const source = buildAuthenticatedSource(uri);
      const result = await FileSystem.downloadAsync(source.uri, targetPath, {
        headers: source.headers,
      });

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(result.uri);
      } else {
        Alert.alert("文件已下载", result.uri);
      }
    } catch (error) {
      Alert.alert(
        "下载失败",
        error instanceof Error ? error.message : "请稍后重试",
      );
    } finally {
      setDownloading(false);
    }
  }

  return (
    <ScreenView style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.headerAction}>
          <Feather name="chevron-left" size={20} color={theme.colors.text} />
        </Pressable>
        <View style={styles.headerText}>
          <Text numberOfLines={1} style={styles.title}>
            {fileName}
          </Text>
          <Text numberOfLines={1} style={styles.subtitle}>
            {mimeType}
          </Text>
        </View>
        <Pressable
          onPress={() => void handleDownload()}
          style={styles.headerAction}
        >
          {downloading ? (
            <ActivityIndicator size="small" color={theme.colors.text} />
          ) : (
            <Feather name="download" size={18} color={theme.colors.text} />
          )}
        </Pressable>
      </View>

      <View style={styles.content}>
        {category === "image" ? (
          mediaSource ? (
            <Image
              source={mediaSource}
              style={styles.image}
              contentFit="contain"
            />
          ) : (
            <View style={styles.centerState}>
              <ActivityIndicator color={theme.colors.primary} />
            </View>
          )
        ) : null}

        {category === "video" ? (
          mediaSource ? (
            <VideoPreview source={mediaSource} />
          ) : (
            <View style={styles.centerState}>
              <ActivityIndicator color={theme.colors.primary} />
            </View>
          )
        ) : null}

        {usesDomPreview ? (
          <FilePreviewDom
            uri={uri}
            mimeType={mimeType}
            fileName={fileName}
            token={sourceType === "remote" ? token : null}
            source={sourceType}
            dom={{
              style: {
                flex: 1,
                width: "100%",
                backgroundColor: "transparent",
              },
            }}
          />
        ) : null}

        {category === "audio" && !usesDomPreview && mediaSource ? (
          <View style={styles.centerState}>
            <AudioPreview source={mediaSource} fileName={fileName} />
          </View>
        ) : null}
      </View>
    </ScreenView>
  );
}

function VideoPreview({
  source,
}: {
  source: { uri: string; headers?: Record<string, string> };
}) {
  const player = useVideoPlayer(source);

  return (
    <View style={styles.videoShell}>
      <VideoView
        player={player}
        style={styles.video}
        allowsFullscreen
        nativeControls
        contentFit="contain"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  headerAction: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 16,
    fontWeight: "700",
    color: theme.colors.text,
  },
  subtitle: {
    marginTop: 2,
    fontSize: 12,
    color: theme.colors.textMuted,
  },
  content: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  image: {
    flex: 1,
    width: "100%",
    backgroundColor: theme.colors.black,
  },
  videoShell: {
    flex: 1,
    backgroundColor: theme.colors.black,
  },
  video: {
    flex: 1,
    width: "100%",
    backgroundColor: theme.colors.black,
  },
  audioCard: {
    width: "100%",
    maxWidth: 320,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: 20,
    gap: 16,
    alignItems: "center",
  },
  audioTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: theme.colors.text,
    textAlign: "center",
  },
  audioButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 12,
    backgroundColor: theme.colors.primary,
  },
  audioButtonLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: theme.colors.white,
  },
});
