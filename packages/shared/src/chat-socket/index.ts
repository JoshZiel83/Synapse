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

/**
 * W3C trace context stamped onto the outgoing frames that start server-side
 * work (`auth` and `subscribe` — the envelope-carried carrier contract, plan
 * §3c/§4.B). `unsubscribe`/`pong` are pure bookkeeping and are never stamped.
 */
export interface ChatSocketTraceContext {
  traceparent: string
  tracestate?: string
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
  /**
   * Current W3C trace context for the sender, read at frame-send time. When it
   * returns a carrier with a `traceparent`, outgoing `auth` and `subscribe`
   * frames carry `{traceparent, tracestate}` on the envelope so the server
   * parents its per-message spans to the client's active trace (web sources it
   * from Sentry `getTraceData`; mobile builds it from the active span). Absent /
   * undefined ⇒ frames go out unstamped and the server starts a fresh root.
   */
  getTraceContext?: () => ChatSocketTraceContext | undefined
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
  /**
   * How `auth.error` is treated:
   *  - `true` (default): the rejected identity is permanently fatal — it will not
   *    (re)connect until a DIFFERENT identity arrives. Correct for TOKEN auth
   *    (mobile): a rejected token stays rejected, so reconnect attempts on every
   *    subscription change would just loop.
   *  - `false`: `auth.error` only stops the CURRENT auto-reconnect loop; a later
   *    `sync()` (e.g. inputs changed, or the cookie was refreshed) is allowed to
   *    reconnect the same identity. Correct for COOKIE auth (web), where the
   *    identity is just the workspaceId and the underlying cookie can become valid
   *    again without the identity string changing.
   */
  authErrorIsFatal?: boolean
  /**
   * Only used when `authErrorIsFatal` is false (cookie auth). If set, after an
   * `auth.error` the core schedules a periodic re-attempt every this-many ms (so
   * a server-side cookie revalidation recovers realtime automatically, without
   * waiting for a UI-driven `sync()`). Unset/0 = no periodic retry; only an
   * explicit `sync()` resumes.
   */
  authErrorRetryMs?: number
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
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
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
  const authErrorIsFatal = deps.authErrorIsFatal ?? true
  const authErrorRetryMs = deps.authErrorRetryMs ?? 0

  let running = false
  let socket: SocketLike | null = null
  let authenticated = false
  let activeIdentity: string | null = null
  /**
   * Auth identity that was rejected by an `auth.error` frame. We refuse to
   * (re)connect this exact identity until a DIFFERENT identity arrives via
   * sync() — otherwise a server-side auth rejection would loop forever as the
   * hooks call sync() on every subscription change.
   */
  let fatalIdentity: string | null = null
  let reconnectAttempts = 0
  let reconnectTimer: TimerHandle = null
  let pingTimer: TimerHandle = null
  /** Periodic re-attempt timer used after a non-fatal auth.error (cookie auth). */
  let authRetryTimer: TimerHandle = null
  /** Set during intentional teardown so onclose does not schedule a reconnect. */
  let suppressReconnect = false
  /**
   * Set after a NON-fatal `auth.error` (authErrorIsFatal=false, i.e. cookie auth):
   * the current auto-reconnect loop is paused, but an explicit `sync()` clears it
   * so a fresh attempt (e.g. after a cookie refresh) can run.
   */
  let autoReconnectSuspended = false
  const sentSubscriptions = new Map<string, string>()

  function setState(state: ChatSocketConnectionState) {
    deps.onStateChange?.(state)
  }

