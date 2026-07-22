// P-D2 (Sentry-on extract) — §7 of
// docs/trace-correctness-remediation-plan-2026-07-12.md.
// The Sentry-ON composite propagator (SentryPropagator + W3C member), wrapped
// in the FirstPartyOnlyPropagator exactly as instrumentation.ts builds it,
// extracts a plain-object {traceparent, tracestate} carrier to the correct
// context — through the REAL extractEnvelopeTraceContext helper, since that is
// the code path every WS surface runs in production under Sentry-ON.
// Run: npx tsx scripts/trace-probes/p-d2-sentry-on-extract.ts
import { propagation, trace, ROOT_CONTEXT } from "@opentelemetry/api"
import {
  CompositePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core"
import { SentryPropagator } from "@sentry/opentelemetry"
import { FirstPartyOnlyPropagator } from "../../src/infrastructure/observability/first-party-propagator.js"
import { extractEnvelopeTraceContext } from "../../src/infrastructure/observability/envelope-trace.js"
import { check, finish } from "./_shared.js"

// The Sentry-ON global propagator, byte-for-byte the instrumentation.ts shape:
// FirstPartyOnlyPropagator(Composite([Sentry, W3C])) — extract() delegates
// unconditionally (inbound trust is Ring 0's job).
propagation.setGlobalPropagator(
  new FirstPartyOnlyPropagator(
    new CompositePropagator({
      propagators: [new SentryPropagator(), new W3CTraceContextPropagator()],
    }),
    { exact: new Set<string>(), suffixes: [] }
  )
)

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const SPAN_ID = "b7ad6b7169203331"

const ctx = extractEnvelopeTraceContext({
  type: "auth",
  traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
  tracestate: "vendor=abc,congo=t61rcWkgMzE",
})
const sc = trace.getSpanContext(ctx)

check("extracts a span context from the plain-object carrier", Boolean(sc))
check("trace id matches", sc?.traceId === TRACE_ID, sc?.traceId)
check("span id matches", sc?.spanId === SPAN_ID, sc?.spanId)
check("sampled flag preserved", sc?.traceFlags === 1, sc?.traceFlags)
check("marked remote", sc?.isRemote === true, sc?.isRemote)
check(
  "tracestate members survive the composite",
  sc?.traceState?.get("vendor") === "abc" &&
    sc?.traceState?.get("congo") === "t61rcWkgMzE",
  sc?.traceState?.serialize()
)

// flags-00 (unsampled) still extracts as VALID — the explicit sampled-bit
// carve-out belongs to samplers, not extraction.
const unsampled = trace.getSpanContext(
  extractEnvelopeTraceContext({
    traceparent: `00-${TRACE_ID}-${SPAN_ID}-00`,
  })
)
check(
  "flags-00 extracts as a valid context",
  unsampled?.traceId === TRACE_ID && unsampled.traceFlags === 0,
  unsampled
)

// Malformed carrier ⇒ ROOT_CONTEXT (fail-closed extraction; fresh root).
check(
  "malformed traceparent ⇒ ROOT_CONTEXT",
  extractEnvelopeTraceContext({ traceparent: "garbage" }) === ROOT_CONTEXT
)
check(
  "non-object envelope ⇒ ROOT_CONTEXT",
  extractEnvelopeTraceContext("nope") === ROOT_CONTEXT
)

finish("P-D2")
