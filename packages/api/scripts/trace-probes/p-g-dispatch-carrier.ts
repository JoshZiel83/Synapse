// P-G (dispatch carrier) — §7 of
// docs/trace-correctness-remediation-plan-2026-07-12.md.
// Recreated by the Phase-3 gate runner (the design-phase spike lived in a
// session scratchpad; §7 says commit on first use). Pins the §4.G dispatch
// pattern against the installed tree:
//   1. a `suppressTracing`-wrapped fetch produces NO instrumentation-undici
//      span and NO injected headers, while the surrounding manual CLIENT span
//      still exports (the single-CLIENT-edge shape of devices/dispatch.ts);
//   2. the hand-built `_meta` carrier (activeTraceCarrier, THE canonical mint)
//      carries the manual span's exact ids;
//   3. a hand-built carrier inherits the parent's tracestate verbatim.
// Standalone: spins its own echo server, no live services. Run from
// packages/api:  npx tsx scripts/trace-probes/p-g-dispatch-carrier.ts
import http from "node:http"
import { once } from "node:events"
import { context, propagation, SpanKind, trace } from "@opentelemetry/api"
import {
  suppressTracing,
  TraceState,
  W3CTraceContextPropagator,
} from "@opentelemetry/core"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { registerInstrumentations } from "@opentelemetry/instrumentation"
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { activeTraceCarrier } from "../../src/infrastructure/observability/traceparent.js"
import { check, finish } from "./_shared.js"

const exporter = new InMemorySpanExporter()
trace.setGlobalTracerProvider(
  new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
)
propagation.setGlobalPropagator(new W3CTraceContextPropagator())
context.setGlobalContextManager(new AsyncLocalStorageContextManager())
registerInstrumentations({ instrumentations: [new UndiciInstrumentation()] })

const tracer = trace.getTracer("p-g")

// Echo server capturing each request's trace headers.
const seen: Array<Record<string, string | string[] | undefined>> = []
const server = http.createServer((req, res) => {
  seen.push({
    traceparent: req.headers["traceparent"],
    tracestate: req.headers["tracestate"],
  })
  res.writeHead(200)
  res.end("ok")
})
server.listen(0, "127.0.0.1")
await once(server, "listening")
const addr = server.address()
const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/echo`

// ── control: an UNsuppressed fetch inside a span injects + emits an undici
// span (proves the harness would catch a leak) ───────────────────────────────
await tracer.startActiveSpan(
  "control",
  { kind: SpanKind.CLIENT },
  async (span) => {
    await (await fetch(url)).arrayBuffer()
    span.end()
  }
)
const controlSpans = exporter.getFinishedSpans()
check(
  "control: unsuppressed fetch injects traceparent on the wire",
  typeof seen[0]?.traceparent === "string"
)
check(
  "control: unsuppressed fetch emits an instrumentation-undici CLIENT span",
  controlSpans.some(
    (s) =>
      s.instrumentationScope.name === "@opentelemetry/instrumentation-undici"
  ),
  controlSpans.map((s) => s.instrumentationScope.name)
)
exporter.reset()

// ── the §4.G dispatch shape: manual CLIENT span + carrier mint + suppressed
// fetch ──────────────────────────────────────────────────────────────────────
let carrier: { traceparent: string; tracestate?: string } | undefined
let manualSpanId = ""
let manualTraceId = ""
await tracer.startActiveSpan(
  "tools/call probe_tool",
  { kind: SpanKind.CLIENT },
  async (span) => {
    manualSpanId = span.spanContext().spanId
    manualTraceId = span.spanContext().traceId
    carrier = activeTraceCarrier()
    await context.with(suppressTracing(context.active()), async () => {
      await (await fetch(url)).arrayBuffer()
    })
    span.end()
  }
)
const wire = seen[1]
check(
  "suppressTracing-wrapped fetch injects NO trace headers on the wire",
  wire !== undefined &&
    wire.traceparent === undefined &&
    wire.tracestate === undefined,
  wire
)
const shapeSpans = exporter.getFinishedSpans()
check(
  "suppressTracing-wrapped fetch produces NO undici span",
  !shapeSpans.some(
    (s) =>
      s.instrumentationScope.name === "@opentelemetry/instrumentation-undici"
  ),
  shapeSpans.map((s) => [s.name, s.instrumentationScope.name])
)
check(
  "the manual CLIENT span still exports (exactly one span, the dispatch edge)",
  shapeSpans.length === 1 &&
    shapeSpans[0]!.name === "tools/call probe_tool" &&
    shapeSpans[0]!.kind === SpanKind.CLIENT,
  shapeSpans.map((s) => s.name)
)
check(
  "hand-built carrier (activeTraceCarrier) carries the manual span's exact ids",
  carrier !== undefined &&
    carrier.traceparent === `00-${manualTraceId}-${manualSpanId}-01`,
  carrier
)

// ── tracestate inheritance: the carrier minted under a remote parent that
// carries vendor tracestate forwards it verbatim ─────────────────────────────
exporter.reset()
const parentCtx = trace.setSpanContext(context.active(), {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: 1,
  isRemote: true,
  traceState: new TraceState("es=s:1.0"),
})
let inherited: { traceparent: string; tracestate?: string } | undefined
context.with(parentCtx, () => {
  tracer.startActiveSpan("child", { kind: SpanKind.CLIENT }, (span) => {
    inherited = activeTraceCarrier()
    span.end()
  })
})
check(
  "carrier under a tracestate-bearing parent inherits the parent's tracestate",
  inherited?.tracestate === "es=s:1.0",
  inherited
)
check(
  "inherited carrier stays in the parent's trace with the CHILD's span id",
  inherited !== undefined &&
    inherited.traceparent.startsWith("00-0af7651916cd43dd8448eb211c80319c-") &&
    !inherited.traceparent.includes("b7ad6b7169203331"),
  inherited
)

server.close()
finish("P-G")
