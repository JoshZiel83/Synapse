// P-C (link fan-in) — §7 of
// docs/trace-correctness-remediation-plan-2026-07-12.md.
// On the installed sdk-trace-node: (1) creation-time links, (2) remote-parent
// extraction from a plain {traceparent, tracestate} carrier, (3) post-creation
// span.addLink, (4) malformed-extract ⇒ safe no-op (fresh root). Then the §4.C
// API span-shape assertions through the REAL production helpers
// (linkUpstreamTraces + extractEnvelopeTraceContext): a 2-origin
// fail-deliveries-style span without an inbound header is a fresh root with 2
// `remote_agent_delivery` links; a 1-origin span parented by that origin's
// header gets NO self-link.
// Run: npx tsx scripts/trace-probes/p-c-link-fan-in.ts
import {
  context,
  defaultTextMapGetter,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  trace,
} from "@opentelemetry/api"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node"
import { linkUpstreamTraces } from "../../src/workers/job-tracing.js"
import { extractEnvelopeTraceContext } from "../../src/infrastructure/observability/envelope-trace.js"
import { check, finish } from "./_shared.js"

const exporter = new InMemorySpanExporter()
trace.setGlobalTracerProvider(
  new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
)
propagation.setGlobalPropagator(new W3CTraceContextPropagator())
context.setGlobalContextManager(new AsyncLocalStorageContextManager())

const tracer = trace.getTracer("p-c")
const propagator = new W3CTraceContextPropagator()

const TRACE_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const TRACE_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const SPAN_1 = "1111111111111111"
const TP_A = `00-${TRACE_A}-${SPAN_1}-01`
const TP_B = `00-${TRACE_B}-${SPAN_1}-01`

function spanContextOf(traceparent: string) {
  return trace.getSpanContext(
    propagator.extract(ROOT_CONTEXT, { traceparent }, defaultTextMapGetter)
  )
}

// (1) creation-time links --------------------------------------------------
{
  exporter.reset()
  const links = [TP_A, TP_B].map((tp) => ({
    context: spanContextOf(tp)!,
    attributes: { "synapse.link.kind": "delivery_origin" },
  }))
  tracer.startSpan("creation-links", { kind: SpanKind.INTERNAL, links }).end()
  const [span] = exporter.getFinishedSpans()
  check("creation-time links recorded", span?.links.length === 2, span?.links)
  check(
    "creation-time link attributes survive",
    span?.links.every(
      (l) => l.attributes?.["synapse.link.kind"] === "delivery_origin"
    )
  )
  check(
    "creation-time link targets are the origin traces",
    span?.links[0]?.context.traceId === TRACE_A &&
      span?.links[1]?.context.traceId === TRACE_B
  )
}

// (2) remote-parent extraction from a plain carrier ------------------------
{
  exporter.reset()
  const parentCtx = propagation.extract(ROOT_CONTEXT, {
    traceparent: TP_A,
    tracestate: "congo=t61rcWkgMzE",
  })
  tracer.startActiveSpan("remote-parented", {}, parentCtx, (span) => {
    span.end()
  })
  const [span] = exporter.getFinishedSpans()
  check(
    "remote parent continues the carrier's trace",
    span?.spanContext().traceId === TRACE_A
  )
  check(
    "parent span id is the carrier's",
    span?.parentSpanContext?.spanId === SPAN_1,
    span?.parentSpanContext
  )
  check(
    "tracestate rides into the child span context",
    span?.spanContext().traceState?.get("congo") === "t61rcWkgMzE"
  )
}

// (3) post-creation addLink -------------------------------------------------
{
  exporter.reset()
  const span = tracer.startSpan("post-creation")
  span.addLink({
    context: spanContextOf(TP_B)!,
    attributes: { "synapse.link.kind": "delivery_origin" },
  })
  span.end()
  const [finished] = exporter.getFinishedSpans()
  check(
    "post-creation addLink recorded",
    finished?.links.length === 1 &&
      finished.links[0]?.context.traceId === TRACE_B
  )
}

// (4) malformed extract ⇒ safe no-op (fresh root) ---------------------------
{
  exporter.reset()
  const ctx = propagation.extract(ROOT_CONTEXT, { traceparent: "garbage" })
  check(
    "malformed carrier extracts to no span context",
    trace.getSpanContext(ctx) === undefined
  )
  tracer.startActiveSpan("fresh-root", {}, ctx, (span) => span.end())
  const [span] = exporter.getFinishedSpans()
  check(
    "span under malformed extract is a fresh root",
    span !== undefined &&
      span.parentSpanContext === undefined &&
      span.spanContext().traceId !== TRACE_A
  )
}

// (§4.C span shape) 2-origin fail-deliveries: fresh root + 2 links ----------
{
  exporter.reset()
  tracer.startActiveSpan(
    "POST fail-deliveries (2-origin)",
    { kind: SpanKind.SERVER },
    ROOT_CONTEXT,
    (span) => {
      context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
        linkUpstreamTraces([TP_A, TP_B], "remote_agent_delivery")
      })
      span.end()
    }
  )
  const [span] = exporter.getFinishedSpans()
  check("2-origin: fresh root", span?.parentSpanContext === undefined)
  check(
    "2-origin: exactly 2 remote_agent_delivery links",
    span?.links.length === 2 &&
      span.links.every(
        (l) => l.attributes?.["synapse.link.kind"] === "remote_agent_delivery"
      ),
    span?.links
  )
}

// (§4.C span shape) 1-origin + header: parented, no self-link ---------------
{
  exporter.reset()
  const parentCtx = extractEnvelopeTraceContext({ traceparent: TP_A })
  tracer.startActiveSpan(
    "POST fail-deliveries (1-origin)",
    { kind: SpanKind.SERVER },
    parentCtx,
    (span) => {
      context.with(trace.setSpan(parentCtx, span), () => {
        linkUpstreamTraces([TP_A], "remote_agent_delivery")
      })
      span.end()
    }
  )
  const [span] = exporter.getFinishedSpans()
  check(
    "1-origin: parented under the origin trace",
    span?.spanContext().traceId === TRACE_A &&
      span?.parentSpanContext?.spanId === SPAN_1
  )
  check("1-origin: no self-link", span?.links.length === 0, span?.links)
}

// unsampled origins are skipped (explicit sampled-bit check) ----------------
{
  exporter.reset()
  const TP_UNSAMPLED = `00-${TRACE_B}-${SPAN_1}-00`
  tracer.startActiveSpan("unsampled-links", {}, ROOT_CONTEXT, (span) => {
    context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
      linkUpstreamTraces([TP_UNSAMPLED], "remote_agent_delivery")
    })
    span.end()
  })
  const [span] = exporter.getFinishedSpans()
  check(
    "flags-00 origin is skipped and counted",
    span?.links.length === 0 &&
      span?.attributes["synapse.wakeup.links_skipped_unsampled"] === 1,
    span?.attributes
  )
}

finish("P-C")
