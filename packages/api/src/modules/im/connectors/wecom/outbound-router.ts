/**
 * WeCom outbound router — cross-replica pub/sub multiplexer.
 *
 * The Synapse delivery worker (workers/im-transport-delivery.ts) can run on
 * any API replica, but the WeCom WSS holder is pinned to one replica via
 * the IM runtime lease. When a delivery job lands on a non-holder replica,
 * we forward it over Redis pub/sub to the holder, who actually invokes
 * `client.sendMessage(...)` and publishes the result back.
 *
 * Wire format (intentionally explicit, decoupled from the SDK's WsFrame):
 *   request:  channel `wecom:outbound:request:<accountId>`
 *             payload `{requestId: string, frameBody: {chatid, body}}`
 *   response: channel `wecom:outbound:response:<requestId>`
 *             payload `{ok: true, raw: WsFrame}` | `{ok: false, error: string}`
 *
 * `dispatchOutbound(...)` returns the bare `WsFrame` to callers regardless
 * of local vs remote path. The wire wrapping is purely internal.
 *
 * Each replica installs a single process-wide multiplexer on `redisSub`
 * (one `psubscribe` for responses, one `on('message')` for requests). The
 * Node-side `on(...)` listeners are installed exactly once and never
 * removed — re-running `ensureMultiplexer()` after a failure only retries
 * the `psubscribe()` call, it does not re-add listeners (otherwise every
 * retry would duplicate dispatch).
 *
 * `requestHandlersByChannel` registration MUST happen before
 * `redisSub.subscribe(...)` returns, AND `ensureMultiplexer()` MUST be
 * awaited first, otherwise a holder that starts up before any dispatch
 * has occurred would have a live channel subscription but no
 * `'message'` handler to drain it.
 *
 * The holder-side request handler reads the WSClient from the live
 * `holders` map at dispatch time (rather than capturing it via closure on
 * subscribe). This lets `startWecomAccount` swap the underlying client
 * in place when the WeCom server kicks our connection
 * (`disconnected_event`) without re-subscribing.
 */

import { randomUUID } from "node:crypto"
import type { SendMsgBody, WsFrame } from "@wecom/aibot-node-sdk"
import { redisPub, redisSub } from "../../../../infrastructure/redis/index.js"
import { createLogger } from "../../../../infrastructure/logger/index.js"
import type { WecomClient } from "./client.js"

const REQUEST_CHANNEL_PREFIX = "wecom:outbound:request:"
const RESPONSE_CHANNEL_PREFIX = "wecom:outbound:response:"
const RESPONSE_PATTERN = `${RESPONSE_CHANNEL_PREFIX}*`
const DEFAULT_TIMEOUT_MS = 5_000

const log = createLogger("im.wecom")

export interface FrameBody {
  chatid: string
  body: SendMsgBody
}

interface WireRequest {
  requestId: string
  frameBody: FrameBody
}

type WireResponse = { ok: true; raw: WsFrame } | { ok: false; error: string }

