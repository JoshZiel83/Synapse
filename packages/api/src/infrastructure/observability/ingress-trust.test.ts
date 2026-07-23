// Unit tests for the Ring-0 ingress marker + keyed ratio sampler
// (ingress-trust.ts). Runner: `node:test` via tsx (repo convention), NOT vitest.
import test from "node:test"
import assert from "node:assert/strict"
import {
  ROOT_CONTEXT,
  SpanKind,
  TraceFlags,
  defaultTextMapGetter,
  defaultTextMapSetter,
  trace,
  type Context,
  type TextMapPropagator,
} from "@opentelemetry/api"
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  SamplingDecision,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base"
import {
  ATTR_TRACE_INGRESS,
  IngressTaggingSampler,
  KeyedTraceIdRatioSampler,
  PUBLIC_INGRESS_HEADER,
  PUBLIC_INGRESS_VALUE,
  PublicIngressPropagator,
  isPublicIngress,
  markPublicIngress,
} from "./ingress-trust.js"

const SALT = Buffer.from("fixed-unit-test-salt")
const STRUCTURAL_ID = "deadbeefdeadbeefcafebabecafebabe" // W1W2W1W2, XOR-fold = 0

function randomTraceId(): string {
  let id = ""
  for (let i = 0; i < 32; i++) id += Math.floor(Math.random() * 16).toString(16)
  return id
}
function structuralId(): string {
  const w = () =>
    Array.from({ length: 8 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join("")
  const a = w()
  const b = w()
  return a + b + a + b
}
function records(r: { decision: SamplingDecision }): boolean {
  return r.decision === SamplingDecision.RECORD_AND_SAMPLED
}
function keyedDecides(s: KeyedTraceIdRatioSampler, id: string): boolean {
  return records(s.shouldSample(ROOT_CONTEXT, id))
}

test("KeyedTraceIdRatioSampler: deterministic per id, and two instances from the same salt agree", () => {
  const a = new KeyedTraceIdRatioSampler(0.3, SALT)
  const b = new KeyedTraceIdRatioSampler(
    0.3,
    Buffer.from("fixed-unit-test-salt")
  )
  for (let i = 0; i < 500; i++) {
    const id = randomTraceId()
    const d1 = keyedDecides(a, id)
    assert.equal(keyedDecides(a, id), d1, "same instance is deterministic")
    assert.equal(keyedDecides(b, id), d1, "same-salt instances agree")
  }
})

test("keyed sampler defeats the XOR-fold structural-id bypass that the stock sampler has", () => {
  // Pin the property that MOTIVATED the fix: the stock SDK sampler records the
  // structural id at every nonzero ratio (its accumulator is an XOR fold → 0).
  for (const ratio of [1e-6, 0.01, 0.1]) {
    const stock = new TraceIdRatioBasedSampler(ratio)
    assert.equal(
      records(stock.shouldSample(ROOT_CONTEXT, STRUCTURAL_ID)),
      true,
      `stock sampler records the structural id at ratio ${ratio}`
    )
  }
  // The keyed sampler rejects it at a tiny ratio…
  const keyed = new KeyedTraceIdRatioSampler(1e-6, SALT)
  assert.equal(keyedDecides(keyed, STRUCTURAL_ID), false)
  // …and 0 of 20000 freshly-generated structural ids pass at 1e-6.
  let passed = 0
  for (let i = 0; i < 20000; i++) {
    if (keyedDecides(keyed, structuralId())) passed++
  }
  assert.equal(
    passed,
    0,
    `expected 0 structural ids to pass at 1e-6, got ${passed}`
  )
})

test("keyed sampler empirical rate at 0.5 is within ±3% over 20000 ids", () => {
  const keyed = new KeyedTraceIdRatioSampler(0.5, SALT)
  let sampled = 0
  const N = 20000
  for (let i = 0; i < N; i++)
    if (keyedDecides(keyed, randomTraceId())) sampled++
  const rate = sampled / N
  assert.ok(rate > 0.47 && rate < 0.53, `rate ${rate} not within ±3% of 0.5`)
})

test("keyed sampler boundaries: ratio 1 samples all (incl SDK boundary), ratio 0 none, invalid id → NOT_RECORD", () => {
  const one = new KeyedTraceIdRatioSampler(1, SALT)
  const zero = new KeyedTraceIdRatioSampler(0, SALT)
  for (let i = 0; i < 300; i++) {
    const id = randomTraceId()
    assert.equal(keyedDecides(one, id), true, "ratio 1 samples every id")
    assert.equal(keyedDecides(zero, id), false, "ratio 0 samples none")
  }
  // The SDK's `acc < upperBound` drops an id accumulating to 0xffffffff at
  // ratio 1; our short-circuit records it.
  assert.equal(keyedDecides(one, STRUCTURAL_ID), true)
  // Invalid (all-zero / wrong length) trace ids never record at a fractional ratio.
  const half = new KeyedTraceIdRatioSampler(0.5, SALT)
  assert.equal(
    keyedDecides(half, "0".repeat(32)),
    false,
    "all-zero id → NOT_RECORD"
  )
  assert.equal(
    keyedDecides(half, "not-a-trace-id"),
    false,
    "malformed id → NOT_RECORD"
  )
})

test("KeyedTraceIdRatioSampler.toString never leaks the salt", () => {
  const s = new KeyedTraceIdRatioSampler(
    0.25,
    Buffer.from("SUPER-SECRET-SALT-BYTES")
  )
  const str = s.toString()
  assert.equal(str, "KeyedTraceIdRatioBased{0.25}")
  assert.ok(
    !str.includes("SUPER-SECRET"),
    "salt bytes must not appear in toString"
  )
})

test("PublicIngressPropagator: marks only on carrier-header presence, delegates inject verbatim, never writes the header", () => {
  let extractCalls = 0
  let injectCalls = 0
  const inner: TextMapPropagator = {
    inject: () => {
      injectCalls++
    },
    extract: (ctx) => {
      extractCalls++
      return ctx
    },
    fields: () => ["traceparent"],
  }
  const prop = new PublicIngressPropagator(inner)

  // header present ⇒ marked
  const marked = prop.extract(
    ROOT_CONTEXT,
    { [PUBLIC_INGRESS_HEADER]: PUBLIC_INGRESS_VALUE },
    defaultTextMapGetter
  )
  assert.equal(isPublicIngress(marked), true)

  // header present but a DIFFERENT (forged) value ⇒ still marked (presence, not value)
  const markedForged = prop.extract(
    ROOT_CONTEXT,
    { [PUBLIC_INGRESS_HEADER]: "internal" },
    defaultTextMapGetter
  )
  assert.equal(isPublicIngress(markedForged), true)

  // header absent ⇒ NOT marked
  const unmarked = prop.extract(
    ROOT_CONTEXT,
    { traceparent: "x" },
    defaultTextMapGetter
  )
  assert.equal(isPublicIngress(unmarked), false)

  assert.equal(extractCalls, 3, "extract delegates every time")

  // inject delegates verbatim and NEVER writes the ingress header onto the wire.
  const carrier: Record<string, string> = {}
  prop.inject(ROOT_CONTEXT, carrier, defaultTextMapSetter)
  assert.equal(injectCalls, 1)
  assert.equal(
    carrier[PUBLIC_INGRESS_HEADER],
    undefined,
    "inject must never write the marker"
  )
  assert.deepEqual(prop.fields(), ["traceparent"])
})

test("IngressTaggingSampler: tags absent- and remote-parent entry spans only, never a local child / unmarked / NOT_RECORD", () => {
  const on = new IngressTaggingSampler(new AlwaysOnSampler())
  const off = new IngressTaggingSampler(new AlwaysOffSampler())

  const tag = (ctx: Context, base: IngressTaggingSampler = on) =>
    base.shouldSample(ctx, randomTraceId(), "p", SpanKind.SERVER, {}, [])
      .attributes?.[ATTR_TRACE_INGRESS]

  const remoteParent = (isRemote: boolean): Context =>
    trace.setSpanContext(ROOT_CONTEXT, {
      traceId: randomTraceId(),
      spanId: "00f067aa0ba902b7",
      traceFlags: TraceFlags.SAMPLED,
      isRemote,
    })

  // marked + entry span (absent parent) ⇒ tagged
  assert.equal(tag(markPublicIngress(ROOT_CONTEXT)), PUBLIC_INGRESS_VALUE)
  // marked + remote parent ⇒ tagged
  assert.equal(tag(markPublicIngress(remoteParent(true))), PUBLIC_INGRESS_VALUE)
  // marked + LOCAL parent (descendant) ⇒ NOT tagged
  assert.equal(tag(markPublicIngress(remoteParent(false))), undefined)
  // UNmarked entry span ⇒ NOT tagged
  assert.equal(tag(ROOT_CONTEXT), undefined)
  // marked but NOT_RECORD decision ⇒ NOT tagged (and decision preserved)
  const r = off.shouldSample(
    markPublicIngress(ROOT_CONTEXT),
    randomTraceId(),
    "p",
    SpanKind.SERVER,
    {},
    []
  )
  assert.equal(r.decision, SamplingDecision.NOT_RECORD)
  assert.equal(r.attributes?.[ATTR_TRACE_INGRESS], undefined)
  // decision is never altered by the tagger
  assert.equal(
    on.shouldSample(
      markPublicIngress(ROOT_CONTEXT),
      randomTraceId(),
      "p",
      SpanKind.SERVER,
      {},
      []
    ).decision,
    SamplingDecision.RECORD_AND_SAMPLED
  )
})
