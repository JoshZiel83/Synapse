/**
 * Framework- and DOM-agnostic chat WebSocket transport core.
 *
 * Extracted from the two byte-compatible client implementations that had drifted:
 *  - web   `hooks/use-websocket.ts`            (per-hook socket, cookie auth)
 *  - mobile `hooks/use-workspace-websocket.ts` (module-singleton multiplex, token auth)
 *
 * Both spoke the identical protocol — auth handshake, 45s ping watchdog,
 * 20-attempt `min(5000, 1000*n)` reconnect backoff, and subscription-key diffing.
 * That state machine lives here; each frontend keeps only a thin wrapper that
 * injects its platform bits (the WebSocket constructor, timers, URL, and how auth
 * is sourced — cookie vs token, per-component vs aggregated multiplex).
 *
 * Pure ES2022: declares its own minimal `SocketLike` instead of referencing the
 * DOM `WebSocket` type, so it compiles under the shared package's no-DOM tsconfig.
 * On its own subpath; not re-exported from the root barrel.
 */

/**
 * Minimal structural shape satisfied by both the browser `WebSocket` and the
 * React Native `WebSocket`. Uses assignable `on*` handlers (not addEventListener)
 * because that is how both clients drive the socket today.
 *
 * The handler parameters are typed loosely (`any` event) on purpose: the DOM and
 * RN `WebSocket` declare different concrete event types (`MessageEvent` vs RN's
 * own), and the core only ever reads `event.data`. Typing them loosely lets a raw
 * `new WebSocket(url)` be passed to `connect` from either platform with no cast.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface SocketLike {
  send(data: string): void
  close(): void
  onopen: ((event: any) => void) | null
  onmessage: ((event: any) => void) | null
  onclose: ((event: any) => void) | null
  onerror: ((event: any) => void) | null
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface ChatSocketAuth {
  token?: string | null
  workspaceId?: string | null
}

export type ChatSocketSubscription =
  | { key: string; topic: "inbox" }
  | { key: string; topic: "conversation"; conversationId: string }

export type ChatSocketConnectionState = "connecting" | "open" | "closed"

export type TimerHandle = unknown

export interface ChatSocketDeps {
  /** Open a new socket for `url` (web: `(u) => new WebSocket(u)`). */
  connect: (url: string) => SocketLike
  /** Resolve the ws(s):// URL to connect to. */
  resolveUrl: () => string
  /** Schedule a timer; return a handle understood by `clearTimer`. */
  setTimer: (fn: () => void, ms: number) => TimerHandle
  clearTimer: (handle: TimerHandle) => void
  /**
   * Current auth. Return `null` (or an object without a workspaceId) when the
   * socket should NOT be connected. Web returns `{ workspaceId }` (cookie auth,
   * no token frame); mobile returns `{ token, workspaceId }`.
   */
  getAuth: () => ChatSocketAuth | null
  /** Current desired subscription set (aggregated, for the multiplex case). */
  getSubscriptions: () => ChatSocketSubscription[]
  /** Called for every non-protocol frame (already parsed). */
  onEvent: (event: Record<string, unknown>) => void
  /** Called once per successful auth handshake (auth.ok). */
  onConnected: () => void
  /** Optional connection-state notifications (drives web's connected/connecting). */
  onStateChange?: (state: ChatSocketConnectionState) => void
  /** Override JSON serialization (defaults to JSON.stringify). */
  serialize?: (value: unknown) => string
  /** Override frame parsing (defaults to JSON.parse with an object guard). */
  deserialize?: (raw: unknown) => Record<string, unknown> | null
  maxReconnectAttempts?: number
  pingWatchdogMs?: number
}

export interface ChatSocketHandle {
  /** Begin connecting (idempotent). */
  start(): void
  /** Tear down the socket + timers and stop reconnecting. */
  stop(): void
  /**
   * Re-read auth + subscriptions and reconcile: reconnect if the auth identity
   * changed, otherwise diff-sync subscriptions. Call after any input changes.
   */
  sync(): void
}

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 20
const DEFAULT_PING_WATCHDOG_MS = 45_000

function defaultSerialize(value: unknown): string {
  return JSON.stringify(value)
}

