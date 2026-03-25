"use client"
import { useEffect, useRef, useState, useCallback } from "react"
import type { ChatSocketEvent } from "@synapse/shared"
import { api } from "@/lib/api"

interface UseWebSocketOptions {
  workspaceId: string | null
  onEvent?: (event: ChatSocketEvent | Record<string, unknown>) => void
  onConnected?: (payload: {
    workspaceId: string
    lastWorkspaceSequence: number
  }) => void
}

export function useWebSocket({
  workspaceId,
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
  const workspaceSequenceRef = useRef(0)
  const resyncingRef = useRef(false)
  const droppedLiveEventsDuringResyncRef = useRef(false)
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

  const cursorStorageKey = useCallback(
    (id: string) => `chat-ws-cursor:${id}`,
    []
  )

  const loadWorkspaceSequence = useCallback(
    (id: string) => {
      if (typeof window === "undefined") return 0
      const raw = window.sessionStorage.getItem(cursorStorageKey(id))
      const parsed = raw ? Number(raw) : 0
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
    },
    [cursorStorageKey]
  )

  const saveWorkspaceSequence = useCallback(
    (id: string, sequence: number) => {
      if (typeof window === "undefined") return
      window.sessionStorage.setItem(cursorStorageKey(id), String(sequence))
    },
    [cursorStorageKey]
  )

  // Keep onEvent ref updated without causing reconnects
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
  }, [])

  const applyFeedRecord = useCallback(
    (workspaceIdValue: string, event: ChatSocketEvent<"feed.item.created">) => {
      const payload = event.payload
      const nextSequence = Number(payload.workspaceSequence || 0)
      const currentSequence = workspaceSequenceRef.current
      if (!Number.isFinite(nextSequence) || nextSequence <= currentSequence) {
        return
      }

      onEventRef.current?.(event)
      workspaceSequenceRef.current = nextSequence
      saveWorkspaceSequence(workspaceIdValue, nextSequence)
    },
    [saveWorkspaceSequence]
  )

  const resyncWorkspaceFeed = useCallback(
    async (workspaceIdValue: string) => {
      if (resyncingRef.current) return
      resyncingRef.current = true
      droppedLiveEventsDuringResyncRef.current = false

      try {
        let afterSequence = workspaceSequenceRef.current
        while (mountedRef.current) {
          const page = await api.getWorkspaceFeed(
            workspaceIdValue,
            afterSequence,
            200
          )
          const records = Array.isArray(page?.records) ? page.records : []
          if (records.length === 0) {
            break
          }

          for (const record of records) {
            applyFeedRecord(workspaceIdValue, {
              type: "feed.item.created",
              payload: record,
            })
            afterSequence = record.workspaceSequence
          }

          if (!page?.hasMore) {
            break
          }
        }
      } catch {
        if (mountedRef.current) {
          ws.current?.close()
        }
      } finally {
        if (droppedLiveEventsDuringResyncRef.current && mountedRef.current) {
          droppedLiveEventsDuringResyncRef.current = false
          ws.current?.close()
        }
        resyncingRef.current = false
      }
    },
    [applyFeedRecord]
  )

  const connect = useCallback(() => {
    if (!workspaceId || !mountedRef.current) return

    cleanup()
    setConnecting(true)

    const url = resolveWebSocketUrl(process.env.NEXT_PUBLIC_WS_URL)
    const socket = new WebSocket(url)
    ws.current = socket

    socket.onopen = () => {
      workspaceSequenceRef.current = loadWorkspaceSequence(workspaceId)
      socket.send(
        JSON.stringify({
          type: "auth",
          workspaceId,
          lastWorkspaceSequence: workspaceSequenceRef.current,
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
                : rawType === "chat.feed.item.created"
                  ? "feed.item.created"
                  : rawType === "chat.runtime.updated"
                    ? "runtime.updated"
                    : rawType === "chat.conversation.updated"
                      ? "conversation.updated"
                      : rawType
        const normalizedMessage = {
          ...msg,
          type: normalizedType,
        } as ChatSocketEvent | Record<string, unknown>

        if (normalizedType === "auth.ok") {
          setConnected(true)
          setConnecting(false)
          reconnectAttempts.current = 0
          resyncingRef.current = false
          droppedLiveEventsDuringResyncRef.current = false

          const payload = (normalizedMessage as ChatSocketEvent<"auth.ok">)
            .payload
          const nextSequence = Number(
            payload.lastWorkspaceSequence || workspaceSequenceRef.current || 0
          )
          workspaceSequenceRef.current = nextSequence
          saveWorkspaceSequence(workspaceId, nextSequence)
          onConnectedRef.current?.({
            workspaceId,
            lastWorkspaceSequence: nextSequence,
          })

          // Start ping watchdog — expect a ping within 45s
          resetPingWatchdog()
          return
        }

        if (normalizedType === "auth.error") {
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

        if (normalizedType === "feed.item.created" && workspaceId) {
          const payload = (
            normalizedMessage as ChatSocketEvent<"feed.item.created">
          ).payload
          const nextSequence = Number(payload.workspaceSequence || 0)
          const currentSequence = workspaceSequenceRef.current
          if (
            !Number.isFinite(nextSequence) ||
            nextSequence <= currentSequence
          ) {
            return
          }

          if (resyncingRef.current) {
            droppedLiveEventsDuringResyncRef.current = true
            return
          }

          if (nextSequence > currentSequence + 1) {
            void resyncWorkspaceFeed(workspaceId)
            return
          }

          applyFeedRecord(
            workspaceId,
            normalizedMessage as ChatSocketEvent<"feed.item.created">
          )
          return
        }

        // Forward all other events to the handler
        onEventRef.current?.(normalizedMessage)
      } catch {
        // ignore parse errors
      }
    }

    socket.onclose = () => {
      setConnected(false)
      setConnecting(false)
      if (pingCheckTimer.current) {
        clearTimeout(pingCheckTimer.current)
        pingCheckTimer.current = null
      }

      // Reconnect with exponential backoff
      if (
        mountedRef.current &&
        reconnectAttempts.current < maxReconnectAttempts
      ) {
        const retrySchedule = [250, 500, 1000, 2000, 3000, 5000]
        const delay =
          retrySchedule[
            Math.min(reconnectAttempts.current, retrySchedule.length - 1)
          ] || 5000
        const jitter = Math.random() * 250
        reconnectAttempts.current++
        reconnectTimer.current = setTimeout(() => {
          if (mountedRef.current) connect()
        }, delay + jitter)
      }
    }

    socket.onerror = () => {
      // onclose will fire after this
    }

    function resetPingWatchdog() {
      if (pingCheckTimer.current) clearTimeout(pingCheckTimer.current)
      pingCheckTimer.current = setTimeout(() => {
        // No ping for 45s, force reconnect
        if (mountedRef.current) {
          socket.close()
        }
      }, 45000)
    }
  }, [
    workspaceId,
    cleanup,
    saveWorkspaceSequence,
    applyFeedRecord,
    resyncWorkspaceFeed,
    resolveWebSocketUrl,
  ])

  useEffect(() => {
    mountedRef.current = true
    connect()
    return () => {
      mountedRef.current = false
      cleanup()
    }
  }, [connect, cleanup])

  return { connected, connecting }
}
