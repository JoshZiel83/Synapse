import {
  getActiveSpan,
  getClient,
  getCurrentScope,
  startSpan,
} from "@sentry/react-native"
import { isValidTraceparent, traceIdFromTraceparent } from "@shared"

// Client-trace helpers (React Native). Byte-for-byte behavioural mirror of the
// web module (packages/web-next/lib/client-trace.ts) against @sentry/react-native
// 7.13.0, which re-exports startSpan / getActiveSpan / getCurrentScope / getClient
// but NOT getTraceData (so there is no scope-fallback fabrication to guard) and
// NOT isEnabled (so getClient() is the shared gate). A carrier's span id always
// comes from a Span the SDK created; no client ⇒ no carrier.

/**
 * Build a W3C traceparent from a span's context, or undefined if the ids are
 * not canonical. Flags mirror the real sampling decision (`traceFlags & 1`, read
 * off `spanContext()` — present on both SentrySpan and SentryNonRecordingSpan in
 * the installed @sentry/core 10.38.0). Validated with the canonical
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
 * NO span started — mandatory, because `startSpan` still hands back a span with
 * random ids when uninitialized. With a client and no active span the span is a
 * ROOT that inherits the scope's trace id; nested under an active span it is a
 * true child; at `tracesSampleRate: 0` the id is still a real span object's id.
 */
export function withClientSpan<T>(
  name: string,
  op: string,
  fn: (carrier: string | undefined) => T
): T {
  if (!getClient()) return fn(undefined)
  return startSpan({ name, op }, (span) => fn(carrierOf(span.spanContext())))
}

/**
 * The current client trace id for log correlation: the active span's trace id,
 * else the scope's propagation-context trace id, else undefined without a client.
 * Validated + extracted through the canonical `traceIdFromTraceparent` (no second
 * regex), so an all-zero / non-canonical id degrades to undefined.
 */
export function currentClientTraceId(): string | undefined {
  if (!getClient()) return undefined
  const active = getActiveSpan()
  const traceId = active
    ? active.spanContext().traceId
    : getCurrentScope().getPropagationContext().traceId
  if (!traceId) return undefined
  return traceIdFromTraceparent(`00-${traceId}-0000000000000001-00`)
}
