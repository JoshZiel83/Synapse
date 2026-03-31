import { CameraView, useCameraPermissions } from "expo-camera";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { parseSynapseQrPayload, type ParsedSynapseQrPayload } from "@shared";
import { Pressable, StyleSheet, Text, View } from "react-native";

import {
  Button,
  Card,
  EmptyState,
  ScreenScroll,
  SectionHeader,
} from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type { RelationshipScanResponse } from "@/types/api";

function getRelationshipHint(result: RelationshipScanResponse) {
  switch (result.outcome) {
    case "friend_request_created":
      return "好友申请已发出，等待对方处理。";
    case "friend_request_pending":
      return "你已经发过好友申请了，等待对方处理。";
    case "actor_access_request_created":
      return "已提交 Actor 访问申请，等待批准。";
    case "actor_access_pending":
      return "你已经提交过 Actor 访问申请了。";
    default:
      return "二维码已识别，但当前没有可直接打开的会话。";
  }
}

export default function UnifiedScanScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    kind?: string;
    token?: string;
    intent?: string;
  }>();
  const { workspaceId, workspaceName } = useWorkspace();
  const [permission, requestPermission] = useCameraPermissions();
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  async function handleRelationshipResult(result: RelationshipScanResponse) {
    if (
      workspaceId &&
      result.contact &&
      (result.outcome === "same_workspace_user" ||
        result.outcome === "friend_active" ||
        result.outcome === "actor_access_granted")
    ) {
      const opened = await api.openDirectConversation(workspaceId, {
        contactKind: result.contact.kind,
        contactId: result.contact.id,
      });
      if (opened.conversationId) {
        router.replace(`/chat/${opened.conversationId}`);
        return;
      }
    }

    if (result.outcome === "self_scan") {
      setError("不能扫描自己的二维码。");
      return;
    }

    setHint(getRelationshipHint(result));
  }

  async function handleRelationshipToken(token: string) {
    if (!workspaceId) {
      throw new Error("当前没有可用 workspace，无法处理联系人二维码。");
    }
    const result = await api.scanRelationshipQr(workspaceId, token);
    await handleRelationshipResult(result);
  }

  async function routeLoginToken(token: string) {
    router.replace(`/qr-login?token=${encodeURIComponent(token)}`);
  }

  async function processParsedPayload(parsed: ParsedSynapseQrPayload) {
    setLocked(true);
    setError(null);
    setHint(null);

    try {
      if (parsed.kind === "login") {
        await routeLoginToken(parsed.token);
        return;
      }

      if (parsed.kind === "relationship") {
        await handleRelationshipToken(parsed.token);
        return;
      }

      try {
        await api.resolveQrLogin(parsed.token);
        await routeLoginToken(parsed.token);
        return;
      } catch (loginError) {
        if (
          loginError instanceof ApiError &&
          loginError.status !== 400 &&
          loginError.status !== 404
        ) {
          throw loginError;
        }
      }

      await handleRelationshipToken(parsed.token);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "扫码失败，请稍后重试。",
      );
    } finally {
      setLocked(false);
    }
  }

  function handleScan(payload: { data: string }) {
    if (locked) return;

    const parsed = parseSynapseQrPayload(payload.data);
    if (!parsed) {
      setError("这个二维码不是 Synapse 的登录或联系人二维码。");
      return;
    }

    void processParsedPayload(parsed);
  }

  useEffect(() => {
    const token =
      typeof params.token === "string" ? params.token.trim() : "";
    const kind =
      typeof params.kind === "string" ? params.kind.trim().toLowerCase() : "";
    if (!token || locked) return;
    if (kind !== "login" && kind !== "relationship") return;

    void processParsedPayload({
      kind: kind as "login" | "relationship",
      token,
    });
  }, [locked, params.kind, params.token, workspaceId]);

  const hasPermission = permission?.granted;
  const intent =
    typeof params.intent === "string" ? params.intent.trim().toLowerCase() : "";

  return (
    <ScreenScroll bottomPadding={32}>
      <SectionHeader
        eyebrow="Unified Scan"
        title="扫码"
        subtitle={
          intent === "login"
            ? "同一个入口同时支持 Web 登录二维码和联系人二维码。扫描到登录请求会直接进入确认。"
            : intent === "relationship"
              ? "同一个入口同时支持联系人二维码和 Web 登录二维码。扫描到联系人二维码会按当前 workspace 自动处理。"
              : `同一个扫码入口支持 Web 登录和联系人添加。当前 workspace：${workspaceName || "未选择"}.`
        }
      />

      {!hasPermission ? (
        <EmptyState
          icon="camera"
          title="需要相机权限"
          description="允许访问相机后，才能扫描 Synapse 的登录或联系人二维码。"
          action={
            <View style={styles.permissionAction}>
              <Button
                label="授权相机"
                icon="camera"
                onPress={() => void requestPermission()}
              />
            </View>
          }
        />
      ) : (
        <Card style={styles.cameraCard}>
          <View style={styles.cameraFrame}>
            <CameraView
              style={StyleSheet.absoluteFillObject}
              facing="back"
              barcodeScannerSettings={{
                barcodeTypes: ["qr"],
              }}
              onBarcodeScanned={locked ? undefined : handleScan}
            />
            <View style={styles.frameOverlay}>
              <View style={styles.focusSquare} />
            </View>
          </View>
          <Text style={styles.cameraHint}>
            扫到 Web 登录请求会进入确认页；扫到联系人二维码会自动打开私聊或发起申请。
          </Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {hint ? <Text style={styles.hint}>{hint}</Text> : null}
          <View style={styles.actions}>
            <Pressable
              onPress={() => {
                setError(null);
                setHint(null);
              }}
              style={styles.retryLink}
            >
              <Text style={styles.retryLinkText}>继续扫描</Text>
            </Pressable>
            <Button
              label="查看申请"
              icon="inbox"
              variant="secondary"
              onPress={() => router.push("/contacts/requests")}
            />
          </View>
        </Card>
      )}
    </ScreenScroll>
  );
}

const styles = StyleSheet.create({
  permissionAction: {
    marginTop: 8,
    width: "100%",
  },
  cameraCard: {
    padding: 14,
  },
  cameraFrame: {
    width: "100%",
    aspectRatio: 3 / 4,
    borderRadius: 28,
    overflow: "hidden",
    backgroundColor: theme.colors.black,
  },
  frameOverlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.28)",
  },
  focusSquare: {
    width: "72%",
    aspectRatio: 1,
    borderRadius: 24,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.92)",
  },
  cameraHint: {
    fontSize: 14,
    lineHeight: 20,
    color: theme.colors.textMuted,
  },
  error: {
    color: theme.colors.danger,
    fontSize: 13,
  },
  hint: {
    color: theme.colors.textMuted,
    fontSize: 13,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  retryLink: {
    alignSelf: "flex-start",
  },
  retryLinkText: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.primary,
  },
});