interface PendingRequest {
  resolve: (frame: WsFrame) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

const holders = new Map<string, WecomClient>()
const pendingRequests = new Map<string, PendingRequest>()
const requestHandlersByChannel = new Map<
  string,
  (payload: string) => void | Promise<void>
>()

let multiplexerPromise: Promise<void> | null = null
let multiplexerListenersInstalled = false

/**
 * Injectable transport for tests. When set, these override the real Redis
 * client calls. Default undefined → real redis is used. Production must
 * not set this; only the unit tests in outbound-router.test.ts do.
 */
interface TransportOverride {
  psubscribe?: (pattern: string) => Promise<void>
  subscribe?: (channel: string) => Promise<void>
  unsubscribe?: (channel: string) => Promise<void>
  publish?: (channel: string, payload: string) => Promise<unknown>
}
let transportOverride: TransportOverride | undefined

function safeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function pmessageDispatcher(
  _pattern: string,
  channel: string,
  payload: string
): void {
  try {
    const requestId = channel.slice(RESPONSE_CHANNEL_PREFIX.length)
    const wire = JSON.parse(payload) as WireResponse
    const pending = pendingRequests.get(requestId)
    if (!pending) return
    if (wire.ok) {
      pending.resolve(wire.raw)
    } else {
      pending.reject(new Error(wire.error || "wecom remote error"))
    }
    // resolve/reject self-cleanup (delete entry + clear timer)
  } catch (err) {
    log.warn({ err }, "[wecom] response parse failed")
  }
}

function messageDispatcher(channel: string, payload: string): void {
  const handler = requestHandlersByChannel.get(channel)
  if (!handler) return
  try {
    const result = handler(payload)
    if (result && typeof (result as Promise<void>).catch === "function") {
      ;(result as Promise<void>).catch((err: unknown) =>
        log.warn({ err }, "[wecom] request handler rejected")
      )
    }
  } catch (err) {
    log.warn({ err }, "[wecom] request handler threw")
  }
}

/**
 * Lazily initialize the process-wide Redis dispatchers.
 *
 *   - `redisSub.on(...)` listeners are installed once per process (the
 *     `multiplexerListenersInstalled` flag), never removed. On a retry
 *     after a failed `psubscribe()` we MUST NOT re-add them, otherwise
 *     each retry doubles dispatch and the `'message'` callback fires N
 *     times per inbound request.
 *   - `multiplexerPromise` is cleared back to `null` if `psubscribe()`
 *     rejects, so callers' next attempt re-triggers the call instead of
 *     handing back a cached rejection. Without this, a single Redis blip
 *     during startup would poison every future dispatch until process
 *     restart.
 *   - When a `transportOverride` is set (test path), real `redisSub.on(...)`
 *     calls are skipped entirely. That keeps unit tests from
 *     materializing the lazy ioredis client + opening a Redis socket
 *     just to register listeners that the tests don't drive through
 *     anyway (test paths invoke handlers directly via
 *     `_internals.requestHandlersByChannel` or via the override's
 *     `psubscribe / subscribe / publish` callbacks).
 */
export function ensureMultiplexer(): Promise<void> {
  if (multiplexerPromise) return multiplexerPromise
  const attempt = (async () => {
    const usingOverride = transportOverride !== undefined
    if (!usingOverride && !multiplexerListenersInstalled) {
      redisSub.on("pmessage", pmessageDispatcher)
      redisSub.on("message", messageDispatcher)
      multiplexerListenersInstalled = true
    }
    const psub =
      transportOverride?.psubscribe ??
      ((pattern: string) => redisSub.psubscribe(pattern))
    await psub(RESPONSE_PATTERN)
  })()
  multiplexerPromise = attempt
  attempt.catch(() => {
    // Reset on failure so the next caller retries from scratch. Listeners
    // are intentionally NOT removed (the guard flag stays true).
    if (multiplexerPromise === attempt) {
      multiplexerPromise = null
    }
  })
  return attempt
}

export function registerHolder(accountId: string, client: WecomClient): void {
  holders.set(accountId, client)
}

export function unregisterHolder(accountId: string): void {
  holders.delete(accountId)
}

export function isHolderLocally(accountId: string): boolean {
  return holders.has(accountId)
}

/**
 * Holder-side subscription. ORDER MATTERS:
 *   1. ensureMultiplexer() — install message dispatcher first
 *   2. set handler in requestHandlersByChannel — so dispatcher can route
 *   3. redisSub.subscribe(channel) — only now turn the channel on
 *
 * If `subscribe()` rejects the handler MUST be removed before re-throw,
 * otherwise it stays in `requestHandlersByChannel` indefinitely and a
 * later message on the channel (if some other replica subscribed) would
 * route into a stale closure that doesn't have a real subscription.
 *
 * The handler looks up the WSClient via `holders.get(accountId)` at
 * dispatch time rather than capturing it via closure. This lets
 * `startWecomAccount` swap the underlying client (e.g. after a
 * disconnected_event server-kick rebuild) by overwriting the entry in
 * `holders` — no resubscribe needed.
 */
export async function subscribeAccountInboundChannel(
  accountId: string
): Promise<void> {
  await ensureMultiplexer()
  const channel = REQUEST_CHANNEL_PREFIX + accountId
  requestHandlersByChannel.set(channel, async (rawPayload: string) => {
    let req: WireRequest
    try {
      req = JSON.parse(rawPayload) as WireRequest
    } catch (err) {
      log.warn({ err }, "[wecom] request payload parse failed")
      return
    }
    const { requestId, frameBody } = req
    if (!requestId || !frameBody) {
      log.warn("[wecom] request payload missing requestId/frameBody")
      return
    }
    const pub =
      transportOverride?.publish ??
      ((ch: string, p: string) => redisPub.publish(ch, p))
    const client = holders.get(accountId)
    if (!client) {
      // Holder was unregistered between dispatch and handler invocation
      // (e.g. account stopped, or rebuild in progress). Surface the error
      // to the requester so the delivery job fails fast instead of hanging.
      const response: WireResponse = {
        ok: false,
        error: `wecom holder for account ${accountId} not registered`,
      }
      await pub(
        RESPONSE_CHANNEL_PREFIX + requestId,
        JSON.stringify(response)
      ).catch((err: unknown) =>
        log.warn({ err }, "[wecom] response publish failed")
      )
      return
    }
    try {
      const result = await client.sendMessage(frameBody.chatid, frameBody.body)
      const response: WireResponse = { ok: true, raw: result }
      await pub(RESPONSE_CHANNEL_PREFIX + requestId, JSON.stringify(response))
    } catch (err) {
      const response: WireResponse = {
        ok: false,
        error: safeErrorMessage(err),
      }
      await pub(RESPONSE_CHANNEL_PREFIX + requestId, JSON.stringify(response))
    }
  })
  const sub =
    transportOverride?.subscribe ?? ((ch: string) => redisSub.subscribe(ch))
  try {
    await sub(channel)
  } catch (err) {
    // Subscribe failed — clean up the handler so a future retry can
    // re-install fresh state and we don't leak a stale handler.
    requestHandlersByChannel.delete(channel)
    throw err
  }
}

export async function unsubscribeAccountInboundChannel(
  accountId: string
): Promise<void> {
  const channel = REQUEST_CHANNEL_PREFIX + accountId
  const unsub =
    transportOverride?.unsubscribe ?? ((ch: string) => redisSub.unsubscribe(ch))
  try {
    await unsub(channel)
  } finally {
    requestHandlersByChannel.delete(channel)
  }
}

export interface DispatchOutboundInput {
  accountId: string
  frameBody: FrameBody
  /** Override the 5s default — tests use a tiny timeout to assert behavior. */
  timeoutMs?: number
  /**
   * Test-only: skip the `redisPub.publish(...)` call so the pending entry
   * stays registered until a test directly resolves/rejects it via
   * `_internals.pendingRequests`. Has no production caller.
   */
  skipPublishForTests?: boolean
}

/**
 * Send a WeCom outbound frame to the account's WS holder, wherever it
 * lives in the cluster. Returns the bare WsFrame produced by SDK
 * `sendMessage(...)`.
 *
 * Local-holder optimization short-circuits Redis. Remote path registers
 * the pending entry BEFORE publish so a fast response cannot race ahead.
 *
 * If `redisPub.publish(...)` itself rejects we must call the pending's
 * `wrappedReject(...)` (which knows how to clean up the entry + timer
 * atomically) rather than doing the cleanup inline. Cleaning up inline
 * first and THEN calling `wrappedReject` would defeat wrappedReject's
 * internal idempotency check — it would see the entry already deleted
 * and silently return without calling the real `reject`, leaving the
 * dispatch promise pending forever.
 */
export async function dispatchOutbound(
  input: DispatchOutboundInput
): Promise<WsFrame> {
  const localClient = holders.get(input.accountId)
  if (localClient) {
    return localClient.sendMessage(input.frameBody.chatid, input.frameBody.body)
  }
  await ensureMultiplexer()
  const requestId = randomUUID()
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const wirePayload = JSON.stringify({
    requestId,
    frameBody: input.frameBody,
  } satisfies WireRequest)
  return new Promise<WsFrame>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId)
      reject(
        new Error(
          `wecom outbound timeout — holder replica unreachable after ${timeoutMs}ms`
        )
      )
    }, timeoutMs)
    // Wrap resolve/reject so any caller (dispatcher or test) automatically
    // cleans up the pending entry + timer when they fire. This makes
    // resolving the pending entry idempotent w.r.t. the bookkeeping
    // invariants — there's exactly one place that owns cleanup.
    const wrappedResolve = (frame: WsFrame) => {
      if (!pendingRequests.delete(requestId)) return
      clearTimeout(timer)
      resolve(frame)
    }
    const wrappedReject = (err: Error) => {
      if (!pendingRequests.delete(requestId)) return
      clearTimeout(timer)
      reject(err)
    }
    pendingRequests.set(requestId, {
      resolve: wrappedResolve,
      reject: wrappedReject,
      timer,
    })
    // Tests may set `skipPublishForTests` to drive the pending map
    // directly without invoking real Redis publish.
    if (input.skipPublishForTests) return
    const pub =
      transportOverride?.publish ??
      ((ch: string, p: string) => redisPub.publish(ch, p))
    pub(REQUEST_CHANNEL_PREFIX + input.accountId, wirePayload).catch(
      (err: unknown) => {
        const pending = pendingRequests.get(requestId)
        if (!pending) return
        // Delegate cleanup to wrappedReject — do NOT pre-delete here.
        pending.reject(
          new Error(`wecom publish failed: ${safeErrorMessage(err)}`)
        )
      }
    )
  })
}

