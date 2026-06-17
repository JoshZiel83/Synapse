/**
 * DingTalk Stream long-connection driver.
 *
 * Owns:
 *   - DWClient lifecycle (connect, SDK-driven liveness, outer backoff
 *     loop, graceful abort)
 *   - inbound message ACK + dedup + normalize + emitInbound orchestration
 *
 * Lifecycle split between SDK and outer loop:
 *
 *   - SDK `keepAlive: true` runs a heartbeat interval (heartbeat_interval,
 *     8s default) that sends a WebSocket-protocol ping frame each tick and
 *     terminates the socket if no pong arrived since the previous tick. This
 *     keeps the connection alive across idle periods (inbound robot messages
 *     are NOT a liveness signal — they only flow when a user actually @s the
 *     bot). The watchdog's `socket.terminate()` fires `socket.on('close')`
 *     and lets our outer loop notice. (The ping/pong live at the WS framing
 *     layer; the SDK's SYSTEM `ping`/`KEEPALIVE` topic handlers only passively
 *     respond to server-initiated frames and are NOT this client heartbeat.)
 *
 *   - SDK `autoReconnect: false` keeps the SDK from queueing its own
 *     setTimeout-based reconnect; we control retry cadence in `runLoop`.
 *
 *   - SDK's known bug of leaking a heartbeat-interval handle across
 *     reconnects only fires when SDK itself reconnects. Because each
 *     iteration of `runLoop` constructs a brand-new DWClient and
 *     disconnects the previous one, the leak doesn't apply.
 *
 * SDK reality check — the dingtalk-stream@2.1.x DWClient does NOT emit
 * `connected` or `disconnect` events at the EventEmitter level (it
 * only `emit()`s for registered CALLBACK topics). Connection lifecycle
 * signals live on the underlying WebSocket, accessed via `client.socket`:
 *
 *   - socket.on('close') → server cut OR our disconnect() ran OR the
 *     SDK's heartbeat watchdog terminated the socket.
 *   - socket.on('error') → connection error post-open.
 *   - socket.readyState === 1 → OPEN; anything else after connect()
 *     resolves means SDK swallowed the failure (see SDK connect()
 *     try/catch which doesn't rethrow with autoReconnect:false).
 *
 * There is also a SYSTEM-level "disconnect" topic the SDK handles
 * internally (client.cjs:243): it only flips `connected/registered` to
 * false, does NOT close the socket, and does NOT emit anything. A
 * server-side logical disconnect can therefore reach the SDK without
 * triggering any of the socket events. We wrap `client.onSystem` on
 * the instance to abort the current cycle when this topic arrives —
 * delegating to the SDK's original handler first so its bookkeeping
 * stays consistent.
 *
 * We thus:
 *   - await client.connect()
 *   - sanity-check client.socket?.readyState === 1; throw otherwise to
 *     drop into the outer backoff path
 *   - hook socket.on('close'/'error') AND the wrapped onSystem to abort
 *     the per-cycle controller, waking the wait-promise so the next
 *     iteration rebuilds the client.
 *   - capture the per-cycle controller in `connectOnce()` rather than
 *     reading the ambient `cycleEnd` — without the snapshot, a
 *     late-firing event from the previous socket (e.g. error → terminate
 *     → close arriving after the next cycle started) would mistakenly
 *     abort the new cycle. The listeners also check
 *     `activeClient === client` for belt-and-braces.
 *
 * Reconnect wake-up:
 *   - Each connection cycle uses its own `cycleEnd` AbortController.
 *   - `stop()` and `ctx.signal` abort both `internalStop` AND `cycleEnd`,
 *     so the loop can exit cleanly.
 *
 * ACK ordering — ACK must precede every drop path (protocol dedup,
 * JSON parse failure, business dedup, normalize-null self-message),
 * because the DingTalk gateway redelivers any inbound that wasn't
 * acknowledged within ~60s. The exception: when headers.messageId is
 * missing we can't ACK (no id to acknowledge), so we log a warning and
 * still attempt the rest of the pipeline.
 *
 * This ACK-first ordering is a DELIBERATE divergence from the official
 * Node.js sample (which ACKs AFTER the reply succeeds, passing the reply
 * body as the ACK data). ACK-first trades gateway redelivery-on-crash for
 * guaranteed ~60s re-push suppression and tolerance of slow downstream
 * processing — see the `emitInbound` "v1 at-most-once" note below. Do NOT
 * "fix" it back to ACK-after.
 *
 * ACK is sent on the CLIENT that delivered the message, NOT the
 * ambient `activeClient`. The handler is bound at register time so a
 * late callback from a stale socket ACKs back to its own (closing)
 * client — the new socket's framing isn't poisoned by a stray ACK for
 * a foreign messageId. Stopped/aborted lookups drop without ACK; the
 * SDK would fail to write to a closed socket anyway, and the gateway
 * will redeliver on the next reconnect where dedup catches the repeat.
 *
 * Per-account dedup keys are prefixed with `account.id` so two bots in
 * the same group don't share dedup state (otherwise the second bot's
 * inbound for a shared msgId would be incorrectly dropped).
 */