  /**
   * Envelope trace fields for a work-starting frame (auth/subscribe), read at
   * send time so each frame carries the trace that was active when it was sent.
   * Empty when no context is available — the field simply stays off the frame
   * (the server-side envelope schema treats absent as "fresh root").
   */
  function traceContextFields(): Partial<ChatSocketTraceContext> {
    const carrier = deps.getTraceContext?.()
    if (!carrier?.traceparent) return {}
    const fields: Partial<ChatSocketTraceContext> = {
      traceparent: carrier.traceparent,
    }
    if (carrier.tracestate) fields.tracestate = carrier.tracestate
    return fields
  }

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      deps.clearTimer(reconnectTimer)
      reconnectTimer = null
    }
  }

  function clearAuthRetryTimer() {
    if (authRetryTimer !== null) {
      deps.clearTimer(authRetryTimer)
      authRetryTimer = null
    }
  }

  /**
   * After a non-fatal auth.error (cookie auth), optionally schedule a periodic
   * re-attempt so a server-side cookie revalidation recovers realtime without
   * waiting for a UI-driven sync().
   */
  function scheduleAuthRetry() {
    if (authErrorRetryMs <= 0) return
    clearAuthRetryTimer()
    authRetryTimer = deps.setTimer(() => {
      authRetryTimer = null
      if (!running || !autoReconnectSuspended) return
      // Lift the suspension for one fresh attempt; if it fails again, the
      // auth.error handler will re-suspend and re-arm this timer.
      autoReconnectSuspended = false
      reconnectAttempts = 0
      evaluate()
    }, authErrorRetryMs)
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

    const desired = new Map<
      string,
      { serialized: string; subscription: ChatSocketSubscription }
    >()
    for (const subscription of deps.getSubscriptions()) {
      desired.set(subscription.key, {
        serialized: serialize(subscription),
        subscription,
      })
    }

    for (const [key] of sentSubscriptions) {
      if (desired.has(key)) continue
      socket.send(serialize({ type: "unsubscribe", key }))
      sentSubscriptions.delete(key)
    }

    for (const [key, { serialized, subscription }] of desired) {
      if (sentSubscriptions.get(key) === serialized) continue
      // Trace fields ride the frame but stay out of the dedupe signature (a
      // trace change alone must not re-send an already-sent subscription).
      socket.send(
        serialize({
          type: "subscribe",
          ...subscription,
          ...traceContextFields(),
        })
      )
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
      const frame: Record<string, unknown> = {
        type: "auth",
        ...traceContextFields(),
      }
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
        autoReconnectSuspended = false
        clearAuthRetryTimer()
        setState("open")
        syncSubscriptions()
        deps.onConnected()
        resetPingWatchdog()
        return
      }

      if (type === "auth.error") {
        if (authErrorIsFatal) {
          // Token auth: rejected identity is permanently fatal until a DIFFERENT
          // identity arrives (records fatalIdentity so sync()/reconnect skip it).
          fatalIdentity = authIdentity(auth)
        } else {
          // Cookie auth: just suspend the auto-reconnect loop. A later sync()
          // (inputs changed, or the cookie refreshed) clears this and retries;
          // optionally a periodic retry timer revives it automatically.
          autoReconnectSuspended = true
          teardownSocket()
          scheduleAuthRetry()
          return
        }
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
      const closingIdentity = authIdentity(deps.getAuth())
      if (closingIdentity === null) return
      // Never reconnect an identity the server rejected with auth.error.
      if (closingIdentity === fatalIdentity) return
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

    // A different identity has arrived — clear any prior fatal mark.
    if (fatalIdentity !== null && identity !== fatalIdentity) {
      fatalIdentity = null
    }
    // Auto-reconnect suspended after a non-fatal auth.error; only an explicit
    // sync() (which clears the flag) may revive it.
    if (autoReconnectSuspended) {
      return
    }
    // This exact identity was rejected by auth.error; do not (re)connect it.
    if (identity === fatalIdentity) {
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
      clearAuthRetryTimer()
      teardownSocket()
      activeIdentity = null
    },
    sync() {
      if (!running) return
      // An explicit sync() is a fresh signal from the consumer (inputs changed,
      // session refreshed, etc.): lift any non-fatal auth-error suspension so the
      // cookie gets another chance, and reset the reconnect budget for the retry.
      if (autoReconnectSuspended) {
        autoReconnectSuspended = false
        reconnectAttempts = 0
        clearAuthRetryTimer()
      }
      evaluate()
    },
  }
}
