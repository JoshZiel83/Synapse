// P-H (BullMQ) — §7 of docs/trace-correctness-remediation-plan-2026-07-12.md.
// Recreated by the Phase-3 gate runner (the implementer's copy was a temp file
// deleted after its green run; §7 says commit on first use). Pins the §4.H
// claims against the REAL exported helpers in src/workers/job-tracing.ts:
//   1. producer-span carrier injection: the `__otelctx` carrier's span id ===
//      the `send {q}` PRODUCER span's id, and a consumer-side extract parents
//      to it;
//   2. backdated spans give true durations;
//   3. the C9c corruption repro + whole-or-nothing fix: `sentry.dsc=k=v` +
//      `othervendor=xyz` in the active TraceState ⇒ carrier tracestate exactly
//      `othervendor=xyz`, zero junk keys (and a sentry-only tracestate
//      collapses to ABSENT);
//   4. flags-00 extracts as VALID (the explicit sampled-bit check is required
//      — validity does NOT imply sampled);
//   5. `context.with(ROOT_CONTEXT)` (withRootTrace) escapes suppressTracing.
// Standalone: no live Redis — the enqueue seam is the injected `add` callback.
// Run from packages/api:  npx tsx scripts/trace-probes/p-h-bullmq.ts
import {
  context,
  defaultTextMapGetter,
  ROOT_CONTEXT,
  SpanKind,
  trace,
  TraceFlags,
  type TraceState as ApiTraceState,
} from "@opentelemetry/api"
import {
  isTracingSuppressed,
  suppressTracing,
  W3CTraceContextPropagator,
} from "@opentelemetry/core"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import {
  injectTraceContext,
  sendWithProducerSpan,
  withRootTrace,
} from "../../src/workers/job-tracing.js"
import { check, finish } from "./_shared.js"

const exporter = new InMemorySpanExporter()
trace.setGlobalTracerProvider(
  new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
)
context.setGlobalContextManager(new AsyncLocalStorageContextManager())

const CARRIER_KEY = "__otelctx"
const w3c = new W3CTraceContextPropagator()
const tracer = trace.getTracer("p-h")

type Carrier = Record<string, string>
const carrierOf = (d: unknown): Carrier | undefined =>
  (d as Record<string, Carrier | undefined>)[CARRIER_KEY]

// ── 1. producer-span carrier injection + consumer parenting ────────────────
let sent: unknown
await sendWithProducerSpan("probe-queue", "probe-job", { a: 1 }, async (d) => {
  sent = d
  return { id: "42" }
})
const producer = exporter
  .getFinishedSpans()
  .find((s) => s.name === "send probe-queue")
check(
  "PRODUCER span `send {q}` exports with messaging attrs + message id",
  producer !== undefined &&
    producer.kind === SpanKind.PRODUCER &&
    producer.attributes["messaging.system"] === "bullmq" &&
    producer.attributes["messaging.message.id"] === "42",
  producer?.attributes
)
const injected = carrierOf(sent)
check(
  "carrier spanId === producer spanId (carrier minted INSIDE the span)",
  injected !== undefined &&
    producer !== undefined &&
    injected["traceparent"] ===
      `00-${producer.spanContext().traceId}-${producer.spanContext().spanId}-01`,
  injected
)
const consumerCtx = w3c.extract(ROOT_CONTEXT, injected, defaultTextMapGetter)
const consumerSpan = tracer.startSpan(
  "process probe-queue",
  { kind: SpanKind.CONSUMER },
  consumerCtx
)
consumerSpan.end()
const consumer = exporter
  .getFinishedSpans()
  .find((s) => s.name === "process probe-queue")
const consumerParentId =
  consumer?.parentSpanContext?.spanId ??
  (consumer as unknown as { parentSpanId?: string } | undefined)?.parentSpanId
check(
  "consumer-side extract parents the CONSUMER span to the producer span",
  producer !== undefined &&
    consumer !== undefined &&
    consumer.spanContext().traceId === producer.spanContext().traceId &&
    consumerParentId === producer.spanContext().spanId,
  { consumerParentId }
)

// ── 2. backdated spans give true durations ─────────────────────────────────
exporter.reset()
const backdated = tracer.startSpan("backdated", {
  startTime: Date.now() - 5_000,
})
backdated.end()
const back = exporter.getFinishedSpans()[0]!
check(
  "backdated startTime yields the TRUE (>=4s) duration",
  back.duration[0] >= 4,
  back.duration
)

