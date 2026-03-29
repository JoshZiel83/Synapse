import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button, Card, EmptyState, ScreenScroll, SectionHeader } from '@/components/ui';
import { extractQrLoginToken } from '@/lib/qr-login';
import { theme } from '@/theme/tokens';

export default function ScanLoginScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleScan(payload: { data: string }) {
    if (locked) return;

    const token = extractQrLoginToken(payload.data);
    if (!token) {
      setError('这个二维码不是 Synapse 的 Web 登录请求。');
      return;
    }

    setLocked(true);
    router.replace(`/qr-login?token=${encodeURIComponent(token)}`);
  }

  const hasPermission = permission?.granted;

  return (
    <ScreenScroll bottomPadding={32}>
      <SectionHeader
        eyebrow="Secure Bridge"
        title="扫码登录 Web"
        subtitle="用手机扫描桌面端展示的二维码，确认后可直接批准浏览器登录。"
      />

      {!hasPermission ? (
        <EmptyState
          icon="camera"
          title="需要相机权限"
          description="允许访问相机后，才能扫描桌面端的登录二维码。"
          action={
            <View style={styles.permissionAction}>
              <Button label="授权相机" icon="camera" onPress={() => void requestPermission()} />
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
                barcodeTypes: ['qr'],
              }}
              onBarcodeScanned={locked ? undefined : handleScan}
            />
            <View style={styles.frameOverlay}>
              <View style={styles.focusSquare} />
            </View>
          </View>
          <Text style={styles.cameraHint}>
            将二维码放入取景框中间。识别成功后会自动跳转到确认页。
          </Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable onPress={() => setError(null)} style={styles.retryLink}>
            <Text style={styles.retryLinkText}>重新扫描</Text>
          </Pressable>
        </Card>
      )}
    </ScreenScroll>
  );
}

const styles = StyleSheet.create({
  permissionAction: {
    marginTop: 8,
    width: '100%',
  },
  cameraCard: {
    padding: 14,
  },
  cameraFrame: {
    width: '100%',
    aspectRatio: 3 / 4,
    borderRadius: 28,
    overflow: 'hidden',
    backgroundColor: theme.colors.black,
  },
  frameOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.28)',
  },
  focusSquare: {
    width: '72%',
    aspectRatio: 1,
    borderRadius: 24,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.92)',
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
  retryLink: {
    alignSelf: 'flex-start',
  },
  retryLinkText: {
    fontSize: 13,
    fontWeight: '700',
    color: theme.colors.primary,
  },
});
