import test from "node:test"
import assert from "node:assert/strict"
import {
  context,
  trace,
  ROOT_CONTEXT,
  TraceFlags,
  type Context,
  type TextMapGetter,
  type TraceState,
} from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import {
  TraceState as TraceStateImpl,
  W3CTraceContextPropagator,
} from "@opentelemetry/core"
import {
  activeTraceCarrier,
  activeTraceparent,
  activeTracestate,
  extractTraceCarrierContext,
  isValidTraceparent,
} from "./traceparent.js"

assert.ok(
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable()
  )
)

// The full ABNF gate (sanitizeTracestateHeader) is exercised in the shared
// package's traceparent.test.ts — the single implementation now lives there and
// api re-exports it. Here we cover the api-only OTel-typed pieces: stage-1
// Sentry stripping + active*, and stage-3 transport-salvage detection.

const carrierPropagator = new W3CTraceContextPropagator()
const STAGE3_TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

test("stage 3: a clean tracestate survives extract intact", () => {
  const ctx = extractTraceCarrierContext(
    ROOT_CONTEXT,
    { traceparent: STAGE3_TP, tracestate: "ok=1,congo=t61" },
    carrierPropagator
  )
  const sc = trace.getSpanContext(ctx)
  assert.equal(sc?.traceId, "4bf92f3577b34da6a3ce929d0e0e4736")
  assert.equal(sc?.traceState?.get("ok"), "1")
  assert.equal(sc?.traceState?.get("congo"), "t61")
})

test("stage 3: a Level-2-only key the transport salvages drops the tracestate WHOLE, traceId kept", () => {
  // `1abc` is gate-legal at Level 2 but OTel-JS validates keys at Level 1 and
  // drops it, salvaging `ok=1,1abc=2` to `ok=1`. Stage 3 must drop the whole
  // tracestate rather than re-mint the partially salvaged one — the traceparent
  // (and the traceId) survives.
  const ctx = extractTraceCarrierContext(
    ROOT_CONTEXT,
    { traceparent: STAGE3_TP, tracestate: "ok=1,1abc=2" },
    carrierPropagator
  )
  const sc = trace.getSpanContext(ctx)
  assert.equal(sc?.traceId, "4bf92f3577b34da6a3ce929d0e0e4736")
  assert.equal(sc?.traceState, undefined)
})

test("stage 3: members ADDED on extract (Sentry composite) are not mistaken for salvage", () => {
  // A composite that ADDS a member on extract must not trip the key-presence
  // check — every GATED key still survives, so the tracestate is kept.
  const addingPropagator = {
    extract(
      base: Context,
      carrier: Record<string, string>,
      getter: TextMapGetter<Record<string, string>>
    ): Context {
      const ctx = carrierPropagator.extract(base, carrier, getter)
      const sc = trace.getSpanContext(ctx)
      if (!sc) return ctx
      const withAddition = (sc.traceState ?? new TraceStateImpl()).set(
        "sentry",
        "x"
      )
      return trace.setSpanContext(ctx, { ...sc, traceState: withAddition })
    },
  }
  const ctx = extractTraceCarrierContext(
    ROOT_CONTEXT,
    { traceparent: STAGE3_TP, tracestate: "ok=1" },
    addingPropagator
  )
  const sc = trace.getSpanContext(ctx)
  assert.equal(sc?.traceState?.get("ok"), "1")
  assert.equal(sc?.traceState?.get("sentry"), "x")
})

function withNonRecordingSpan<T>(
  traceState: TraceState | undefined,
  fn: () => T
): T {
  const span = trace.wrapSpanContext({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceFlags: TraceFlags.SAMPLED,
    traceState,
  })
  return context.with(trace.setSpan(ROOT_CONTEXT, span), fn)
}

// TraceState double with Sentry's non-validating semantics — the only way
// sentry.* / oversized members exist in a real traceState (see the sibling
// first-party-propagator.test.ts).
function looseTraceState(entries: Record<string, string>): TraceState {
  const state = new Map(Object.entries(entries))
  return {
    set: (k, v) => looseTraceState({ ...Object.fromEntries(state), [k]: v }),
    unset: (k) => {
      const next = Object.fromEntries(state)
      delete next[k]
      return looseTraceState(next)
    },
    get: (k) => state.get(k),
    serialize: () =>
      Array.from(state.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join(","),
  }
}

test("activeTracestate: stage 1 → serialize → stage 2 → cap", () => {
  const carried = withNonRecordingSpan(
    looseTraceState({ "sentry.sample_rand": "0.5", othervendor: "xyz" }),
    activeTracestate
  )
  assert.equal(carried, "othervendor=xyz")

  // > 512 chars of individually-valid members degrades to absent — no
  // member-boundary truncation (the cap now lives inside the gate).
  const oversized = Object.fromEntries(
    Array.from({ length: 5 }, (_, i) => [`k${i}`, "v".repeat(250)])
  )
  assert.equal(
    withNonRecordingSpan(looseTraceState(oversized), activeTracestate),
    undefined
  )

  // A grammar-invalid member poisons the whole header at mint too.
  assert.equal(
    withNonRecordingSpan(
      looseTraceState({ othervendor: "xyz", "bad key": "v" }),
      activeTracestate
    ),
    undefined
  )
})

test("activeTraceCarrier composes traceparent + sanitized tracestate", () => {
  const carrier = withNonRecordingSpan(
    looseTraceState({ "sentry.url": "http://x/", othervendor: "xyz" }),
    activeTraceCarrier
  )
  assert.deepEqual(carrier, {
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    tracestate: "othervendor=xyz",
  })
  assert.ok(isValidTraceparent(carrier?.traceparent))
  // tracestate key OMITTED (not empty) when nothing survives sanitization.
  const sentryOnly = withNonRecordingSpan(
    looseTraceState({ "sentry.dsc": "trace_id=1" }),
    activeTraceCarrier
  )
  assert.deepEqual(sentryOnly, {
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  })
})

test("no active span ⇒ no traceparent, no tracestate, no carrier", () => {
  assert.equal(activeTraceparent(), undefined)
  assert.equal(activeTracestate(), undefined)
  assert.equal(activeTraceCarrier(), undefined)
})