/** Test-only helpers — exported behind an underscore convention. */
export const _internals = {
  holders,
  pendingRequests,
  requestHandlersByChannel,
  resetForTests() {
    holders.clear()
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer)
    }
    pendingRequests.clear()
    requestHandlersByChannel.clear()
    multiplexerPromise = null
    transportOverride = undefined
    // multiplexerListenersInstalled intentionally NOT reset — real
    // listeners on `redisSub` are sticky and shared with other tests.
  },
  /**
   * Skip the real `ensureMultiplexer()` Redis init by short-circuiting it
   * to a resolved no-op. Lets unit tests exercise the requester pending /
   * timeout / cleanup logic without standing up a real Redis. Production
   * code must NEVER call this.
   */
  bypassMultiplexerForTests() {
    multiplexerPromise = Promise.resolve()
  },
  /**
   * Override Redis client calls used by ensureMultiplexer /
   * subscribeAccountInboundChannel / dispatchOutbound. Allows unit tests
   * to inject failures and confirm recovery semantics without standing
   * up a real Redis. Setting `transportOverride = undefined` (the default
   * after `resetForTests()`) restores the real `redisSub`/`redisPub`.
   */
  setTransportOverrideForTests(override: TransportOverride | undefined) {
    transportOverride = override
  },
  /**
   * Force the multiplexer init to re-run on the next call by clearing the
   * cached promise. Tests use this to verify retry-after-failure recovery.
   */
  clearMultiplexerForTests() {
    multiplexerPromise = null
  },
}
