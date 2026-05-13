import { Modal, Pressable, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { Button } from "@/components/ui"
import { theme } from "@/theme/tokens"

export function ScanCameraPermissionSheet({
  open,
  requesting,
  errorMessage,
  onClose,
  onAuthorize,
}: {
  open: boolean
  requesting?: boolean
  errorMessage?: string | null
  onClose: () => void
  onAuthorize: () => void
}) {
  const insets = useSafeAreaInsets()

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        <View
          style={[
            styles.sheet,
            {
              paddingBottom: Math.max(insets.bottom, 18),
            },
          ]}
        >
          <View style={styles.handle} />
          <Text style={styles.title}>允许使用相机</Text>
          <Text style={styles.description}>
            需要访问你的相机，才能扫描登录二维码和联系人二维码。我们只会在你主动点击扫一扫时使用相机。
          </Text>
          {errorMessage ? (
            <Text style={styles.errorText}>{errorMessage}</Text>
          ) : null}

          <View style={styles.actions}>
            <Button
              label="拒绝"
              variant="secondary"
              onPress={onClose}
              style={styles.actionButton}
            />
            <Button
              label={requesting ? "授权中..." : "授权"}
              onPress={onAuthorize}
              disabled={requesting}
              style={styles.actionButton}
            />
          </View>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(15, 23, 42, 0.22)",
  },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: "rgba(255,255,255,0.98)",
    paddingHorizontal: 20,
    paddingTop: 12,
    gap: 14,
    boxShadow: "0 -20px 40px rgba(15, 23, 42, 0.12)",
  },
  handle: {
    alignSelf: "center",
    width: 42,
    height: 4,
    borderRadius: 999,
    backgroundColor: theme.colors.borderStrong,
    opacity: 0.75,
  },
  title: {
    fontSize: 20,
    fontWeight: "800",
    color: theme.colors.text,
  },
  description: {
    fontSize: 14,
    lineHeight: 21,
    color: theme.colors.textMuted,
  },
  errorText: {
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.danger,
  },
  actions: {
    flexDirection: "row",
    gap: 12,
  },
  actionButton: {
    flex: 1,
  },
})
