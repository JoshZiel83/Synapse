// §3c receiver-rule validation matrix for the device-runtime carrier
// (trace plan §4.G change 12): malformed / oversized / all-zero / uppercase /
// wrong-version values degrade to ABSENT — the tools/call is never rejected
// for a trace field — and tracestate is honored only alongside a valid
// traceparent.
import assert from "node:assert/strict"
import test from "node:test"
import {
  getTraceContext,
  getTraceparent,
  runWithTraceContext,
  traceContextFromMeta,
} from "./trace-context.js"

const VALID_TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"

test("traceContextFromMeta: valid traceparent alone", () => {
  assert.deepEqual(traceContextFromMeta({ traceparent: VALID_TP }), {
    traceparent: VALID_TP,
  })
})

test("traceContextFromMeta: valid traceparent + tracestate (vendor members survive)", () => {
  assert.deepEqual(
    traceContextFromMeta({
      traceparent: VALID_TP,
      tracestate: "congo=t61rcWkgMzE,es=s:1.0",
    }),
    { traceparent: VALID_TP, tracestate: "congo=t61rcWkgMzE,es=s:1.0" }
  )
})

test("traceContextFromMeta: invalid values degrade to undefined (never throw)", () => {
  for (const bad of [
    "garbage",
    "",
    42,
    null,
    // uppercase hex
    "00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01",
    // non-00 version (internal carriers are always minted as version 00)
    "ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    // all-zero trace-id / span-id (invalid per W3C §3.2)
    "00-00000000000000000000000000000000-b7ad6b7169203331-01",
    "00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01",
    // oversized / trailing garbage
    `${VALID_TP}-extra`,
    "A".repeat(5000),
  ]) {
    assert.equal(
      traceContextFromMeta({ traceparent: bad }),
      undefined,
      `expected undefined for ${String(bad).slice(0, 60)}`
    )
  }
})

test("traceContextFromMeta: non-object / absent meta", () => {
  assert.equal(traceContextFromMeta(undefined), undefined)
  assert.equal(traceContextFromMeta(null), undefined)
  assert.equal(traceContextFromMeta("string"), undefined)
  assert.equal(traceContextFromMeta({}), undefined)
})

test("traceContextFromMeta: tracestate WITHOUT a valid traceparent is dropped whole", () => {
  assert.equal(
    traceContextFromMeta({ tracestate: "vendor=abc" }),
    undefined,
    "tracestate alone carries nothing linkable"
  )
  assert.equal(
    traceContextFromMeta({ traceparent: "garbage", tracestate: "vendor=abc" }),
    undefined
  )
})

test("traceContextFromMeta: over-512 / grammar-invalid / duplicate-key tracestate degrades to traceparent-only", () => {
  for (const bad of [
    `vendor=${"x".repeat(512)}`, // 519 chars, over the 512 cap
    "Foo=bar", // uppercase key (grammar-invalid)
    "ok=1,ok=2", // duplicate key (Level 2 MUST)
    "a=b=c", // `=` in value
  ]) {
    assert.deepEqual(
      traceContextFromMeta({ traceparent: VALID_TP, tracestate: bad }),
      { traceparent: VALID_TP },
      bad
    )
  }
})

test("traceContextFromMeta: non-string / empty tracestate degrades to traceparent-only", () => {
  assert.deepEqual(
    traceContextFromMeta({ traceparent: VALID_TP, tracestate: 42 }),
    { traceparent: VALID_TP }
  )
  assert.deepEqual(
    traceContextFromMeta({ traceparent: VALID_TP, tracestate: "" }),
    { traceparent: VALID_TP }
  )
})

test("runWithTraceContext: ALS carries the whole carrier; absent outside", () => {
  assert.equal(getTraceContext(), undefined)
  assert.equal(getTraceparent(), undefined)
  const carrier = { traceparent: VALID_TP, tracestate: "vendor=abc" }
  const inside = runWithTraceContext(carrier, () => ({
    ctx: getTraceContext(),
    tp: getTraceparent(),
  }))
  assert.deepEqual(inside.ctx, carrier)
  assert.equal(inside.tp, VALID_TP)
  assert.equal(getTraceContext(), undefined)
})

test("runWithTraceContext: undefined carrier runs fn without a store", () => {
  const inside = runWithTraceContext(undefined, () => getTraceContext())
  assert.equal(inside, undefined)
})
