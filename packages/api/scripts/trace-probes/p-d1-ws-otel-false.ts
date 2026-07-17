// P-D1 (WS otel:false) — §7 of
// docs/trace-correctness-remediation-plan-2026-07-12.md.
// Against the installed (patched) @fastify/otel 0.19.x + @fastify/websocket:
//   1. WITHOUT config:{otel:false}, a WS upgrade STARTS a `request` span that
//      is still unended while the connection lives (the orphan the plan
//      kills at the source);
//   2. WITH config:{otel:false}, no request span is started for the upgrade;
//   3. envelope-extracted message spans are correctly remote-parented on the
//      frame's {traceparent, tracestate} (via the real
//      extractEnvelopeTraceContext helper);
//   4. tracestate round-trips through a queues-style inject (the private
//      W3CTraceContextPropagator pattern of workers/job-tracing.ts).
// Run: npx tsx scripts/trace-probes/p-d1-ws-otel-false.ts
import { once } from "node:events"
import {
  context,
  defaultTextMapSetter,
  propagation,
  trace,
  SpanKind,
} from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type Span as SdkSpan,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { FastifyOtelInstrumentation } from "@fastify/otel"
import Fastify from "fastify"
import websocket from "@fastify/websocket"
import WebSocket from "ws"
import { extractEnvelopeTraceContext } from "../../src/infrastructure/observability/envelope-trace.js"
import { check, finish } from "./_shared.js"

// ── provider with an onStart-collecting processor (mirrors the spike) ───────
const started: ReadableSpan[] = []
const ended: ReadableSpan[] = []
const exporter = new InMemorySpanExporter()
const collector = {
  onStart(span: SdkSpan) {
    started.push(span)
  },
  onEnd(span: ReadableSpan) {
    ended.push(span)
  },
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
}
const provider = new NodeTracerProvider({
  spanProcessors: [collector, new SimpleSpanProcessor(exporter)],
})
context.setGlobalContextManager(new AsyncLocalStorageContextManager())
trace.setGlobalTracerProvider(provider)
propagation.setGlobalPropagator(new W3CTraceContextPropagator())

const fastifyOtel = new FastifyOtelInstrumentation({ servername: "p-d1" })
fastifyOtel.setTracerProvider(provider)

const tracer = trace.getTracer("p-d1")
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const SPAN_ID = "b7ad6b7169203331"
const ENVELOPE = {
  type: "probe",
  traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
  tracestate: "vendor=abc",
}

// ── app: one traced WS route, one config:{otel:false} WS route ──────────────
const app = Fastify()
await app.register(fastifyOtel.plugin())
await app.register(websocket)

let messageSpanDone: (carrier: Record<string, string>) => void
const messageSpanCarrier = new Promise<Record<string, string>>((resolve) => {
  messageSpanDone = resolve
})

app.get("/ws-traced", { websocket: true }, (socket: any) => {
  socket.on("message", () => socket.send("ack"))
})

app.get(
  "/ws-off",
  { websocket: true, config: { otel: false } },
  (socket: any) => {
    socket.on("message", (raw: any) => {
      const envelope = JSON.parse(String(raw)) as Record<string, unknown>
      tracer.startActiveSpan(
        "ws.frame",
        { kind: SpanKind.CONSUMER },
        extractEnvelopeTraceContext(envelope),
        (span) => {
          // queues-style inject INSIDE the message span context: a private
          // W3CTraceContextPropagator writing a plain-object carrier
          // (workers/job-tracing.ts injectTraceContext pattern).
          const carrier: Record<string, string> = {}
          new W3CTraceContextPropagator().inject(
            context.active(),
            carrier,
            defaultTextMapSetter
          )
          span.end()
          messageSpanDone(carrier)
        }
      )
      socket.send("ack")
    })
  }
)

await app.listen({ port: 0, host: "127.0.0.1" })
const { port } = app.server.address() as { port: number }

function requestSpansStarted(): ReadableSpan[] {
  return started.filter((s) => s.name === "request")
}

// ── claim 1: upgrade WITHOUT otel:false starts a never-ending request span ──
const wsTraced = new WebSocket(`ws://127.0.0.1:${port}/ws-traced`)
await once(wsTraced, "open")
wsTraced.send("hello")
await once(wsTraced, "message")
const startedForTraced = requestSpansStarted().length
check(
  "upgrade WITHOUT otel:false STARTS a `request` span",
  startedForTraced === 1,
  startedForTraced
)
check(
  "…and it has NOT ended while the connection is live (the orphan)",
  ended.filter((s) => s.name === "request").length === 0,
  ended.map((s) => s.name)
)

// ── claim 2: upgrade WITH otel:false starts NO request span ─────────────────
const wsOff = new WebSocket(`ws://127.0.0.1:${port}/ws-off`)
await once(wsOff, "open")
wsOff.send(JSON.stringify(ENVELOPE))
await once(wsOff, "message")
check(
  "upgrade WITH config:{otel:false} starts NO request span",
  requestSpansStarted().length === startedForTraced,
  requestSpansStarted().length
)

// ── claim 3: envelope-extracted message span is correctly remote-parented ───
const carrier = await messageSpanCarrier
await provider.forceFlush()
const frameSpan = exporter.getFinishedSpans().find((s) => s.name === "ws.frame")
check("message span exported", Boolean(frameSpan))
check(
  "message span continues the envelope's trace",
  frameSpan?.spanContext().traceId === TRACE_ID,
  frameSpan?.spanContext().traceId
)
check(
  "message span is REMOTE-parented on the envelope's span id",
  frameSpan?.parentSpanContext?.spanId === SPAN_ID &&
    frameSpan?.parentSpanContext?.isRemote === true,
  frameSpan?.parentSpanContext
)

// ── claim 4: tracestate round-trips through the queues-style inject ─────────
check(
  "injected carrier stays in the envelope's trace",
  typeof carrier.traceparent === "string" &&
    carrier.traceparent.includes(TRACE_ID),
  carrier
)
check(
  "tracestate round-trips verbatim",
  carrier.tracestate === "vendor=abc",
  carrier
)

wsTraced.close()
wsOff.close()
await app.close()
await provider.shutdown()
finish("P-D1")