function defaultDeserialize(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function authIdentity(auth: ChatSocketAuth | null): string | null {
  if (!auth || !auth.workspaceId) return null
  return `${auth.token ?? ""}::${auth.workspaceId}`
}

/**
 * Build the chat socket transport. The returned handle is inert until `start()`.
 */
export function createChatSocket(deps: ChatSocketDeps): ChatSocketHandle {
  const serialize = deps.serialize ?? defaultSerialize
  const deserialize = deps.deserialize ?? defaultDeserialize
  const maxReconnectAttempts =
    deps.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS
  const pingWatchdogMs = deps.pingWatchdogMs ?? DEFAULT_PING_WATCHDOG_MS

  let running = false
  let socket: SocketLike | null = null
  let authenticated = false
  let activeIdentity: string | null = null
  let reconnectAttempts = 0
  let reconnectTimer: TimerHandle = null
  let pingTimer: TimerHandle = null
  /** Set during intentional teardown so onclose does not schedule a reconnect. */
  let suppressReconnect = false
  const sentSubscriptions = new Map<string, string>()

  function setState(state: ChatSocketConnectionState) {
    deps.onStateChange?.(state)
  }

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      deps.clearTimer(reconnectTimer)
      reconnectTimer = null
    }
  }

  function clearPingWatchdog() {
    if (pingTimer !== null) {
      deps.clearTimer(pingTimer)
      pingTimer = null
    }
  }

  function resetPingWatchdog() {
    clearPingWatchdog()
    pingTimer = deps.setTimer(() => {
      // No ping from the server within the window — close so onclose reconnects.
      try {
        socket?.close()
      } catch {
        // ignore
      }
    }, pingWatchdogMs)
  }

  function teardownSocket() {
    clearReconnectTimer()
    clearPingWatchdog()
    authenticated = false
    sentSubscriptions.clear()
    if (socket) {
      suppressReconnect = true
      socket.onopen = null
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      try {
        socket.close()
      } catch {
        // ignore
      }
      socket = null
    }
    setState("closed")
  }

  function syncSubscriptions() {
    if (!socket || !authenticated) return

    const desired = new Map<string, string>()
    for (const subscription of deps.getSubscriptions()) {
      desired.set(subscription.key, serialize(subscription))
    }

    for (const [key] of sentSubscriptions) {
      if (desired.has(key)) continue
      socket.send(serialize({ type: "unsubscribe", key }))
      sentSubscriptions.delete(key)
    }

    for (const [key, serialized] of desired) {
      if (sentSubscriptions.get(key) === serialized) continue
      socket.send(serialize({ type: "subscribe", ...JSON.parse(serialized) }))
      sentSubscriptions.set(key, serialized)
    }
  }

  function connect(auth: ChatSocketAuth) {
    activeIdentity = authIdentity(auth)
    suppressReconnect = false
    setState("connecting")

    const next = deps.connect(deps.resolveUrl())
    socket = next

    next.onopen = () => {
      reconnectAttempts = 0
      const frame: Record<string, unknown> = { type: "auth" }
      if (auth.token) frame.token = auth.token
      if (auth.workspaceId) frame.workspaceId = auth.workspaceId
      next.send(serialize(frame))
    }

    next.onmessage = (event) => {
      const parsed = deserialize(event.data)
      if (!parsed) return
      const type = typeof parsed.type === "string" ? parsed.type : ""

      if (type === "auth.ok") {
        authenticated = true
        reconnectAttempts = 0
        setState("open")
        syncSubscriptions()
        deps.onConnected()
        resetPingWatchdog()
        return
      }

      if (type === "auth.error") {
        // Fatal for this identity: tear down and do not reconnect until a new
        // auth identity arrives via sync().
        teardownSocket()
        return
      }

      if (type === "ping") {
        next.send(serialize({ type: "pong" }))
        resetPingWatchdog()
        return
      }

      deps.onEvent(parsed)
    }

    next.onclose = () => {
      authenticated = false
      sentSubscriptions.clear()
      socket = null
      clearPingWatchdog()
      setState("closed")

      if (suppressReconnect) {
        suppressReconnect = false
        return
      }
      if (!running) return
      // Only reconnect while the same auth is still desired.
      if (authIdentity(deps.getAuth()) === null) return
      if (reconnectAttempts >= maxReconnectAttempts) return

      reconnectAttempts += 1
      const delay = Math.min(5000, 1000 * reconnectAttempts)
      clearReconnectTimer()
      reconnectTimer = deps.setTimer(() => {
        reconnectTimer = null
        evaluate()
      }, delay)
    }

    next.onerror = () => {
      // Let onclose drive reconnect.
    }
  }

  function evaluate() {
    if (!running) {
      teardownSocket()
      return
    }

    const auth = deps.getAuth()
    const identity = authIdentity(auth)

    if (identity === null) {
      // Nothing to connect to right now.
      teardownSocket()
      activeIdentity = null
      return
    }

    if (socket) {
      if (identity !== activeIdentity) {
        // Auth changed under us — restart cleanly.
        teardownSocket()
        reconnectAttempts = 0
        connect(auth as ChatSocketAuth)
      } else {
        syncSubscriptions()
      }
      return
    }

    connect(auth as ChatSocketAuth)
  }

  return {
    start() {
      if (running) {
        evaluate()
        return
      }
      running = true
      reconnectAttempts = 0
      evaluate()
    },
    stop() {
      running = false
      teardownSocket()
      activeIdentity = null
    },
    sync() {
      if (!running) return
      evaluate()
    },
  }
}
