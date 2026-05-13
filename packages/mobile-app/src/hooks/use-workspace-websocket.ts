import { useEffect, useRef, type MutableRefObject } from "react"

import { getWebSocketUrl } from "@/lib/config"
import { useSession } from "@/providers/session-provider"
import type { ChatSocketEvent } from "@shared"

export type WorkspaceSocketSubscription =
  | {
      key: string
      topic: "inbox"
    }
  | {
      key: string
      topic: "conversation"
      conversationId: string
    }

interface UseWorkspaceWebSocketOptions {
  enabled?: boolean
  workspaceId?: string | null
  subscriptions: WorkspaceSocketSubscription[]
  onEvent?: (event: ChatSocketEvent | Record<string, unknown>) => void
  onConnected?: () => void
}

type HookSubscriber = {
  id: string
  enabled: boolean
  token?: string | null
  workspaceId?: string | null
  subscriptions: WorkspaceSocketSubscription[]
  onEventRef: MutableRefObject<
    ((event: ChatSocketEvent | Record<string, unknown>) => void) | undefined
  >
  onConnectedRef: MutableRefObject<(() => void) | undefined>
}

const hookSubscribers = new Map<string, HookSubscriber>()

let sharedSocket: WebSocket | null = null
let sharedReconnectTimer: ReturnType<typeof setTimeout> | null = null
let sharedReconnectAttempts = 0
let sharedAuthenticated = false
let sharedSentSubscriptions = new Map<string, string>()
let sharedActiveToken: string | null = null
let sharedActiveWorkspaceId: string | null = null

function getActiveSubscribers() {
  return [...hookSubscribers.values()].filter(
    (subscriber) =>
      subscriber.enabled && subscriber.token && subscriber.workspaceId
  )
}

function getSharedToken() {
  return getActiveSubscribers()[0]?.token || null
}

function getSharedWorkspaceId() {
  return getActiveSubscribers()[0]?.workspaceId || null
}

function getDesiredSubscriptions() {
  const subscriptions = new Map<string, string>()
  for (const subscriber of getActiveSubscribers()) {
    for (const subscription of subscriber.subscriptions) {
      subscriptions.set(subscription.key, JSON.stringify(subscription))
    }
  }
  return subscriptions
}

function dispatchEvent(event: ChatSocketEvent | Record<string, unknown>) {
  for (const subscriber of getActiveSubscribers()) {
    subscriber.onEventRef.current?.(event)
  }
}

function dispatchConnected() {
  for (const subscriber of getActiveSubscribers()) {
    subscriber.onConnectedRef.current?.()
  }
}

function clearSharedReconnectTimer() {
  if (sharedReconnectTimer) {
    clearTimeout(sharedReconnectTimer)
    sharedReconnectTimer = null
  }
}

function closeSharedSocket() {
  clearSharedReconnectTimer()
  sharedAuthenticated = false
  sharedSentSubscriptions.clear()
  if (sharedSocket) {
    sharedSocket.onopen = null
    sharedSocket.onmessage = null
    sharedSocket.onclose = null
    sharedSocket.onerror = null
    sharedSocket.close()
    sharedSocket = null
  }
}

function syncSharedSubscriptions() {
  if (
    !sharedSocket ||
    sharedSocket.readyState !== WebSocket.OPEN ||
    !sharedAuthenticated
  ) {
    return
  }

  const desired = getDesiredSubscriptions()
  for (const [key] of sharedSentSubscriptions) {
    if (desired.has(key)) continue
    sharedSocket.send(
      JSON.stringify({
        type: "unsubscribe",
        key,
      })
    )
    sharedSentSubscriptions.delete(key)
  }

  for (const [key, serialized] of desired) {
    if (sharedSentSubscriptions.get(key) === serialized) continue
    sharedSocket.send(
      JSON.stringify({
        type: "subscribe",
        ...JSON.parse(serialized),
      })
    )
    sharedSentSubscriptions.set(key, serialized)
  }
}

