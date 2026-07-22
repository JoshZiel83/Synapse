import {
  defaultTextMapGetter,
  isSpanContextValid,
  propagation,
  trace,
  type Context,
  type TextMapPropagator,
  type TraceState,
} from "@opentelemetry/api"
import {
  isValidTraceparent,
  sanitizeTracestateHeader,
  TRACEPARENT_RE,
  tracestateKeys,
  type TraceCarrier,
} from "@synapse/shared"

/**
 * Canonical trace-context minting + tracestate sanitization for MANUAL
 * carriers (docs/trace-propagation-policy.md, "Carrier contract") — the hops
 * that do not ride HTTP auto-instrumentation: MCP `_meta`, JSON-RPC frames,
 * daemon WS messages, BullMQ `__otelctx`, WS envelopes, stdio drivers. NB
 * undici DOES auto-instrument every fetch, device dispatch included — dispatch
 * suppresses its auto span deliberately and threads the carrier by hand.
 *
 * Every manual carrier is minted HERE (`activeTraceCarrier`) or via a dedicated
 * `W3CTraceContextPropagator` instance — never the global propagator, which
 * under Sentry would serialize sentry-trace/baggage into message payloads and
 * Redis (the anti-PII precedent set by workers/job-tracing.ts).
 *
 * The tracestate GATE (`sanitizeTracestateHeader`) and traceparent regex are
 * the single in-repo artifact in `@synapse/shared`; this file re-exports them
 * so api-side receivers import from here. It adds only the OTel-typed pieces:
 * the Sentry key stripping, `active*` minting, and the stage-3 salvage detector
 * `extractTraceCarrierContext`.
 */
export { isValidTraceparent, sanitizeTracestateHeader, TRACEPARENT_RE }

/**
 * W3C `traceparent` string for the active OTel span, or `undefined` when there
 * is no valid active span (OTEL disabled, or called outside any span).
 */
export function activeTraceparent(): string | undefined {
  const sc = trace.getActiveSpan()?.spanContext()
  if (!sc || !isSpanContextValid(sc)) return undefined
  const flags = sc.traceFlags.toString(16).padStart(2, "0")
  return `00-${sc.traceId}-${sc.spanId}-${flags}`
}

/**
 * Sentry's non-W3C TraceState keys, verified against installed
 * `@sentry/opentelemetry` 10.58.0 (`SENTRY_TRACE_STATE_*` constants; guarded by
 * the canary in first-party-propagator.test.ts). Grammar-invalid tracestate per
 * W3C trace-context §3.3.2: the keys contain `.` and `sentry.dsc` values embed
 * `=`/`,` — a compliant receiver re-parses them into junk top-level vendor keys
 * (docs/trace-propagation-policy.md, "The Sentry tracestate rule"), so they
 * must never serialize onto any wire. Sentry DSC continuity rides its own
 * `sentry-trace`/`baggage` headers, which this never touches.
 */
export const SENTRY_TRACE_STATE_KEYS = [
  "sentry.dsc",
  "sentry.sampled_not_recording",
  "sentry.url",
  "sentry.sample_rand",
  "sentry.sample_rate",
  "sentry.ignored",
  "sentry.segment_ignored",
] as const

/**
 * Stage 1 (at mint): unset every Sentry TraceState key. TraceState is
 * immutable — `.unset()` returns a new instance — so the input is never
 * mutated. A traceState left with no members collapses to `undefined` so no
 * caller ever serializes an empty `tracestate` header. Also consumed by
 * instrumentation.ts's sanitized W3C composite member, so internal first-party
 * HTTP hops under Sentry-ON sanitize too — no emission point is exempt.
 */
export function sanitizeTraceState(
  ts: TraceState | undefined
): TraceState | undefined {
  if (!ts) return undefined
  const sanitized = SENTRY_TRACE_STATE_KEYS.reduce(
    (acc, key) => acc.unset(key),
    ts
  )
  return sanitized.serialize() === "" ? undefined : sanitized
}

/**
 * Serialized tracestate of the active span, run through Sentry-key stripping
 * (stage 1) then the canonical gate: stage 1 → serialize → sanitizeTracestate-
 * Header (which now owns the ≤512 cap). Oversized/duplicate/grammar-invalid
 * degrade to absent whole — no member-boundary truncation.
 */
export function activeTracestate(): string | undefined {
  const sc = trace.getActiveSpan()?.spanContext()
  if (!sc || !isSpanContextValid(sc)) return undefined
  const serialized = sanitizeTraceState(sc.traceState)?.serialize()
  if (!serialized) return undefined
  return sanitizeTracestateHeader(serialized)
}

/**
 * Stage 3 (receive, transport-salvage detection): `propagator.extract` the
 * carrier, then assert every key of the ALREADY-GATED `carrier.tracestate`
 * survived into the resulting span context. OTel-JS still validates tracestate
 * keys at Level 1, so a Level-2-only key we accept (`1abc`, `a@b@c`, a >13-char
 * system id) is dropped per-member by the transport — spike-confirmed
 * `ok=1,1abc=2` extracts as `ok=1`. Rather than let that partially-salvaged
 * state re-mint downstream (the corruption the policy forbids), drop the
 * tracestate WHOLE and keep the traceparent (degrade-not-reject).
 *
 * Key-presence — not member count — is the test, so the Sentry-ON composite
 * (which ADDS sentry.* members on extract) is never mistaken for a salvage.
 * The caller MUST gate `carrier.tracestate` through `sanitizeTracestateHeader`
 * before calling; an absent tracestate short-circuits to the plain extract.
 */
export function extractTraceCarrierContext(
  base: Context,
  carrier: TraceCarrier | Record<string, string>,
  propagator: Pick<TextMapPropagator, "extract"> = propagation
): Context {
  const extracted = propagator.extract(base, carrier, defaultTextMapGetter)
  const gated = carrier["tracestate"]
  if (gated === undefined) return extracted
  const sc = trace.getSpanContext(extracted)
  if (!sc) return extracted
  const survived = sc.traceState
  const allPresent = tracestateKeys(gated).every(
    (key) => survived?.get(key) !== undefined
  )
  if (allPresent) return extracted
  return trace.setSpanContext(extracted, { ...sc, traceState: undefined })
}

/**
 * THE canonical mint for manual `{traceparent, tracestate?}` carriers.
 * `undefined` when there is no valid active span; `tracestate` is omitted
 * (never empty) when the active span carries none worth forwarding.
 */
export function activeTraceCarrier(): TraceCarrier | undefined {
  const traceparent = activeTraceparent()
  if (traceparent === undefined) return undefined
  const tracestate = activeTracestate()
  return tracestate === undefined
    ? { traceparent }
    : { traceparent, tracestate }
}
