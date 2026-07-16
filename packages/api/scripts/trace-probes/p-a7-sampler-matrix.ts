// P-A7 (sampler remote-arm matrix) — §3a of
// docs/trace-correctness-remediation-plan-2026-07-12.md (adjudication 1 as
// amended by A2). Drives the REAL buildSamplerFromEnvVars() (imported from
// instrumentation.ts, loaded inert under OTEL_SDK_DISABLED) across the six
// spec values + malformed inputs, asserting the hardened remote-parent arms:
// operator intent wins over any inbound sampled flag, in BOTH directions, and
// ratio-class roots bind BOTH remote arms to the SAME deterministic ratio
// instance. Also pins the SDK's per-trace-id ratio determinism (an
// implementation property the SDK spec never fixed — §3a requires the pin).
// Run: npx tsx scripts/trace-probes/p-a7-sampler-matrix.ts
import { check, finish } from "./_shared.js"

process.env.OTEL_SDK_DISABLED = "true"
process.env.SENTRY_DSN = ""
const { buildSamplerFromEnvVars } = await import("../../src/instrumentation.js")

import {
  ROOT_CONTEXT,
  SpanKind,
  TraceFlags,
  trace,
  type Context,
} from "@opentelemetry/api"
import { SamplingDecision, type Sampler } from "@opentelemetry/sdk-trace-base"

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

function decide(sampler: Sampler, ctx: Context, traceId: string): boolean {
  return (
    sampler.shouldSample(ctx, traceId, "probe", SpanKind.INTERNAL, {}, [])
      .decision === SamplingDecision.RECORD_AND_SAMPLED
  )
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

finish("P-A7")
