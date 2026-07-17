import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Per-turn W3C `{traceparent, tracestate?}` carrier for the remote-agent
 * daemon.
 *
 * The api injects a trace carrier into each api→daemon WS message
 * (agent:start / agent:task:resolved at the frame level, agent:deliver
 * per-delivery — see remote-agents/wire.ts). The daemon runs the message
 * handler inside this AsyncLocalStorage so its outbound api callbacks
 * (api-client.ts requestJson) and its log lines (index.ts log()) rejoin the
 * SAME distributed trace as the request that caused the turn.
 *
 * A lightweight string-carrier ALS — the daemon is an independently-published,
 * npm-shrinkwrapped bin that deliberately carries NO OpenTelemetry SDK and no
 * `@synapse/shared` dependency (it cannot reach the central collector anyway;
 * every daemon action is mirrored by a spannable api call). It only PROPAGATES
 * the W3C carrier it is handed. Mirrors
 * packages/device-runtime/src/trace-context.ts.
 */

/** The `{traceparent, tracestate?}` pair carried on daemon WS/HTTP hops. */
export type TraceCarrier = {
  traceparent: string
  tracestate?: string
}

/**
 * Strict version-00 traceparent — a sanctioned LITERAL DUPLICATE of the
 * canonical artifact `packages/shared/src/utils/traceparent.ts` (the daemon is
 * an independently published bin with no `@synapse/shared` dependency; it is
 * listed in that file's JSDoc sync list — any change there must be mirrored
 * byte-for-byte here). All-zero trace-id / span-id are rejected per W3C
 * trace-context §3.2. A valid value is exactly 55 characters.
 */
export const TRACEPARENT_RE =
  /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/

/**
 * Uniform cap on a serialized `tracestate` header (W3C trace-context §3.3.1's
 * smallest MUST-support size; same value as the canonical artifact). An
 * oversized value degrades to absent — never rejects the frame it rides on.
 */
export const MAX_TRACESTATE_LENGTH = 1024

/** True iff `value` is a strict version-00 traceparent (see TRACEPARENT_RE). */
export function isValidTraceparent(value: unknown): value is string {
  return typeof value === "string" && TRACEPARENT_RE.test(value)
}

/**
 * The 32-hex trace-id of a valid traceparent (chars 3..35), or undefined for
 * anything malformed. Used to group per-delivery carriers by originating
 * trace (carrier scope resolution / origin_carriers dedupe).
 */
export function traceIdOf(traceparent: string): string | undefined {
  return TRACEPARENT_RE.test(traceparent) ? traceparent.slice(3, 35) : undefined
}

/**
 * Explicit no-carrier sentinel stored by {@link runWithoutCarrier}. Distinct
 * from an absent store entry: it MASKS any enclosing carrier scope, and
 * `getCarrier()`/`getTraceparent()` map it to undefined.
 */
const NO_CARRIER = Symbol("no-carrier")

const store = new AsyncLocalStorage<TraceCarrier | typeof NO_CARRIER>()

/** Run `fn` with `carrier` as the active daemon trace context. */
export function runWithCarrier<T>(
  carrier: TraceCarrier | undefined,
  fn: () => T
): T {
  return carrier ? store.run(carrier, fn) : fn()
}

/**
 * Run `fn` with NO active trace carrier, masking any enclosing carrier scope
 * (unlike `runWithCarrier(undefined, fn)`, which is a plain call-through that
 * leaves the ambient scope visible). For outbound calls that must NOT inherit
 * a single origin's trace — the mixed-origin fail-deliveries report (§4.C):
 * the POST then carries no traceparent header, so the api creates a fresh
 * root with per-delivery links instead of parenting under one origin.
 */
export function runWithoutCarrier<T>(fn: () => T): T {
  return store.run(NO_CARRIER, fn)
}

/** The active turn's W3C trace carrier, if any. */
export function getCarrier(): TraceCarrier | undefined {
  const value = store.getStore()
  return value === NO_CARRIER ? undefined : value
}

/** The active turn's W3C traceparent, if any. */
export function getTraceparent(): string | undefined {
  return getCarrier()?.traceparent
}

/**
 * The active turn's `{traceparent, tracestate?}` as spreadable wire fields for
 * the daemon→api machine messages (`ready` / `runtime:catalog` /
 * `agent:session` / `agent:status` — never heartbeat), so the api's
 * per-message SERVER spans parent to the trace that drove the send. Empty
 * (fields absent) outside any carrier scope. Lives here (not index.ts) so the
 * stamping is unit-testable — the daemon entrypoint cannot be imported.
 */
export function activeWireTraceFields(): {
  traceparent?: string
  tracestate?: string
} {
  const carrier = getCarrier()
  if (!carrier) return {}
  return carrier.tracestate
    ? { traceparent: carrier.traceparent, tracestate: carrier.tracestate }
    : { traceparent: carrier.traceparent }
}