function ensureSharedSocket() {
  const token = getSharedToken()
  const workspaceId = getSharedWorkspaceId()
  if (!token) {
    sharedActiveToken = null
    sharedActiveWorkspaceId = null
    closeSharedSocket()
    return
  }
  if (!workspaceId) {
    sharedActiveWorkspaceId = null
    closeSharedSocket()
    return
  }

  if (sharedActiveToken && sharedActiveToken !== token) {
    sharedActiveToken = token
    closeSharedSocket()
  }
  if (sharedActiveWorkspaceId && sharedActiveWorkspaceId !== workspaceId) {
    sharedActiveWorkspaceId = workspaceId
    closeSharedSocket()
  }

  if (sharedSocket) {
    syncSharedSubscriptions()
    return
  }

  sharedActiveToken = token
  sharedActiveWorkspaceId = workspaceId
  const socket = new WebSocket(getWebSocketUrl())
  sharedSocket = socket

  socket.onopen = () => {
    sharedReconnectAttempts = 0
    socket.send(
      JSON.stringify({
        type: "auth",
        token,
        workspaceId,
      })
    )
  }

  socket.onmessage = (event) => {
    try {
      const parsed = JSON.parse(event.data) as Record<string, unknown>
      const rawType = typeof parsed.type === "string" ? parsed.type : ""
      const normalizedType =
        rawType === "auth_ok"
          ? "auth.ok"
          : rawType === "auth_error"
            ? "auth.error"
            : rawType === "server_shutdown"
              ? "server.shutdown"
              : rawType

      const normalized = {
        ...parsed,
        type: normalizedType,
      } as ChatSocketEvent | Record<string, unknown>

      if (normalizedType === "auth.ok") {
        sharedAuthenticated = true
        syncSharedSubscriptions()
        dispatchConnected()
        return
      }

      if (normalizedType === "auth.error") {
        closeSharedSocket()
        return
      }

      if (normalizedType === "ping") {
        socket.send(JSON.stringify({ type: "pong" }))
        return
      }

      dispatchEvent(normalized)
    } catch {
      // Ignore malformed websocket frames.
    }
  }

  socket.onclose = () => {
    sharedAuthenticated = false
    sharedSentSubscriptions.clear()
    sharedSocket = null

    if (!getSharedToken()) {
      return
    }

    sharedReconnectAttempts += 1
    const delay = Math.min(5000, 1000 * sharedReconnectAttempts)
    clearSharedReconnectTimer()
    sharedReconnectTimer = setTimeout(() => {
      sharedReconnectTimer = null
      ensureSharedSocket()
    }, delay)
  }

  socket.onerror = () => {
    // Let onclose drive reconnect.
  }
}

function createSubscriberId() {
  return `ws-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function useWorkspaceWebSocket({
  enabled = true,
  workspaceId,
  subscriptions,
  onEvent,
  onConnected,
}: UseWorkspaceWebSocketOptions) {
  const { token } = useSession()
  const subscriberIdRef = useRef<string>(createSubscriberId())
  const onEventRef = useRef(onEvent)
  const onConnectedRef = useRef(onConnected)
  const subscriptionsRef = useRef(subscriptions)
  const subscriptionSignature = JSON.stringify(subscriptions)

  onEventRef.current = onEvent
  onConnectedRef.current = onConnected
  subscriptionsRef.current = subscriptions

  useEffect(() => {
    const subscriberId = subscriberIdRef.current
    hookSubscribers.set(subscriberId, {
      id: subscriberId,
      enabled,
      token,
      workspaceId,
      subscriptions: subscriptionsRef.current,
      onEventRef,
      onConnectedRef,
    })
    ensureSharedSocket()
    syncSharedSubscriptions()

    return () => {
      hookSubscribers.delete(subscriberId)
      syncSharedSubscriptions()
      ensureSharedSocket()
    }
  }, [])

  useEffect(() => {
    const subscriberId = subscriberIdRef.current
    const subscriber = hookSubscribers.get(subscriberId)
    if (!subscriber) {
      return
    }

    subscriber.enabled = enabled
    subscriber.token = token
    subscriber.workspaceId = workspaceId
    subscriber.subscriptions = subscriptionsRef.current
    ensureSharedSocket()
    syncSharedSubscriptions()
  }, [enabled, subscriptionSignature, token, workspaceId])
}
