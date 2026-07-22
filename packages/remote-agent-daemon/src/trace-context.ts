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

// ─── synapse-trace-contract v2 (sanctioned literal duplicate) ───────────────
//
// Canonical artifact: packages/shared/src/utils/traceparent.ts. The daemon is
// an independently published bin with NO `@synapse/shared` dependency, so the
// carrier gate is re-declared here. scripts/guard-trace-propagation.mjs (rule
// carrier_contract_drift) byte-compares every NAME below against the canonical
// file AND against this file's real code, so drift fails CI; the shared golden
// vectors (traceparent-vectors.json) are asserted from this file's tests too.
// Mirror any change to the canonical file here, byte-for-byte:
//
//   TRACEPARENT_RE = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/
//   MAX_TRACESTATE_LENGTH = 512
//   MAX_TRACESTATE_MEMBERS = 32
//   TRACESTATE_KEY_RE = /^[a-z0-9][a-z0-9_\-*/@]{0,255}$/
//   TRACESTATE_VALUE_RE = /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/
//
// TRACEPARENT_RE: strict version-00, all-zero trace-id/span-id rejected per W3C
// §3.2 (a valid value is exactly 55 chars). 512 is OTel-JS core's
// MAX_TRACE_STATE_LEN and the W3C §3.3.1 MUST-propagate floor; TRACESTATE_KEY_RE
// is the W3C **Level 2** key grammar (`@` a plain keychar). Receiver rule: a
// malformed value degrades to ABSENT — it never rejects the frame it rides on.
export const TRACEPARENT_RE =
  /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/
export const MAX_TRACESTATE_LENGTH = 512
export const MAX_TRACESTATE_MEMBERS = 32
const TRACESTATE_KEY_RE = /^[a-z0-9][a-z0-9_\-*/@]{0,255}$/
const TRACESTATE_VALUE_RE =
  /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/
const MEMBER_OWS_RE = /^[ \t]+|[ \t]+$/g

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
 * THE tracestate gate — byte-identical to the canonical
 * `sanitizeTracestateHeader`: whole-or-nothing W3C Level-2 validation (≤512
 * chars, key/value ABNF, no duplicate keys, ≤32 non-empty members). Returns
 * `raw` verbatim when clean, `undefined` on any defect (partial salvage is the
 * corruption vector). Empty/OWS-only members are spec-valid and not counted.
 */
export function sanitizeTracestateHeader(raw: string): string | undefined {
  if (raw.length > MAX_TRACESTATE_LENGTH) return undefined
  const seen = new Set<string>()
  let nonEmpty = 0
  for (const member of raw.split(",")) {
    const m = member.replace(MEMBER_OWS_RE, "")
    if (m === "") continue
    const eq = m.indexOf("=")
    if (eq === -1) return undefined
    const key = m.slice(0, eq)
    if (
      !TRACESTATE_KEY_RE.test(key) ||
      !TRACESTATE_VALUE_RE.test(m.slice(eq + 1))
    ) {
      return undefined
    }
    if (seen.has(key)) return undefined
    seen.add(key)
    nonEmpty += 1
    if (nonEmpty > MAX_TRACESTATE_MEMBERS) return undefined
  }
  return nonEmpty > 0 ? raw : undefined
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
