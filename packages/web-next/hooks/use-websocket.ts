"use client"

import { useEffect, useRef, useState } from "react"
import type { ChatSocketEvent } from "@synapse/shared"
import {
  createChatSocket,
  type ChatSocketHandle,
  type ChatSocketSubscription,
} from "@synapse/shared/chat-socket"

export type WebSocketSubscription = ChatSocketSubscription

interface UseWebSocketOptions {
  enabled?: boolean
  workspaceId?: string | null
  subscriptions: WebSocketSubscription[]
  onEvent?: (event: ChatSocketEvent | Record<string, unknown>) => void
  onConnected?: () => void
}

function resolveWebSocketUrl(configuredUrl?: string) {
  const fallbackBase =
    typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.host}`
      : "http://localhost:3001"

  if (configuredUrl?.trim()) {
    const parsed = new URL(configuredUrl, fallbackBase)
    if (parsed.protocol === "http:") parsed.protocol = "ws:"
    if (parsed.protocol === "https:") parsed.protocol = "wss:"
    if (!parsed.pathname || parsed.pathname === "/") {
      parsed.pathname = "/ws"
    }
    return parsed.toString()
  }

  if (typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
    return `${proto}//${window.location.host}/ws`
  }

  return "ws://localhost:3001/ws"
}

/**
 * Per-component chat WebSocket hook (web). Cookie-authenticated, so the auth
 * frame carries only the workspaceId (no token). All connection/reconnect/ping/
 * subscription-diff logic lives in the shared `createChatSocket` transport core;
 * this hook only wires React lifecycle + the latest callbacks/subscriptions into
 * it and surfaces `{ connected, connecting }`.
 */
export function useWebSocket({
  enabled = true,
  workspaceId,
  subscriptions,
  onEvent,
  onConnected,
}: UseWebSocketOptions) {
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)

  const onEventRef = useRef(onEvent)
  const onConnectedRef = useRef(onConnected)
  const subscriptionsRef = useRef<WebSocketSubscription[]>(subscriptions)
  const enabledRef = useRef(enabled)
  const workspaceIdRef = useRef<string | null | undefined>(workspaceId)
  const handleRef = useRef<ChatSocketHandle | null>(null)

  onEventRef.current = onEvent
  onConnectedRef.current = onConnected
  subscriptionsRef.current = subscriptions
  enabledRef.current = enabled
  workspaceIdRef.current = workspaceId

  // Create the transport once.
  if (!handleRef.current) {
    handleRef.current = createChatSocket({
      connect: (url) => new WebSocket(url),
      resolveUrl: () => resolveWebSocketUrl(process.env.NEXT_PUBLIC_WS_URL),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
      getAuth: () =>
        enabledRef.current && workspaceIdRef.current
          ? { workspaceId: workspaceIdRef.current }
          : null,
      getSubscriptions: () => subscriptionsRef.current,
      onEvent: (event) =>
        onEventRef.current?.(
          event as ChatSocketEvent | Record<string, unknown>
        ),
      onConnected: () => onConnectedRef.current?.(),
      onStateChange: (state) => {
        setConnected(state === "open")
        setConnecting(state === "connecting")
      },
    })
  }

  // Start/stop with mount.
  useEffect(() => {
    const handle = handleRef.current!
    handle.start()
    return () => handle.stop()
  }, [])

  // Reconcile whenever inputs change.
  const subscriptionSignature = JSON.stringify(subscriptions)
  useEffect(() => {
    handleRef.current?.sync()
  }, [enabled, workspaceId, subscriptionSignature])

  return { connected, connecting }
}
