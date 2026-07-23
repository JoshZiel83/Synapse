// P-A7 (sampler remote-arm matrix) — §3a of
// docs/trace-correctness-remediation-plan-2026-07-12.md (adjudication 1 / A2,
// amended by round-2 A3). Drives the REAL buildSamplerFromEnvVars() (imported
// from instrumentation.ts, loaded inert under OTEL_SDK_DISABLED) across the six
// spec values + malformed inputs, asserting the hardened remote-parent arms:
// operator intent wins over any inbound sampled flag, in BOTH directions, and
// ratio-class roots bind BOTH remote arms to the SAME deterministic instance.
//
// Round-2 A3 additions (R3 — ONE ratio function per process): when a ratio-class
// sampler is configured, the KEYED accumulator (KeyedTraceIdRatioSampler: salted
// HMAC of the trace id) is the ratio for the root arm AND both remote arms,
// replacing the SDK's public XOR fold — so the structural id
// `deadbeefdeadbeefcafebabecafebabe` (which the stock fold records at every
// nonzero ratio) is NOT recorded, for a marked OR unmarked parent alike (the
// marker does NOT change the sampling math). The unspoofable ingress marker's
// only effect is the span attribute synapse.trace.ingress=public, stamped by
// IngressTaggingSampler on public-edge ENTRY spans in EVERY config (incl. the
// AlwaysOn default) and surviving SentryWrappedSampler.
// Run: npx tsx scripts/trace-probes/p-a7-sampler-matrix.ts
import { check, finish } from "./_shared.js"

process.env.OTEL_SDK_DISABLED = "true"
process.env.SENTRY_DSN = ""
// Fixed salt so keyed decisions are reproducible across rebuilds within this run
// (unset would mint a fresh random salt per buildSamplerFromEnvVars() call).
process.env.SYNAPSE_TRACE_SAMPLING_SALT = "p-a7-fixed-probe-salt"
const {
  buildSamplerFromEnvVars,
  normalizeTracesSamplerEnv,
  SentryWrappedSampler,
} = await import("../../src/instrumentation.js")
import {
  ATTR_TRACE_INGRESS,
  markPublicIngress,
} from "../../src/infrastructure/observability/ingress-trust.js"

import {
  ROOT_CONTEXT,
  SpanKind,
  TraceFlags,
  trace,
  type Context,
} from "@opentelemetry/api"
import {
  SamplingDecision,
  TraceIdRatioBasedSampler,
  type Sampler,
} from "@opentelemetry/sdk-trace-base"

const STRUCTURAL_ID = "deadbeefdeadbeefcafebabecafebabe" // XOR fold = 0

function randomTraceId(): string {
  let id = ""
  for (let i = 0; i < 32; i++) {
    id += Math.floor(Math.random() * 16).toString(16)
  }
  return id
}

function remoteParentCtx(traceId: string, sampled: boolean): Context {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId: "00f067aa0ba902b7",
    traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
  })
}

/** A remote parent that arrived through the public edge (nginx-marked). */
function publicIngressRemoteParentCtx(
  traceId: string,
  sampled: boolean
): Context {
  return markPublicIngress(remoteParentCtx(traceId, sampled))
}

function decide(sampler: Sampler, ctx: Context, traceId: string): boolean {
  return (
    sampler.shouldSample(ctx, traceId, "probe", SpanKind.INTERNAL, {}, [])
      .decision === SamplingDecision.RECORD_AND_SAMPLED
  )
}

/** The synapse.trace.ingress attribute the sampler stamped (or undefined). */
function ingressAttr(sampler: Sampler, ctx: Context, traceId: string): unknown {
  return sampler.shouldSample(ctx, traceId, "probe", SpanKind.SERVER, {}, [])
    .attributes?.[ATTR_TRACE_INGRESS]
}

function build(name: string | undefined, arg?: string): Sampler {
  if (name === undefined) delete process.env.OTEL_TRACES_SAMPLER
  else process.env.OTEL_TRACES_SAMPLER = name
  if (arg === undefined) delete process.env.OTEL_TRACES_SAMPLER_ARG
  else process.env.OTEL_TRACES_SAMPLER_ARG = arg
  return buildSamplerFromEnvVars()
}

const N = 2000
const ids = Array.from({ length: N }, randomTraceId)

