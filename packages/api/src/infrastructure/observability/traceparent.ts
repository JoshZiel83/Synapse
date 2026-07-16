import { isSpanContextValid, trace, type TraceState } from "@opentelemetry/api"
import {
  isValidTraceparent,
  MAX_TRACESTATE_LENGTH,
  TRACEPARENT_RE,
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
 * Validation is re-exported from `@synapse/shared` (the single in-repo regex);
 * api-side receivers import it from here.
 */
export { isValidTraceparent, TRACEPARENT_RE }

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

// W3C trace-context §3.3.2.2: key = simple-key / multi-tenant-key.
const TRACESTATE_KEY_RE =
  /^(?:[a-z][a-z0-9_\-*/]{0,255}|[a-z0-9][a-z0-9_\-*/]{0,240}@[a-z][a-z0-9_\-*/]{0,13})$/
// value = 0*255(chr) nblk-chr — chr excludes `,` (0x2c) and `=` (0x3d), and the
// last char additionally excludes space.
const TRACESTATE_VALUE_RE =
  /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/
// OWS = *( SP / HTAB ) — deliberately NOT String.trim(), which would also
// erase spec-invalid padding (\n, \v, …) and mask a malformed member.
const MEMBER_OWS_RE = /^[ \t]+|[ \t]+$/g

/**
 * Stage 2 (final gate): whole-or-nothing validation of a serialized tracestate
 * header against the W3C §3.3.2 list ABNF (≤32 members; key/value grammar per
 * §3.3.2.1–2). ANY invalid member ⇒ undefined — partial salvage IS the
 * corruption mechanism (runtime-reproduced), and discarding the entire header
 * is spec-sanctioned. Empty/whitespace-only list members are spec-VALID (the
 * OWS alternative — `foo=bar,` passes); a header with no key=value member at
 * all carries nothing and degrades to undefined. Legitimate vendor members
 * (`es=s:1.0`, `congo=…`) pass verbatim.
 */
export function sanitizeTracestateHeader(raw: string): string | undefined {
  const members = raw.split(",")
  if (members.length > 32) return undefined
  let nonEmpty = 0
  for (const member of members) {
    const m = member.replace(MEMBER_OWS_RE, "")
    if (m === "") continue
    const eq = m.indexOf("=")
    if (eq === -1) return undefined
    if (
      !TRACESTATE_KEY_RE.test(m.slice(0, eq)) ||
      !TRACESTATE_VALUE_RE.test(m.slice(eq + 1))
    ) {
      return undefined
    }
    nonEmpty++
  }
  return nonEmpty > 0 ? raw : undefined
}

/**
 * Serialized tracestate of the active span, run through both sanitizer stages
 * and the uniform size cap: stage 1 → serialize → stage 2 → ≤1024 chars.
 * Oversized degrades to absent (no member-boundary truncation — same
 * whole-or-nothing posture as stage 2).
 */
export function activeTracestate(): string | undefined {
  const sc = trace.getActiveSpan()?.spanContext()
  if (!sc || !isSpanContextValid(sc)) return undefined
  const serialized = sanitizeTraceState(sc.traceState)?.serialize()
  if (!serialized) return undefined
  const validated = sanitizeTracestateHeader(serialized)
  if (validated === undefined || validated.length > MAX_TRACESTATE_LENGTH) {
    return undefined
  }
  return validated
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
