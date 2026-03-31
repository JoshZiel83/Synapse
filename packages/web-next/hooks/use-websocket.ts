"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { ChatSocketEvent } from "@synapse/shared"

export type WebSocketSubscription =
  | {
      key: string
      topic: "inbox"
    }
  | {
      key: string
      topic: "conversation"
      conversationId: string
    }

interface UseWebSocketOptions {
  enabled?: boolean
  workspaceId?: string | null
  subscriptions: WebSocketSubscription[]
  onEvent?: (event: ChatSocketEvent | Record<string, unknown>) => void
  onConnected?: () => void
}

export function useWebSocket({
  enabled = true,
  workspaceId,
  subscriptions,
  onEvent,
  onConnected,
}: UseWebSocketOptions) {
  const ws = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const onEventRef = useRef(onEvent)
  const onConnectedRef = useRef(onConnected)
  const reconnectAttempts = useRef(0)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pingCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const authenticatedRef = useRef(false)
  const subscriptionsRef = useRef<WebSocketSubscription[]>(subscriptions)
  const sentSubscriptionsRef = useRef(new Map<string, string>())
  const maxReconnectAttempts = 20
  const mountedRef = useRef(true)

  const resolveWebSocketUrl = useCallback((configuredUrl?: string) => {
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
  }, [])

  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])

  useEffect(() => {
    onConnectedRef.current = onConnected
  }, [onConnected])

  const cleanup = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current)
      reconnectTimer.current = null
    }
    if (pingCheckTimer.current) {
      clearTimeout(pingCheckTimer.current)
      pingCheckTimer.current = null
    }
    if (ws.current) {
      ws.current.onopen = null
      ws.current.onmessage = null
      ws.current.onclose = null
      ws.current.onerror = null
      ws.current.close()
      ws.current = null
    }
    authenticatedRef.current = false
    sentSubscriptionsRef.current.clear()
  }, [])

  const resetPingWatchdog = useCallback(() => {
    if (pingCheckTimer.current) {
      clearTimeout(pingCheckTimer.current)
    }
    pingCheckTimer.current = setTimeout(() => {
      ws.current?.close()
    }, 45000)
  }, [])

  const syncSubscriptions = useCallback(() => {
    const socket = ws.current
    if (!socket || socket.readyState !== WebSocket.OPEN || !authenticatedRef.current) {
      return
    }

    const desired = new Map(
      subscriptionsRef.current.map((subscription) => [
        subscription.key,
        JSON.stringify(subscription),
      ])
    )

    for (const [key] of sentSubscriptionsRef.current) {
      if (desired.has(key)) continue
      socket.send(
        JSON.stringify({
          type: "unsubscribe",
          key,
        })
      )
      sentSubscriptionsRef.current.delete(key)
    }

    for (const subscription of subscriptionsRef.current) {
      const serialized = JSON.stringify(subscription)
      if (sentSubscriptionsRef.current.get(subscription.key) === serialized) {
        continue
      }
      socket.send(
        JSON.stringify({
          type: "subscribe",
          ...subscription,
        })
      )
      sentSubscriptionsRef.current.set(subscription.key, serialized)
    }
  }, [])

  useEffect(() => {
    subscriptionsRef.current = subscriptions
    syncSubscriptions()
  }, [subscriptions, syncSubscriptions])

  const connect = useCallback(() => {
    if (!mountedRef.current) return

    cleanup()
    setConnecting(true)

    const url = resolveWebSocketUrl(process.env.NEXT_PUBLIC_WS_URL)
    const socket = new WebSocket(url)
    ws.current = socket

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "auth",
          ...(workspaceId ? { workspaceId } : {}),
        })
      )
    }

    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as Record<string, unknown>
        const rawType = typeof msg.type === "string" ? msg.type : ""
        const normalizedType =
          rawType === "auth_ok"
            ? "auth.ok"
            : rawType === "auth_error"
              ? "auth.error"
              : rawType === "server_shutdown"
                ? "server.shutdown"
                : rawType
        const normalizedMessage = {
          ...msg,
          type: normalizedType,
        } as ChatSocketEvent | Record<string, unknown>

        if (normalizedType === "auth.ok") {
          authenticatedRef.current = true
          setConnected(true)
          setConnecting(false)
          reconnectAttempts.current = 0
          syncSubscriptions()
          onConnectedRef.current?.()
          resetPingWatchdog()
          return
        }

        if (normalizedType === "auth.error") {
          authenticatedRef.current = false
          setConnecting(false)
          reconnectAttempts.current = maxReconnectAttempts
          socket.close()
          return
        }

        if (normalizedType === "ping") {
          socket.send(JSON.stringify({ type: "pong" }))
          resetPingWatchdog()
          return
        }

        onEventRef.current?.(normalizedMessage)
      } catch {
        // Ignore malformed websocket frames.
      }
    }

    socket.onclose = () => {
      authenticatedRef.current = false
      sentSubscriptionsRef.current.clear()
      setConnected(false)
      if (!mountedRef.current) {
        return
      }

      reconnectAttempts.current += 1
      const delay = Math.min(5000, 1000 * reconnectAttempts.current)
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null
        connect()
      }, delay)
    }

    socket.onerror = () => {
      // Let the close handler schedule reconnects.
    }
  }, [
    cleanup,
    maxReconnectAttempts,
    resetPingWatchdog,
    resolveWebSocketUrl,
    syncSubscriptions,
    workspaceId,
  ])

  useEffect(() => {
    mountedRef.current = true
    if (!enabled || !workspaceId) {
      setConnected(false)
      setConnecting(false)
      cleanup()
      return () => {
        mountedRef.current = false
        cleanup()
      }
    }
    connect()

    return () => {
      mountedRef.current = false
      cleanup()
    }
  }, [cleanup, connect, enabled, workspaceId])

  return { connected, connecting }
}