// ── 3. C9c corruption repro + whole-or-nothing fix ─────────────────────────
// A validation-FREE TraceState, faithful to @sentry/opentelemetry's vendored
// implementation (core's own `set()` validates and silently DROPS `sentry.dsc`,
// masking the repro) — same fixture shape as job-tracing.test.ts.
function sentryStyleTraceState(
  entries: Array<[string, string]>
): ApiTraceState {
  const map = new Map(entries)
  return {
    get: (key) => map.get(key),
    set: (key, value) =>
      sentryStyleTraceState([
        ...entries.filter(([k]) => k !== key),
        [key, value],
      ]),
    unset: (key) => sentryStyleTraceState(entries.filter(([k]) => k !== key)),
    serialize: () => entries.map(([k, v]) => `${k}=${v}`).join(","),
  }
}
// Derive from context.active() (NOT ROOT_CONTEXT): injectTraceContext's
// stage-1 rebuild starts from the active context, so the suppression check
// below must see the suppressTracing key preserved under the span context.
const scWith = (ts: ApiTraceState) =>
  trace.setSpanContext(context.active(), {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
    traceState: ts,
  })
const mixed = context.with(
  scWith(
    sentryStyleTraceState([
      ["sentry.dsc", "k=v"],
      ["othervendor", "xyz"],
    ])
  ),
  () => carrierOf(injectTraceContext({ a: 1 }))
)
check(
  "C9c: sentry.dsc scrubbed at mint — carrier tracestate is EXACTLY othervendor=xyz",
  mixed !== undefined && mixed["tracestate"] === "othervendor=xyz",
  mixed
)
check(
  "C9c: zero junk keys leak into the carrier",
  mixed !== undefined &&
    !JSON.stringify(mixed).includes("sentry") &&
    !JSON.stringify(mixed).includes("k=v"),
  mixed
)
const sentryOnly = context.with(
  scWith(sentryStyleTraceState([["sentry.dsc", "k=v"]])),
  () => carrierOf(injectTraceContext({ a: 1 }))
)
check(
  "C9c: sentry-only tracestate collapses to ABSENT (never an empty header)",
  sentryOnly !== undefined &&
    sentryOnly["traceparent"] !== undefined &&
    !("tracestate" in sentryOnly),
  sentryOnly
)

// ── 4. flags-00 extracts as VALID ───────────────────────────────────────────
const unsampledCtx = w3c.extract(
  ROOT_CONTEXT,
  { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00" },
  defaultTextMapGetter
)
const unsampledSc = trace.getSpanContext(unsampledCtx)
check(
  "flags-00 extracts as a VALID span context (explicit sampled-bit check required)",
  unsampledSc !== undefined &&
    trace.isSpanContextValid(unsampledSc) &&
    (unsampledSc.traceFlags & TraceFlags.SAMPLED) === 0,
  unsampledSc
)

// ── 5. withRootTrace (context.with(ROOT_CONTEXT)) escapes suppressTracing ───
exporter.reset()
await context.with(suppressTracing(context.active()), async () => {
  check(
    "tick scope: isTracingSuppressed is ON",
    isTracingSuppressed(context.active())
  )
  const suppressedInject = context.with(
    scWith(sentryStyleTraceState([["othervendor", "xyz"]])),
    () => injectTraceContext({ a: 1 })
  )
  check(
    "under suppression the W3C inject is a no-op (no carrier key added)",
    carrierOf(suppressedInject) === undefined,
    suppressedInject
  )
  check(
    "withRootTrace escapes: isTracingSuppressed is OFF inside",
    withRootTrace(() => isTracingSuppressed(context.active())) === false
  )
  let rootSent: unknown
  await withRootTrace(() =>
    sendWithProducerSpan("root-queue", "root-job", { b: 2 }, async (d) => {
      rootSent = d
      return { id: "43" }
    })
  )
  const rootProducer = exporter
    .getFinishedSpans()
    .find((s) => s.name === "send root-queue")
  const rootCarrier = carrierOf(rootSent)
  check(
    "withRootTrace enqueue records a fresh PARENTLESS producer root + non-empty carrier",
    rootProducer !== undefined &&
      rootProducer.parentSpanContext === undefined &&
      rootCarrier !== undefined &&
      rootCarrier["traceparent"] ===
        `00-${rootProducer.spanContext().traceId}-${rootProducer.spanContext().spanId}-01`,
    { rootCarrier }
  )
})

finish("P-H")
