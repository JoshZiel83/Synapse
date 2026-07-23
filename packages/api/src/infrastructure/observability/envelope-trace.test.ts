import assert from "node:assert/strict"
import { test } from "node:test"
import { propagation, trace, type Context } from "@opentelemetry/api"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { extractEnvelopeTraceContext } from "./envelope-trace.js"
import { isPublicIngress } from "./ingress-trust.js"

// A degraded envelope returns a PARENTLESS context (no span context, so a fresh
// root span is opened) that is nonetheless marked public-ingress — a WS envelope
// carrier is Ring-0 by construction, so every per-message span is an
// untrusted-ingress entry span (§3a A3). "Degrade-not-reject" is now "parentless
// + marked", NOT "=== ROOT_CONTEXT".
function assertDegradedRoot(ctx: Context, msg?: string): void {
  assert.equal(trace.getSpanContext(ctx), undefined, msg)
  assert.equal(isPublicIngress(ctx), true, msg)
}

// The helper extracts through the GLOBAL propagator (in production the
// FirstPartyOnlyPropagator-wrapped composite, whose extract delegates
// unconditionally — probe P-D2 covers the Sentry-ON composite; here the plain
// W3C member is enough).
propagation.setGlobalPropagator(new W3CTraceContextPropagator())

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const SPAN_ID = "b7ad6b7169203331"
const VALID_TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`

test("valid envelope ⇒ remote context with the carrier's exact ids + tracestate", () => {
  const ctx = extractEnvelopeTraceContext({
    type: "auth",
    traceparent: VALID_TRACEPARENT,
    tracestate: "vendor=abc",
  })
  const sc = trace.getSpanContext(ctx)
  assert.ok(sc)
  assert.equal(sc.traceId, TRACE_ID)
  assert.equal(sc.spanId, SPAN_ID)
  assert.equal(sc.traceFlags, 1)
  assert.equal(sc.isRemote, true)
  assert.equal(sc.traceState?.get("vendor"), "abc")
})

test("absent / malformed / non-string traceparent ⇒ parentless marked root (degrade-not-reject)", () => {
  assertDegradedRoot(extractEnvelopeTraceContext({ type: "auth" }), "absent")
  assertDegradedRoot(
    extractEnvelopeTraceContext({ traceparent: "garbage" }),
    "garbage"
  )
  assertDegradedRoot(
    // all-zero span-id — regex-invalid per W3C §3.2
    extractEnvelopeTraceContext({
      traceparent: `00-${TRACE_ID}-0000000000000000-01`,
    }),
    "zero span-id"
  )
  assertDegradedRoot(
    extractEnvelopeTraceContext({ traceparent: 42 }),
    "non-string"
  )
  assertDegradedRoot(extractEnvelopeTraceContext(null), "null")
  assertDegradedRoot(extractEnvelopeTraceContext("string"), "string")
  assertDegradedRoot(extractEnvelopeTraceContext(undefined), "undefined")
})

test("over-512 / grammar-invalid / duplicate-key / non-string tracestate drops the FIELD but keeps the traceparent", () => {
  // 513 chars — one past the gate's cap.
  for (const bad of [
    `v=${"x".repeat(512)}`, // 514 chars, over the cap
    "Foo=bar", // uppercase key (grammar-invalid)
    "ok=1,ok=2", // duplicate key (Level 2 MUST)
    "a=b=c", // `=` in value
  ]) {
    const ctx = extractEnvelopeTraceContext({
      traceparent: VALID_TRACEPARENT,
      tracestate: bad,
    })
    const sc = trace.getSpanContext(ctx)
    assert.ok(sc, bad)
    assert.equal(sc.traceId, TRACE_ID, bad)
    assert.equal(sc.traceState?.serialize() || "", "", bad)
  }

  const nonString = extractEnvelopeTraceContext({
    traceparent: VALID_TRACEPARENT,
    tracestate: 42,
  })
  const sc2 = trace.getSpanContext(nonString)
  assert.ok(sc2)
  assert.equal(sc2.traceId, TRACE_ID)
  assert.equal(sc2.traceState?.serialize() || "", "")
})

test("a Level-2-only key the transport salvages drops the tracestate WHOLE, traceparent kept", () => {
  // `1abc` is gate-legal but OTel-JS drops it per-member; stage 3 (via
  // extractTraceCarrierContext inside the helper) must drop the whole field.
  const ctx = extractEnvelopeTraceContext({
    traceparent: VALID_TRACEPARENT,
    tracestate: "ok=1,1abc=2",
  })
  const sc = trace.getSpanContext(ctx)
  assert.ok(sc)
  assert.equal(sc.traceId, TRACE_ID)
  assert.equal(sc.traceState?.serialize() || "", "")
})

test("a 5KB hostile traceparent degrades cleanly (batch-poisoning guard)", () => {
  const ctx = extractEnvelopeTraceContext({ traceparent: "z".repeat(5120) })
  assertDegradedRoot(ctx)
})

test("every exit is marked public-ingress (WS carriers are Ring-0 by construction)", () => {
  // valid carrier ⇒ remote parent, still marked
  assert.equal(
    isPublicIngress(
      extractEnvelopeTraceContext({
        traceparent: VALID_TRACEPARENT,
        tracestate: "vendor=abc",
      })
    ),
    true
  )
  // degraded ⇒ parentless, still marked (covered by assertDegradedRoot above too)
  assert.equal(isPublicIngress(extractEnvelopeTraceContext({})), true)
})
