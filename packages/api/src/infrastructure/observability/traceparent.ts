import { isSpanContextValid, trace } from "@opentelemetry/api"

/**
 * W3C `traceparent` string for the active OTel span, or `undefined` when there
 * is no valid active span (OTEL disabled, or called outside any span).
 *
 * Used to thread the api's trace context across boundaries that OTel does NOT
 * auto-instrument, so the downstream spans continue this trace (P7):
 *   - the device dispatch fetch — `modules/devices/dispatch.ts`
 *   - the one-shot fs-helper stdio driver — `modules/sandbox/materialize.ts`
 *
 * Single source of truth: both call sites import this rather than re-deriving
 * the format, so the wire encoding stays identical across every hop.
 */
export function activeTraceparent(): string | undefined {
  const sc = trace.getActiveSpan()?.spanContext()
  if (!sc || !isSpanContextValid(sc)) return undefined
  const flags = sc.traceFlags.toString(16).padStart(2, "0")
  return `00-${sc.traceId}-${sc.spanId}-${flags}`
}
