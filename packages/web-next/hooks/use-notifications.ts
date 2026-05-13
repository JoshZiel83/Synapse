"use client"
import { useEffect, useRef, useCallback } from "react"

/**
 * Manages browser Notification API for the chat page.
 * - Only activates on secure contexts (HTTPS / localhost)
 * - Requests permission on mount
 * - Sends a notification when a new assistant message arrives while the page is hidden
 */
export function useNotifications() {
  const permissionRef = useRef<NotificationPermission>("default")

  // Request permission on mount (secure context only)
  useEffect(() => {
    if (typeof window === "undefined") return
    if (!window.isSecureContext) return
    if (!("Notification" in window)) return

    permissionRef.current = Notification.permission

    if (Notification.permission === "default") {
      Notification.requestPermission().then((perm) => {
        permissionRef.current = perm
      })
    }
  }, [])

  const notify = useCallback((title: string, body: string, tag?: string) => {
    if (typeof window === "undefined") return
    if (!window.isSecureContext) return
    if (!("Notification" in window)) return
    if (permissionRef.current !== "granted") return
    // Only notify when page is hidden
    if (document.visibilityState !== "hidden") return

    const n = new Notification(title, {
      body: body.length > 120 ? body.substring(0, 120) + "..." : body,
      tag: tag || "synapse-chat", // same tag = replace previous
      icon: "/favicon.ico",
    })

    // Click → focus the window
    n.onclick = () => {
      window.focus()
      n.close()
    }
  }, [])

  return { notify }
}