import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from "dingtalk-stream"
import { computeBackoff } from "@synapse/shared"
import type { TransportAccountSummary } from "@synapse/shared/types"
import { sleep } from "../../../../infrastructure/async/index.js"
import type {
  AccountStartContext,
  InboundEnvelope,
  RunningAccount,
} from "../types.js"
import { getDingtalkCredentialsOrThrow } from "./credentials.js"
import { enrichInboundDingtalkMedia } from "./inbound-media.js"
import {
  normalizeDingtalkPayload,
  type DingtalkInboundPayload,
} from "./normalize.js"
import { parseDingtalkStreamPayload } from "./stream-codec.js"

// Tuning constants ----------------------------------------------------------
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 60_000
const BACKOFF_JITTER_MS = 1_000
// Bound the dedup map to prevent unbounded memory growth. DingTalk
// retransmissions practically always arrive within seconds of the
// original; 2000 entries (~hundreds of messages of headroom even on
// active accounts) is plenty.
const DEDUP_MAX_ENTRIES = 2000
// A connection that stays open for less than this many milliseconds is
// treated as a failed attempt for backoff purposes — without the gate,
// a gateway that connects-then-immediately-disconnects would have
// `attempts` reset to 0 on every cycle and reconnect in a tight loop.
// Anything past the threshold reset is safe: the SDK had enough time
// to register, exchange a heartbeat, and prove the path works.
const MIN_STABLE_CONNECTION_MS = 30_000

interface DedupState {
  protocol: Map<string, true>
  business: Map<string, true>
}

function newDedupState(): DedupState {
  return { protocol: new Map(), business: new Map() }
}

/**
 * Returns true if the key was already seen (caller should drop the msg).
 * Otherwise records the key and returns false.
 */