// --- default (unset): AlwaysOn root + BOTH remote arms ------------------------
for (const [label, sampler] of [
  ["unset (default)", build(undefined)],
  ["parentbased_always_on", build("parentbased_always_on")],
] as const) {
  const id = ids[0]!
  check(`${label}: root sampled`, decide(sampler, ROOT_CONTEXT, id))
  check(
    `${label}: forged/honest flags-00 cannot ERASE (remoteParentNotSampled=AlwaysOn)`,
    decide(sampler, remoteParentCtx(id, false), id)
  )
  check(
    `${label}: remote sampled=01 stays sampled`,
    decide(sampler, remoteParentCtx(id, true), id)
  )
}

// --- parentbased_always_off: operator OFF wins over forged 01 ----------------
{
  const sampler = build("parentbased_always_off")
  const id = ids[0]!
  check("parentbased_always_off: root off", !decide(sampler, ROOT_CONTEXT, id))
  check(
    "parentbased_always_off: forged flags-01 cannot FORCE (remoteParentSampled=AlwaysOff)",
    !decide(sampler, remoteParentCtx(id, true), id)
  )
  check(
    "parentbased_always_off: flags-00 off",
    !decide(sampler, remoteParentCtx(id, false), id)
  )
}

// --- always_on / always_off ---------------------------------------------------
check(
  "always_on: root sampled",
  decide(build("always_on"), ROOT_CONTEXT, ids[0]!)
)
check(
  "always_off: root not sampled",
  !decide(build("always_off"), ROOT_CONTEXT, ids[0]!)
)

// --- parentbased_traceidratio: BOTH remote arms = SAME ratio instance --------
{
  const sampler = build("parentbased_traceidratio", "0.25")
  let sampledCount = 0
  let armsConsistent = true
  let deterministic = true
  for (const id of ids) {
    const root = decide(sampler, ROOT_CONTEXT, id)
    const remoteSampled = decide(sampler, remoteParentCtx(id, true), id)
    const remoteNotSampled = decide(sampler, remoteParentCtx(id, false), id)
    if (root !== remoteSampled || root !== remoteNotSampled) {
      armsConsistent = false
    }
    if (root !== decide(sampler, ROOT_CONTEXT, id)) deterministic = false
    if (root) sampledCount++
  }
  check(
    "parentbased_traceidratio(0.25): root and BOTH remote arms agree per trace-id (forged flags are bounded by the operator ratio, both directions)",
    armsConsistent
  )
  check(
    "parentbased_traceidratio(0.25): per-trace-id decisions are deterministic (SDK implementation pin)",
    deterministic
  )
  const rate = sampledCount / N
  check(
    `parentbased_traceidratio(0.25): observed rate ≈ 0.25 (got ${rate.toFixed(3)})`,
    rate > 0.17 && rate < 0.33,
    rate
  )
  // The measured adversarial case A2 retired: 5000 forged flags-00 headers
  // must NOT yield 5000 recordings under a 0.25 ratio.
  let forcedByForgedFlags = 0
  for (const id of ids) {
    if (decide(sampler, remoteParentCtx(id, false), id)) forcedByForgedFlags++
  }
  check(
    "parentbased_traceidratio(0.25): flags-00 flood records at ~ratio, not 100%",
    forcedByForgedFlags < N / 2,
    forcedByForgedFlags
  )
}

// --- traceidratio (no ParentBased wrapper): parent flag ignored --------------
{
  const sampler = build("traceidratio", "0.25")
  let ignoresParent = true
  for (const id of ids.slice(0, 500)) {
    const root = decide(sampler, ROOT_CONTEXT, id)
    if (
      root !== decide(sampler, remoteParentCtx(id, true), id) ||
      root !== decide(sampler, remoteParentCtx(id, false), id)
    ) {
      ignoresParent = false
    }
  }
  check(
    "traceidratio: parent flags ignored entirely (spec: no ParentBased wrapper)",
    ignoresParent
  )
}

// --- malformed OTEL_TRACES_SAMPLER_ARG ⇒ ignored (1.0), NOT clamped ----------
for (const badArg of ["abc", "-0.2", "1.5", "NaN"]) {
  const sampler = build("traceidratio", badArg)
  const allSampled = ids
    .slice(0, 200)
    .every((id) => decide(sampler, ROOT_CONTEXT, id))
  check(
    `traceidratio ARG "${badArg}": treated as unset (1.0) — not clamped/inverted`,
    allSampled
  )
}

// --- unknown sampler name ⇒ hardened default ----------------------------------
{
  const sampler = build("bogus_sampler")
  check(
    "unknown OTEL_TRACES_SAMPLER: falls back to the hardened default (flags-00 cannot erase)",
    decide(sampler, remoteParentCtx(ids[0]!, false), ids[0]!)
  )
}

