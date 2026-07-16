import test from "node:test"
import assert from "node:assert/strict"
import {
  context,
  trace,
  ROOT_CONTEXT,
  TraceFlags,
  type TraceState,
} from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import {
  activeTraceCarrier,
  activeTraceparent,
  activeTracestate,
  isValidTraceparent,
  sanitizeTracestateHeader,
} from "./traceparent.js"

assert.ok(
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable()
  )
)

test("stage 2 passes legitimate vendor lists verbatim", () => {
  for (const header of [
    "es=s:1.0",
    "congo=t61rcWkgMzE,rojo=00f067aa0ba902b7",
    "tenant@system=1", // multi-tenant key form
    "foo=bar,", // trailing empty member is spec-VALID (OWS alternative)
    "foo=bar, baz=qux ", // OWS around members
    "foo=bar,\tbaz=qux", // HTAB is OWS too
    "a= b", // leading space inside a value is grammar-valid chr
  ]) {
    assert.equal(sanitizeTracestateHeader(header), header)
  }
})

test("stage 2 drops the WHOLE header on any invalid member", () => {
  for (const header of [
    "sentry.dsc=trace_id=1", // `.` in key AND `=` in value
    "othervendor=xyz,sentry.url=http://x", // one bad member poisons all
    "a=b=c", // `=` in value
    "Foo=bar", // uppercase key
    "foobar", // no `=`
    "日=1", // non-ASCII
    "foo=bar,\nbaz=qux", // \n is NOT OWS — no String.trim() masking
    `long=${"x".repeat(257)}`, // value over the 256-char ABNF bound
    Array.from({ length: 33 }, (_, i) => `k${i}=v`).join(","), // >32 members
  ]) {
    assert.equal(sanitizeTracestateHeader(header), undefined, header)
  }
})

test("stage 2 degrades headers with no key=value member to undefined", () => {
  assert.equal(sanitizeTracestateHeader(""), undefined)
  assert.equal(sanitizeTracestateHeader(" , ,"), undefined)
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

  // > 1024 chars of individually-valid members degrades to absent — no
  // member-boundary truncation.
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
