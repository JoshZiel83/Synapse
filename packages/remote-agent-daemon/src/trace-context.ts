import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Per-turn W3C `traceparent` carrier for the remote-agent daemon.
 *
 * The api injects a `traceparent` into each api→daemon WS message (agent:start /
 * agent:task:resolved at the frame level, agent:deliver per-delivery — see
 * remote-agents/wire.ts). The daemon runs the message handler inside this
 * AsyncLocalStorage so its outbound api callbacks (api-client.ts requestJson)
 * and its log lines (index.ts log()) rejoin the SAME distributed trace as the
 * request that caused the turn.
 *
 * A lightweight string-only carrier — the daemon is an independently-published,
 * npm-shrinkwrapped, zero-runtime-dep bin, so it deliberately carries NO
 * OpenTelemetry SDK (it cannot reach the central collector anyway). It only
 * PROPAGATES the W3C traceparent it is handed. Mirrors
 * packages/device-runtime/src/trace-context.ts.
 */
const store = new AsyncLocalStorage<string>()

/** Run `fn` with `traceparent` as the active daemon trace context. */
export function runWithTraceparent<T>(
  traceparent: string | undefined,
  fn: () => T
): T {
  return traceparent ? store.run(traceparent, fn) : fn()
}

/** The active turn's W3C traceparent, if any. */
export function getTraceparent(): string | undefined {
  return store.getStore()
}
