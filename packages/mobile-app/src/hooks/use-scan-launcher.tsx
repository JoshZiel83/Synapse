import { Camera } from "expo-camera"
import { useRouter } from "expo-router"
import { Platform } from "react-native"
import { useState } from "react"

import { ScanCameraPermissionSheet } from "@/components/scan-camera-permission-sheet"

export function useScanLauncher(
  intent: "relationship" | "login" = "relationship"
) {
  const router = useRouter()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  function pushToScan() {
    router.push(`/scan?intent=${intent}`)
  }

  async function openScan() {
    const permission = await Camera.getCameraPermissionsAsync()

    if (permission.granted) {
      setErrorMessage(null)
      pushToScan()
      return
    }

    setErrorMessage(null)
    setSheetOpen(true)
  }

  async function authorizeAndOpen() {
    if (requesting) return

    setRequesting(true)
    try {
      const permission = await Camera.requestCameraPermissionsAsync()

      if (permission.granted) {
        setErrorMessage(null)
        setSheetOpen(false)
        pushToScan()
        return
      }

      setErrorMessage(
        Platform.OS === "web"
          ? "浏览器没有授予相机权限。请检查地址栏里的相机权限设置后重试。"
          : "系统没有授予相机权限，请允许后再试一次。"
      )
    } finally {
      setRequesting(false)
    }
  }

  return {
    openScan,
    permissionSheet: (
      <ScanCameraPermissionSheet
        open={sheetOpen}
        requesting={requesting}
        errorMessage={errorMessage}
        onClose={() => {
          setSheetOpen(false)
          setErrorMessage(null)
        }}
        onAuthorize={() => void authorizeAndOpen()}
      />
    ),
  }
}