function checkAndMark(map: Map<string, true>, key: string): boolean {
  if (map.has(key)) return true
  map.set(key, true)
  if (map.size > DEDUP_MAX_ENTRIES) {
    // Drop the oldest insertion (Map preserves insertion order).
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  return false
}

export interface StartDingtalkStreamOptions {
  /** Allows the test suite to inject a mock DWClient factory. */
  clientFactory?: (config: {
    clientId: string
    clientSecret: string
  }) => MinimalDWClient
  /**
   * Override the connection-stability threshold. A connection that lives
   * less than this many ms is treated as a failure (attempts++ +
   * backoff) rather than a clean cycle. Tests usually want 0 so
   * reconnect happens immediately; the production default is
   * MIN_STABLE_CONNECTION_MS.
   */
  minStableConnectionMs?: number
}

/**
 * Subset of DWClient surface the stream loop actually uses. Anything more
 * exhaustive is implementation-detail of the SDK and shouldn't leak into
 * the test mocks.
 *
 * The SDK does NOT emit `connected`/`disconnect` events at the
 * EventEmitter level — those signals only exist on the underlying
 * WebSocket exposed as `client.socket` after `connect()` resolves.
 */
export interface MinimalDWSocket {
  /**
   * WebSocket readyState; 1 = OPEN. If `connect()` resolves but readyState
   * isn't 1, the SDK swallowed a connect failure and the outer loop must
   * treat it as a retryable error.
   */
  readyState?: number
  on(event: "close" | "error", listener: (...args: unknown[]) => void): unknown
}

export interface MinimalDWClient {
  connect(): Promise<void>
  disconnect(): void
  registerCallbackListener(
    eventId: string,
    callback: (msg: DWClientDownStream) => void
  ): unknown
  socketCallBackResponse(messageId: string, result: unknown): void
  /** Populated by the SDK after `_connect()`. May be undefined if connect failed silently. */
  socket?: MinimalDWSocket
  /**
   * SDK internal SYSTEM-message dispatch. We wrap this on the instance to
   * detect the logical-disconnect topic that the SDK handles internally
   * without closing the socket or emitting an event — see file header.
   */
  onSystem?: (downstream: DWClientDownStream) => void
}

export async function startDingtalkAccount(
  ctx: AccountStartContext,
  options: StartDingtalkStreamOptions = {}
): Promise<RunningAccount> {
  const { clientId, clientSecret } = getDingtalkCredentialsOrThrow(ctx.account)
  const dedup = newDedupState()
  let stopped = false
  let attempts = 0
  let activeClient: MinimalDWClient | undefined
  // Set inside connectOnce() after the socket is verified OPEN. The
  // post-wait reset path reads it to decide whether to clear `attempts`
  // (stable connection cycled) or treat the disconnect as a failure
  // (server cycling us within MIN_STABLE_CONNECTION_MS).
  let connectionEstablishedAt: number | undefined

  const factory = options.clientFactory ?? defaultClientFactory
  const minStableMs = options.minStableConnectionMs ?? MIN_STABLE_CONNECTION_MS

  // `internalStop` resolves when the loop should EXIT. `cycleEnd` is
  // recreated per connection cycle and resolves the wait-promise when
  // EITHER the current connection drops OR a stop signal fires.
  //
  // The previous version waited only on a single internalAbort — when the
  // SDK fired `disconnect` for a live connection, the wait stayed parked
  // and the loop never re-entered connectOnce(). This split makes both
  // events (stop + disconnect) able to wake the wait without conflating
  // their semantics.
  const internalStop = new AbortController()
  let cycleEnd = new AbortController()
  const onCtxAbort = (): void => {
    internalStop.abort()
    cycleEnd.abort()
  }
  ctx.signal.addEventListener("abort", onCtxAbort, { once: true })

  function backoffDelay(): number {
    return computeBackoff(attempts, {
      baseMs: BACKOFF_BASE_MS,
      maxMs: BACKOFF_MAX_MS,
      minMs: 0,
      jitterMode: "additive",
      jitterMs: BACKOFF_JITTER_MS,
    })
  }

  function handleInbound(
    client: MinimalDWClient,
    msg: DWClientDownStream
  ): void {
    // Drop callbacks that arrive after stop() / abort. The socket is
    // either gone or going; the gateway will re-route to whoever owns
    // the next session. We deliberately do NOT ACK here — the SDK's
    // send() would write to a closed socket, and dropping the ACK lets
    // the gateway redeliver elsewhere (or to us on the next reconnect,
    // where dedup catches the repeat).
    if (stopped || ctx.signal.aborted) {
      return
    }
    const messageId =
      typeof msg?.headers?.messageId === "string"
        ? msg.headers.messageId
        : undefined

    // ─── Step A: ACK first (when possible) — before any drop path ───
    // ACK on the CLIENT that delivered the message, not the ambient
    // activeClient. Late callbacks from a stale socket would otherwise
    // ACK on the brand-new connection (wrong session), and the ACK
    // would silently fail or worse, confuse the new socket's framing.
    if (messageId) {
      try {
        client.socketCallBackResponse(messageId, { success: true })
      } catch (err) {
        ctx.logger.warn(
          `dingtalk: ACK failed for messageId=${messageId}: ${(err as Error).message}`,
          { accountId: ctx.account.id }
        )
      }
    } else {
      // No id means we cannot ACK. The gateway will retry, but the SDK
      // path that can deliver an id-less message is an upstream bug —
      // log and attempt the rest of the pipeline so the inbound isn't
      // lost entirely.
      ctx.logger.warn(
        "dingtalk: inbound payload missing headers.messageId; skipping ACK",
        { accountId: ctx.account.id }
      )
    }

    // ─── Step B: protocol-layer dedup (per-account) ───
    if (messageId) {
      const protoKey = `${ctx.account.id}:${messageId}`
      if (checkAndMark(dedup.protocol, protoKey)) {
        ctx.logger.debug?.(
          `dingtalk: protocol-dedup hit (messageId=${messageId})`,
          { accountId: ctx.account.id }
        )
        return
      }
    }

    // ─── Step C: JSON parse ───
    const parsed: DingtalkInboundPayload | null = parseDingtalkStreamPayload(
      msg.data
    )
    if (!parsed) {
      ctx.logger.error(
        "dingtalk: invalid inbound payload JSON object (already ACKed, dropping)",
        undefined,
        { accountId: ctx.account.id }
      )
      return
    }

    // ─── Step D: business-layer dedup (per-account) ───
    if (typeof parsed.msgId === "string" && parsed.msgId.trim() !== "") {
      const bizKey = `${ctx.account.id}:${parsed.msgId.trim()}`
      if (checkAndMark(dedup.business, bizKey)) {
        ctx.logger.debug?.(
          `dingtalk: business-dedup hit (msgId=${parsed.msgId})`,
          { accountId: ctx.account.id }
        )
        return
      }
    }

    // ─── Step E: normalize (self-message filter lives inside) ───
    const envelope = normalizeDingtalkPayload(parsed, {
      logger: {
        warn: (m) => ctx.logger.warn(m, { accountId: ctx.account.id }),
      },
    })
    if (!envelope) {
      // already-ACKed bot self-message or unroutable payload — drop silently
      return
    }

    // ─── Step F: enrich inbound media (downloadCode → bytes → file service),
    // then emitInbound (failures don't trigger redelivery). The enrich is a
    // best-effort async pass after the ACK; a failure keeps the placeholders
    // rather than blocking ingestion.
    void (async () => {
      let enriched = envelope
      try {
        enriched = await enrichInboundDingtalkMedia(envelope, {
          account: ctx.account,
          logger: ctx.logger,
        })
      } catch (err) {
        ctx.logger.warn(
          `dingtalk: inbound media enrich failed; emitting placeholders: ${(err as Error).message}`,
          { accountId: ctx.account.id }
        )
      }
      await ctx
        .emitInbound(enriched)
        .catch((err) =>
          ctx.logger.error(
            "dingtalk: emitInbound threw; inbound is lost (v1 at-most-once semantics)",
            err,
            { accountId: ctx.account.id }
          )
        )
    })()
  }

  async function connectOnce(): Promise<void> {
    const client = factory({ clientId, clientSecret })
    activeClient = client
    // Snapshot the cycle controller — listeners (socket close/error,
    // SYSTEM disconnect wrap) close over this *specific* cycle, not the
    // ambient `cycleEnd` which the next loop iteration reassigns. Without
    // the snapshot a late-firing event from the old socket (e.g.
    // error→terminate→close arriving after the next cycle started) would
    // mistakenly abort the new cycle.
    const thisCycle = cycleEnd
    const abortIfCurrent = (): void => {
      if (activeClient === client) thisCycle.abort()
    }

    // The SDK handles its internal SYSTEM `disconnect` topic by setting
    // `connected = false` but does NOT close the socket and does NOT emit
    // anything (see client.cjs:243). A server-side logical disconnect
    // would therefore leave the socket "open" from our point of view,
    // and our `socket.on('close')` would never fire. Wrap the SDK's
    // `onSystem` so we abort the cycle for the logical disconnect too;
    // the original implementation still runs so the SDK's own flag
    // bookkeeping stays consistent.
    if (typeof client.onSystem === "function") {
      const originalOnSystem = client.onSystem.bind(client)
      client.onSystem = (downstream: DWClientDownStream) => {
        originalOnSystem(downstream)
        if (downstream?.headers?.topic === "disconnect") {
          ctx.logger.info(
            "dingtalk: SDK SYSTEM 'disconnect' topic, ending cycle for reconnect",
            { accountId: ctx.account.id }
          )
          abortIfCurrent()
        }
      }
    }

    client.registerCallbackListener(TOPIC_ROBOT, (msg) =>
      handleInbound(client, msg)
    )
    await client.connect()
    // The SDK's connect() try/catches getEndpoint() and _connect() and
    // does NOT rethrow when autoReconnect:false (see SDK client.cjs:189).
    // The only reliable post-connect liveness signal is the socket's
    // readyState. WebSocket.OPEN === 1.
    const socket = client.socket
    if (!socket || socket.readyState !== 1) {
      throw new Error(
        `dingtalk: client.connect() resolved but socket is not OPEN (readyState=${socket?.readyState ?? "undefined"}) — SDK swallowed the failure`
      )
    }
    ctx.logger.info("dingtalk: stream connected", {
      accountId: ctx.account.id,
    })
    connectionEstablishedAt = Date.now()
    // NOTE: we intentionally do NOT `attempts = 0` here. A gateway that
    // accepts connections but cuts them within milliseconds would
    // otherwise loop with no exponential backoff, because the "short
    // close → catch → attempts++" path would always run with attempts=0
    // again. The reset only belongs in the stable-cycle branch below
    // (after the connection survived the minStableMs threshold).
    // Wake the loop's wait-promise when the WebSocket closes for any
    // reason — server cut, our disconnect(), or the SDK's keepAlive
    // watchdog calling terminate() on a silent connection. The SDK's
    // own socket.on('close') only re-runs SDK.connect() if autoReconnect
    // is true (it isn't), so we won't race with it.
    socket.on("close", () => {
      ctx.logger.info(
        "dingtalk: socket closed, ending current cycle for reconnect",
        { accountId: ctx.account.id }
      )
      abortIfCurrent()
    })
    socket.on("error", (err) => {
      ctx.logger.warn(
        `dingtalk: socket error: ${(err as Error)?.message ?? String(err)}`,
        { accountId: ctx.account.id }
      )
      abortIfCurrent()
    })
  }

  async function runLoop(): Promise<void> {
    while (!stopped) {
      // Fresh cycle controller per attempt — last cycle's controller may
      // already be aborted, and we want a clean signal for the new cycle.
      cycleEnd = new AbortController()
      try {
        await connectOnce()
        // SDK's own keepAlive runs the heartbeat. Wait until either:
        //   - the server-side socket dies (SDK fires `disconnect` →
        //     cycleEnd.abort() above), OR
        //   - stop() / ctx.signal abort cycles through cycleEnd too.
        await new Promise<void>((resolve) => {
          const signal = cycleEnd.signal
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
        try {
          activeClient?.disconnect()
        } catch {
          /* ignore */
        }
        if (stopped || ctx.signal.aborted) return
        // Gate the `attempts = 0` reset on connection stability. A
        // connection that survived past minStableMs proves the path
        // works — reset and reconnect immediately. A shorter life means
        // the gateway is cycling us; count this as a failure and apply
        // backoff so a connect-then-immediate-disconnect loop doesn't
        // hammer the gateway.
        const lifetimeMs =
          connectionEstablishedAt !== undefined
            ? Date.now() - connectionEstablishedAt
            : 0
        connectionEstablishedAt = undefined
        if (lifetimeMs >= minStableMs) {
          attempts = 0
          continue
        }
        attempts += 1
        const delay = backoffDelay()
        ctx.logger.warn(
          `dingtalk: stream cycled after ${lifetimeMs}ms (< ${minStableMs}ms stable threshold); attempt ${attempts}, retrying in ${Math.round(delay)}ms`,
          { accountId: ctx.account.id }
        )
        await sleep(delay, internalStop.signal)
        if (stopped || ctx.signal.aborted) return
      } catch (err) {
        try {
          activeClient?.disconnect()
        } catch {
          /* ignore */
        }
        connectionEstablishedAt = undefined
        attempts += 1
        const delay = backoffDelay()
        ctx.logger.warn(
          `dingtalk: stream attempt ${attempts} failed: ${(err as Error).message}; retrying in ${Math.round(delay)}ms`,
          { accountId: ctx.account.id }
        )
        // Sleep against internalStop (which `onCtxAbort` also aborts) so
        // both stop() and ctx.signal can unblock backoff. Using
        // ctx.signal alone left stop() unable to cancel an in-flight
        // backoff — the loop would linger up to BACKOFF_MAX_MS+jitter
        // after stop() returned.
        await sleep(delay, internalStop.signal)
        if (stopped || ctx.signal.aborted) return
      }
    }
  }

  // Fire-and-forget the loop; the runtime will treat startAccount as
  // "successfully launched" the moment we return a RunningAccount.
  void runLoop()

  return {
    stop: async () => {
      stopped = true
      // Wake the wait-promise so the loop can exit cleanly.
      internalStop.abort()
      cycleEnd.abort()
      ctx.signal.removeEventListener("abort", onCtxAbort)
      try {
        activeClient?.disconnect()
      } catch {
        /* ignore */
      }
    },
  }
}

/**
 * Default factory used in production. Exported so tests can invoke the
 * real `DWClient` constructor and verify config defaults (keepAlive/
 * autoReconnect) actually take effect — going through the mock factory
 * wouldn't catch a regression in the values we hand the SDK.
 */
export function defaultClientFactory(config: {
  clientId: string
  clientSecret: string
}): MinimalDWClient {
  // SDK options:
  //   keepAlive: true   — SDK sends a WebSocket-protocol ping frame every
  //                       heartbeat_interval (8s) and consumes the matching
  //                       pong, so the connection survives idle periods.
  //                       Without this an otherwise-healthy connection with
  //                       no robot traffic for ~30s gets cut by the server.
  //                       (Inbound robot messages are NOT a liveness signal —
  //                       they go through registerCallbackListener; the
  //                       ping/pong live at the WS framing layer and don't
  //                       touch our handler.)
  //   autoReconnect: false — we drive reconnect from the outer runLoop.
  //                       Without this the SDK swallows initial connection
  //                       failures, queues its own setTimeout, and leaves
  //                       both timers racing the outer backoff.
  // Each runLoop iteration creates a fresh DWClient, so the SDK's known
  // bug of leaking a heartbeat interval across reconnects (which only
  // fires when SDK itself reconnects) doesn't apply to us.
  // The ACK payload uses the plain `{success: true}` shape that every
  // OpenClaw production reference uses, rather than the SDK's typed
  // `EventAck.SUCCESS` enum.
  const client = new DWClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    keepAlive: true,
    autoReconnect: false,
  } as ConstructorParameters<typeof DWClient>[0])
  return client as unknown as MinimalDWClient
}

// Helper used by the public TransportConnector.startAccount adapter so
// the index.ts assembly stays a one-liner.
export type { TransportAccountSummary }
