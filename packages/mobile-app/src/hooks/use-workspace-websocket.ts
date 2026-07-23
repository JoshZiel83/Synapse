import { useEffect, useRef, type MutableRefObject } from "react"

import { getWebSocketUrl } from "@/lib/config"
import { useSession } from "@/providers/session-provider"
import { withClientSpan } from "@/lib/client-trace"
import type { ChatSocketEvent } from "@shared"
import {
  createChatSocket,
  type ChatSocketHandle,
  type ChatSocketSubscription,
  type ChatSocketTraceContext,
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

/**
 * Per-frame W3C trace context for outgoing work-starting WS frames. Opens a
 * SHORT real client span (`ws.send auth` / `ws.send subscribe`, op `ws.client`)
 * via the shared `withClientSpan` helper and stamps ITS span context, so each
 * reconnect/late-`onopen` frame parents to a span the SDK actually created —
 * never the old hand-assembled carrier that went unstamped whenever no idle span
 * was active. No Sentry client ⇒ nothing is stamped and the server starts a
 * fresh root.
 */
function getWsTraceContext(
  frame: "auth" | "subscribe"
): ChatSocketTraceContext | undefined {
  return withClientSpan(`ws.send ${frame}`, "ws.client", (carrier) =>
    carrier ? { traceparent: carrier } : undefined
  )
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
    getTraceContext: getWsTraceContext,
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
