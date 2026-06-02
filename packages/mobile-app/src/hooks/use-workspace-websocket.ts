import { useEffect, useRef, type MutableRefObject } from "react"

import { getWebSocketUrl } from "@/lib/config"
import { useSession } from "@/providers/session-provider"
import type { ChatSocketEvent } from "@shared"
import {
  createChatSocket,
  type ChatSocketHandle,
  type ChatSocketSubscription,
} from "@shared/chat-socket"

export type WorkspaceSocketSubscription = ChatSocketSubscription

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

// Module-level multiplex: all hook instances share ONE socket. The connection
// state machine itself (auth handshake, ping watchdog, reconnect backoff,
// subscription diffing) lives in the shared createChatSocket transport core; this
// module only aggregates subscribers and feeds the core its auth/subscriptions.
const hookSubscribers = new Map<string, HookSubscriber>()

function getActiveSubscribers() {
  return [...hookSubscribers.values()].filter(
    (subscriber) =>
      subscriber.enabled && subscriber.token && subscriber.workspaceId
  )
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

let sharedHandle: ChatSocketHandle | null = null

function getSharedHandle(): ChatSocketHandle {
  if (sharedHandle) return sharedHandle
  sharedHandle = createChatSocket({
    connect: (url) => new WebSocket(url),
    resolveUrl: () => getWebSocketUrl(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    getAuth: () => {
      const active = getActiveSubscribers()[0]
      if (!active) return null
      return { token: active.token, workspaceId: active.workspaceId }
    },
    getSubscriptions: () => {
      // Aggregate (dedupe by key) across all active subscribers.
      const byKey = new Map<string, WorkspaceSocketSubscription>()
      for (const subscriber of getActiveSubscribers()) {
        for (const subscription of subscriber.subscriptions) {
          byKey.set(subscription.key, subscription)
        }
      }
      return [...byKey.values()]
    },
    onEvent: (event) =>
      dispatchEvent(event as ChatSocketEvent | Record<string, unknown>),
    onConnected: () => dispatchConnected(),
  })
  // Always running; getAuth gates whether it actually connects.
  sharedHandle.start()
  return sharedHandle
}

function reconcileSharedSocket() {
  getSharedHandle().sync()
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
    reconcileSharedSocket()

    return () => {
      hookSubscribers.delete(subscriberId)
      reconcileSharedSocket()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const subscriber = hookSubscribers.get(subscriberIdRef.current)
    if (!subscriber) return
    subscriber.enabled = enabled
    subscriber.token = token
    subscriber.workspaceId = workspaceId
    subscriber.subscriptions = subscriptionsRef.current
    reconcileSharedSocket()
  }, [enabled, subscriptionSignature, token, workspaceId])
}
