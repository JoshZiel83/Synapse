/**
 * WeCom (Enterprise WeChat) AI-Bot inbound lifecycle.
 *
 * Owns the WSClient instance for a single transport_accounts row and ties
 * its lifecycle to the IM runtime contract:
 *   - Construct + wire all SDK events
 *   - connect() and await first 'authenticated' frame within 30s
 *   - On auth failure: actively `disconnect()` to stop SDK's background
 *     reconnect loop, then throw so runtime catches and reconcile retries
 *   - On success: subscribe to the cross-replica request channel, THEN
 *     register as local holder (so a remote replica that reads the
 *     holders map can be sure the request channel is already live)
 *   - On stop: try/finally guarantees `client.disconnect()` regardless of
 *     unsubscribe errors — otherwise the SDK's auto-reconnect would
 *     leave an orphan client running in the background
 *
 * **Server-side kick (`event.disconnected_event`)** is special: the SDK
 * sets `isManualClose = true` and DOES NOT auto-reconnect (see
 * `@wecom/aibot-node-sdk`'s `scheduleReconnect()`). We must rebuild the
 * SDK client ourselves — `disconnect()` the dead one, construct a fresh
 * `WSClient`, re-auth, and swap it into the `holders` map. The
 * outbound-router's request handler reads the holders entry dynamically
 * at dispatch time, so the swap is transparent to in-flight outbound
 * requests (a dispatch that races the swap window fast-fails with
 * "holder not registered" rather than hanging).
 *
 * **Cancellation:** `waitForAuth` and rebuild backoff both race
 * `ctx.signal`. When `runtime.ts` aborts (account disabled, config
 * change, process shutdown) the lease release path doesn't get stuck for
 * up to 60s waiting on an auth timeout + backoff to elapse naturally.
 *
 * **Stale-client guard:** Each SDK client's event listeners capture the
 * specific `WSClient` instance they were attached to. If the connector
 * has already swapped to a new client (rebuild completed) or has
 * stopped, listeners on the old client become no-ops. This prevents a
 * stale event (deliberate or accidental) on the old client from
 * triggering a duplicate rebuild that would unregister the currently
 * healthy holder.
 *
 * Other disconnects (`'disconnected'` for transient WS close,
 * `'reconnecting'`) are SDK-managed: we trust the SDK's exponential
 * backoff (`maxReconnectAttempts: -1`) and only log.
 */

import { setTimeout as delay } from "node:timers/promises"
import type { AccountStartContext, RunningAccount } from "../types.js"
import {
  createWecomClient,
  waitForAuthenticated,
  type WecomClient,
} from "./client.js"
import {
  extractWecomConfig,
  getWecomCredentialsOrThrow,
  type WecomConfig,
  type WecomCredentials,
} from "./credentials.js"
import { normalizeWecomFrame } from "./normalize.js"
import {
  registerHolder,
  subscribeAccountInboundChannel,
  unregisterHolder,
  unsubscribeAccountInboundChannel,
} from "./outbound-router.js"

const AUTH_TIMEOUT_MS = 30_000
const DEFAULT_REBUILD_BACKOFF_MS = 30_000

/**
 * Injectable deps for unit-testing `startWecomAccount` in isolation
 * without a real WSClient or Redis. Production callers pass nothing and
 * get `defaultWecomLifecycleDeps`.
 */
export interface WecomLifecycleDeps {
  createClient: (input: {
    credentials: WecomCredentials
    config?: WecomConfig
  }) => WecomClient
  waitForAuth: (
    client: WecomClient,
    timeoutMs: number,
    signal?: AbortSignal
  ) => Promise<void>
  registerHolder: (accountId: string, client: WecomClient) => void
  unregisterHolder: (accountId: string) => void
  subscribeAccountInboundChannel: (accountId: string) => Promise<void>
  unsubscribeAccountInboundChannel: (accountId: string) => Promise<void>
  /** Delay between failed rebuild attempts. Tests use a small value. */
  rebuildBackoffMs?: number
  /**
   * Cancellable sleep. Tests can inject an instant resolver. Production
   * uses `node:timers/promises#setTimeout` which natively supports
   * `{ signal }` to abort the wait.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export const defaultWecomLifecycleDeps: WecomLifecycleDeps = {
  createClient: (input) => createWecomClient(input),
  waitForAuth: (client, timeoutMs, signal) =>
    waitForAuthenticated(client, timeoutMs, { signal }),
  registerHolder,
  unregisterHolder,
  subscribeAccountInboundChannel,
  unsubscribeAccountInboundChannel,
  rebuildBackoffMs: DEFAULT_REBUILD_BACKOFF_MS,
  sleep: (ms, signal) => delay(ms, undefined, { signal }),
}

export function makeStartWecomAccount(
  deps: WecomLifecycleDeps = defaultWecomLifecycleDeps
) {
  return async function startWecomAccount(
    ctx: AccountStartContext
  ): Promise<RunningAccount> {
    const credentials = getWecomCredentialsOrThrow(ctx.account)
    const config = extractWecomConfig(ctx.account.config)
    const logger = ctx.logger
    const accountId = ctx.account.id
    const backoffMs = deps.rebuildBackoffMs ?? DEFAULT_REBUILD_BACKOFF_MS
    const sleep =
      deps.sleep ??
      ((ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }))

    let stopped = false
    let currentClient: WecomClient | null = null
    let rebuildPromise: Promise<void> | null = null

    /**
     * Attach listeners to a freshly-created SDK client. Each listener
     * closes over the specific `client` instance it was attached to and
     * verifies the connector still considers that client active before
     * doing anything that mutates connector state. A stale client whose
     * listener fires after a rebuild (or after stop()) becomes a no-op.
     */
    const attachListeners = (client: WecomClient) => {
      const isActive = () => client === currentClient && !stopped
      client.on("message", (frame) => {
        if (!isActive()) {
          // Drop messages from a stale client. The new client (if any)
          // will receive its own copies from the WeCom server's
          // dedupe-by-msgid contract is honored upstream in ingest.ts.
          return
        }
        try {
          const envelope = normalizeWecomFrame(frame)
          if (!envelope) return
          void ctx.emitInbound(envelope).catch((err: unknown) => {
            logger.error("wecom inbound emit failed", err)
          })
        } catch (err) {
          logger.error("wecom inbound normalize failed", err)
        }
      })
      client.on("event", (frame) => {
        const eventType = frame.body?.event?.eventtype
        if (eventType === "disconnected_event") {
          if (!isActive()) {
            // Stale or stopped — do NOT trigger another rebuild that
            // would unregister the healthy current holder.
            logger.debug(
              "wecom disconnected_event from stale/stopped client, ignoring"
            )
            return
          }
          logger.warn(
            "wecom server-side disconnect (kicked by new connection), rebuilding"
          )
          if (!rebuildPromise) {
            rebuildPromise = runRebuildLoop().finally(() => {
              rebuildPromise = null
            })
          }
          return
        }
        if (!isActive()) return
        logger.info("wecom event", {
          eventType,
          msgid: frame.body?.msgid,
        })
      })
      client.on("disconnected", (reason: string) => {
        if (!isActive()) return
        logger.warn("wecom disconnected", { reason })
      })
      client.on("reconnecting", (attempt: number) => {
        if (!isActive()) return
        logger.info("wecom reconnecting", { attempt })
      })
      client.on("error", (err: Error) => {
        if (!isActive()) return
        logger.error("wecom error", err)
      })
    }