// --- F13 enum normalization: case-insensitive + whitespace-tolerant + written back ---
{
  // Each mixed-case/whitespace spelling normalizes to the lowercase form, is
  // WRITTEN BACK to process.env (so the SDK's parallel loadDefaultConfig agrees),
  // and builds the SAME sampler class as the lowercase spelling.
  const cases: Array<[string, string]> = [
    ["ALWAYS_OFF", "always_off"],
    ["  always_off  ", "always_off"],
    ["Parentbased_TraceIdRatio", "parentbased_traceidratio"],
  ]
  for (const [raw, normalized] of cases) {
    process.env.OTEL_TRACES_SAMPLER = raw
    const returned = normalizeTracesSamplerEnv()
    check(
      `normalize "${raw}" ⇒ "${normalized}" (returned value)`,
      returned === normalized,
      returned
    )
    check(
      `normalize "${raw}" rewrites process.env to "${normalized}"`,
      process.env.OTEL_TRACES_SAMPLER === normalized,
      process.env.OTEL_TRACES_SAMPLER
    )
    const fromNormalizedEnv = buildSamplerFromEnvVars() // reads the written-back value
    process.env.OTEL_TRACES_SAMPLER = normalized
    const fromLower = buildSamplerFromEnvVars()
    // Every build is IngressTaggingSampler-wrapped, so compare toString() (which
    // embeds the inner sampler composition) rather than the always-equal class.
    check(
      `normalize "${raw}": sampler composition matches the lowercase spelling`,
      fromNormalizedEnv.toString() === fromLower.toString(),
      `${fromNormalizedEnv.toString()} vs ${fromLower.toString()}`
    )
  }
  // Negative: a genuinely unknown value is only trim+lowercased (STILL unknown),
  // never coerced into a valid spelling — so the SDK's own parse still flags it.
  process.env.OTEL_TRACES_SAMPLER = "  BOGUS_SAMPLER  "
  const bogus = normalizeTracesSamplerEnv()
  check(
    "unknown value normalized to trim+lowercase only, not coerced valid",
    bogus === "bogus_sampler" &&
      process.env.OTEL_TRACES_SAMPLER === "bogus_sampler"
  )
  delete process.env.OTEL_TRACES_SAMPLER
  check(
    "normalizeTracesSamplerEnv() returns undefined when the var is unset",
    normalizeTracesSamplerEnv() === undefined
  )
}

// ── Round-2 A3: keyed ratio (R3) + ingress-marker attribute ──────────────────
// (1) The structural id the stock XOR fold records at every nonzero ratio is
//     NOT recorded by the keyed remote arms — marked OR unmarked, both flags.
{
  // Document the stock property that motivated the fix.
  const stock = new TraceIdRatioBasedSampler(0.000001)
  check(
    "stock TraceIdRatioBasedSampler(1e-6) records the structural id (the XOR-fold bypass being removed)",
    stock.shouldSample(
      ROOT_CONTEXT,
      STRUCTURAL_ID,
      "p",
      SpanKind.INTERNAL,
      {},
      []
    ).decision === SamplingDecision.RECORD_AND_SAMPLED
  )
  const sampler = build("parentbased_traceidratio", "0.000001")
  for (const sampled of [false, true]) {
    check(
      `parentbased_traceidratio(1e-6): structural id NOT recorded via UNMARKED remote parent (flags-${sampled ? "01" : "00"}) — keyed arm`,
      !decide(sampler, remoteParentCtx(STRUCTURAL_ID, sampled), STRUCTURAL_ID)
    )
    check(
      `parentbased_traceidratio(1e-6): structural id NOT recorded via MARKED remote parent (flags-${sampled ? "01" : "00"}) — marker does NOT change sampling (R3)`,
      !decide(
        sampler,
        publicIngressRemoteParentCtx(STRUCTURAL_ID, sampled),
        STRUCTURAL_ID
      )
    )
  }
}

// (2) Marked decisions are deterministic across repeated calls and identical to
//     the unmarked decision for the same id (the marker is attribute-only).
{
  const sampler = build("parentbased_traceidratio", "0.25")
  let stable = true
  let markerNeutral = true
  for (const id of ids.slice(0, 500)) {
    const marked = decide(sampler, publicIngressRemoteParentCtx(id, true), id)
    if (marked !== decide(sampler, publicIngressRemoteParentCtx(id, true), id))
      stable = false
    if (marked !== decide(sampler, remoteParentCtx(id, true), id))
      markerNeutral = false
  }
  check("keyed ratio: marked remote-parent decisions are deterministic", stable)
  check(
    "keyed ratio: marked and unmarked decisions agree per id (marker never changes the decision, R3)",
    markerNeutral
  )
}

