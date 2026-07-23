"use client"

import * as Sentry from "@sentry/nextjs"
import { isValidTraceparent, traceIdFromTraceparent } from "@synapse/shared"

// Client-trace helpers (web). The one rule: a client carrier's span id must come
// from a Span object the SDK actually created, and no Sentry client means no
// carrier at all. Never `Sentry.getTraceData()`, whose scope fallback fabricates
// a fresh random span id per call that disagrees with its own sibling
// sentry-trace (the F10 defect these helpers exist to eliminate).

/**
 * Build a W3C traceparent from a span's context, or undefined if the ids are
 * not canonical. Flags mirror the REAL sampling decision (`traceFlags & 1`) —
 * @sentry/nextjs does not re-export `spanIsSampled`, so the bit comes straight
 * off `spanContext()`. The assembled value is validated with the canonical
 * `isValidTraceparent` (no second regex), which also rejects an all-zero id.
 */
function carrierOf(spanContext: {
  traceId: string
  spanId: string
  traceFlags: number
}): string | undefined {
  const flags = (spanContext.traceFlags & 1) === 1 ? "01" : "00"
  const candidate = `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`
  return isValidTraceparent(candidate) ? candidate : undefined
}

/**
 * Run `fn` inside a short client span named `name` (op `op`) and hand it the
 * span's carrier. When no Sentry client is configured, `fn(undefined)` runs with
 * NO span started — the gate is mandatory because `Sentry.startSpan` still hands
 * back a span with plausible-looking random ids when uninitialized, which is
 * exactly where the fix must stamp nothing. With a client and no active span the
 * span is a ROOT that inherits the scope's page-level trace id; nested under an
 * active span it is a true child. At `tracesSampleRate: 0` the id is still a real
 * span object's id (flags `00`, nothing exported).
 */
export function withClientSpan<T>(
  name: string,
  op: string,
  fn: (carrier: string | undefined) => T
): T {
  if (!Sentry.getClient()) return fn(undefined)
  return Sentry.startSpan({ name, op }, (span) =>
    fn(carrierOf(span.spanContext()))
  )
}

/**
 * The current client trace id for log correlation: the active span's trace id,
 * else the scope's propagation-context trace id, else undefined when there is no
 * Sentry client. Validated + extracted through the canonical
 * `traceIdFromTraceparent` (no second regex; a throwaway nonzero span id only
 * reuses the gate), so an all-zero / non-canonical id degrades to undefined.
 */
export function currentClientTraceId(): string | undefined {
  if (!Sentry.getClient()) return undefined
  const active = Sentry.getActiveSpan()
  const traceId = active
    ? active.spanContext().traceId
    : Sentry.getCurrentScope().getPropagationContext().traceId
  if (!traceId) return undefined
  return traceIdFromTraceparent(`00-${traceId}-0000000000000001-00`)
}