    const buildAndAuth = async (): Promise<WecomClient> => {
      const client = deps.createClient({ credentials, config })
      attachListeners(client)
      client.connect()
      try {
        await deps.waitForAuth(client, AUTH_TIMEOUT_MS, ctx.signal)
      } catch (err) {
        // Prevent the SDK's background reconnect loop from running an
        // orphan client after we surface the failure.
        client.disconnect()
        throw err
      }
      return client
    }

    /**
     * Run after `event.disconnected_event`. Discards the dead client,
     * unregisters the holder so concurrent dispatches fast-fail rather
     * than dispatching to a doomed client, then rebuilds. Retries with
     * a fixed backoff until success or stop().
     *
     * `stop()` aborts `ctx.signal`, which propagates into `waitForAuth`
     * and `sleep` so the loop unblocks promptly instead of waiting up
     * to AUTH_TIMEOUT_MS + backoffMs.
     */
    const runRebuildLoop = async (): Promise<void> => {
      while (!stopped) {
        // Unregister BEFORE disconnecting old client so any in-flight
        // dispatch sees the missing holder and gets a clean
        // "holder not registered" error instead of a torn-down client.
        deps.unregisterHolder(accountId)
        const old = currentClient
        currentClient = null
        try {
          old?.disconnect()
        } catch (err) {
          logger.warn("wecom old client disconnect threw during rebuild", {
            err: err instanceof Error ? err.message : String(err),
          })
        }
        try {
          const next = await buildAndAuth()
          if (stopped) {
            next.disconnect()
            return
          }
          currentClient = next
          deps.registerHolder(accountId, next)
          logger.info("wecom client rebuilt successfully after server-kick")
          return
        } catch (err) {
          if (stopped || ctx.signal.aborted) {
            logger.debug("wecom rebuild aborted by stop()", {
              err: err instanceof Error ? err.message : String(err),
            })
            return
          }
          logger.error("wecom rebuild attempt failed, will retry", err)
          try {
            await sleep(backoffMs, ctx.signal)
          } catch {
            // Sleep aborted by stop() — exit loop.
            return
          }
        }
      }
    }

    // ─── Initial start ─────────────────────────────────────────────
    currentClient = await buildAndAuth()
    try {
      await deps.subscribeAccountInboundChannel(accountId)
    } catch (err) {
      currentClient.disconnect()
      currentClient = null
      throw err
    }
    deps.registerHolder(accountId, currentClient)

    return {
      async stop() {
        stopped = true
        deps.unregisterHolder(accountId)
        try {
          await deps.unsubscribeAccountInboundChannel(accountId)
        } finally {
          // finally: even if unsubscribe throws, the SDK client must be
          // closed — otherwise its background reconnect loop will linger.
          currentClient?.disconnect()
        }
        // Wait for any in-flight rebuild to bail. The loop and its
        // internal waits all race ctx.signal, so this returns within
        // a microtask of ctx.signal being aborted (which runtime.ts
        // does immediately before invoking our stop()). If a caller
        // somehow invokes stop() without an aborted ctx.signal first,
        // the `stopped` flag still terminates the loop at the next
        // iteration boundary, but per-attempt waits may still elapse.
        if (rebuildPromise) {
          await rebuildPromise.catch(() => undefined)
        }
      },
    }
  }
}

export const startWecomAccount = makeStartWecomAccount()