// (3) Marked empirical rate at ARG=0.5 within tolerance over the corpus.
{
  const sampler = build("parentbased_traceidratio", "0.5")
  let sampled = 0
  for (const id of ids)
    if (decide(sampler, publicIngressRemoteParentCtx(id, true), id)) sampled++
  const rate = sampled / N
  check(
    `keyed ratio(0.5): marked empirical rate ≈ 0.5 (got ${rate.toFixed(3)})`,
    rate > 0.44 && rate < 0.56,
    rate
  )
}

// (4) A2's both-arms rule still holds for marked AND unmarked parents in every
//     ratio config — inbound -01 cannot FORCE, inbound -00 cannot ERASE.
{
  const sampler = build("parentbased_traceidratio", "0.25")
  let noForge = true
  let noErase = true
  for (const id of ids.slice(0, 500)) {
    const root = decide(sampler, ROOT_CONTEXT, id)
    for (const ctx of [
      remoteParentCtx(id, true),
      publicIngressRemoteParentCtx(id, true),
    ]) {
      if (decide(sampler, ctx, id) !== root) noForge = false
    }
    for (const ctx of [
      remoteParentCtx(id, false),
      publicIngressRemoteParentCtx(id, false),
    ]) {
      if (decide(sampler, ctx, id) !== root) noErase = false
    }
  }
  check(
    "keyed ratio: inbound -01 cannot FORCE (both arms bound to root), marked and unmarked",
    noForge
  )
  check(
    "keyed ratio: inbound -00 cannot ERASE (both arms bound to root), marked and unmarked",
    noErase
  )
}

// (5) The ingress attribute is present on a MARKED entry span in EVERY sampler
//     config (incl. AlwaysOn default), absent for unmarked, absent for a
//     local-parent (descendant) span.
{
  const configs: Array<[string, string | undefined, string | undefined]> = [
    ["unset (AlwaysOn default)", undefined, undefined],
    ["parentbased_always_on", "parentbased_always_on", undefined],
    ["always_on", "always_on", undefined],
    ["parentbased_traceidratio", "parentbased_traceidratio", "1"],
    ["traceidratio", "traceidratio", "1"],
    // always_off / parentbased_always_off never record, so nothing to tag.
  ]
  for (const [label, name, arg] of configs) {
    const sampler = build(name, arg)
    const id = ids[0]!
    check(
      `${label}: marked remote-parent entry span carries ${ATTR_TRACE_INGRESS}=public`,
      ingressAttr(sampler, publicIngressRemoteParentCtx(id, true), id) ===
        "public"
    )
    check(
      `${label}: UNMARKED remote-parent entry span has no ingress attribute`,
      ingressAttr(sampler, remoteParentCtx(id, true), id) === undefined
    )
    check(
      `${label}: marked LOCAL-parent (descendant) span is NOT tagged`,
      ingressAttr(
        sampler,
        markPublicIngress(
          trace.setSpanContext(ROOT_CONTEXT, {
            traceId: id,
            spanId: "00f067aa0ba902b7",
            traceFlags: TraceFlags.SAMPLED,
            isRemote: false,
          })
        ),
        id
      ) === undefined
    )
  }
  // A recording public-edge entry span with an ABSENT parent is also tagged.
  check(
    "AlwaysOn default: marked absent-parent entry span carries the ingress attribute",
    ingressAttr(build(undefined), markPublicIngress(ROOT_CONTEXT), ids[0]!) ===
      "public"
  )
}

// (6) The ingress attribute SURVIVES SentryWrappedSampler (fix (d): the wrap
//     used to discard the inner result's attributes).
{
  const wrapped = new SentryWrappedSampler(build(undefined))
  const id = ids[0]!
  check(
    "SentryWrappedSampler preserves the ingress attribute on a marked entry span",
    ingressAttr(wrapped, publicIngressRemoteParentCtx(id, true), id) ===
      "public"
  )
  check(
    "SentryWrappedSampler adds no ingress attribute to an unmarked span",
    ingressAttr(wrapped, remoteParentCtx(id, true), id) === undefined
  )
}

finish("P-A7")
