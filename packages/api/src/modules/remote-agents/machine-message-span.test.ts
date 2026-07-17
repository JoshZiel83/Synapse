import assert from "node:assert/strict"
import { test } from "node:test"

import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"

import { activeTraceparent } from "../../infrastructure/observability/traceparent.js"
import { runMachineMessageSpan } from "./service.js"

// ─── runMachineMessageSpan (§4.C — the "dead stamping" fix's SERVER span) ───
//
// One SERVER span per work-triggering daemon→api machine message, remote-
// parented on the message's envelope {traceparent, tracestate} fields — the
// span that makes activeTraceCarrier()/activeTraceparent() non-null inside
// the agent:start send path. Driven directly via the exported seam (the
// production dispatch sites live inside the WS socket handler).

const exporter = new InMemorySpanExporter()
trace.setGlobalTracerProvider(
  new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
)
context.setGlobalContextManager(new AsyncLocalStorageContextManager())
propagation.setGlobalPropagator(new W3CTraceContextPropagator())

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const SPAN_ID = "b7ad6b7169203331"

type MachineStatusMessage = Parameters<typeof runMachineMessageSpan>[1]

function statusMessage(
  overrides: Record<string, unknown> = {}
): MachineStatusMessage {
  return {
    type: "agent:status",
    remoteAgentId: "00000000-0000-4000-8000-000000000031",
    conversationId: "00000000-0000-4000-8000-000000000032",
    state: "running",
    ...overrides,
  } as unknown as MachineStatusMessage
}

test("runMachineMessageSpan: ONE SERVER span remote-parented on the envelope fields; activeTraceparent() live inside fn", async () => {
  exporter.reset()
  let insideTraceparent: string | undefined
  const out = await runMachineMessageSpan(
    "machine-1",
    statusMessage({
      traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
      tracestate: "othervendor=xyz",
    }),
    async () => {
      // The §4.C fix: the formerly-dead agent:start stamping reads a REAL
      // value here (activeTraceCarrier() is built on the same active span).
      insideTraceparent = activeTraceparent()
      return "handled"
    }
  )
  assert.equal(out, "handled", "fn's result passes through")

  const spans = exporter.getFinishedSpans()
  assert.equal(spans.length, 1, "exactly one machine-message span")
  const span = spans[0]!
  assert.equal(span.name, "ws.agent:status")
  assert.equal(span.kind, SpanKind.SERVER)
  assert.equal(span.spanContext().traceId, TRACE_ID)
  assert.equal(span.parentSpanContext?.spanId, SPAN_ID)
  assert.equal(span.parentSpanContext?.isRemote, true)
  assert.equal(span.attributes["synapse.ws.surface"], "remote-agents")
  assert.equal(span.attributes["synapse.ws.frame_type"], "agent:status")
  assert.equal(span.attributes["synapse.machine.id"], "machine-1")
  assert.equal(
    span.attributes["synapse.remote_agent.id"],
    "00000000-0000-4000-8000-000000000031"
  )
  assert.equal(
    insideTraceparent,
    `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`,
    "activeTraceparent() inside fn IS the machine-message span"
  )
})

test("runMachineMessageSpan: untraced/garbage envelope ⇒ fresh ROOT (never the ambient context)", async () => {
  exporter.reset()
  // Even under a foreign ambient span (ALS bleed stand-in), the message span
  // must extract-or-ROOT — never silently continue the ambient trace.
  const foreign = trace.setSpanContext(context.active(), {
    traceId: "1af7651916cd43dd8448eb211c80319d",
    spanId: "c7ad6b7169203332",
    traceFlags: 1,
    isRemote: true,
  })
  await context.with(foreign, () =>
    runMachineMessageSpan(
      "machine-1",
      statusMessage({ traceparent: "garbage" }),
      async () => undefined
    )
  )
  const span = exporter.getFinishedSpans()[0]!
  assert.equal(span.parentSpanContext, undefined, "fresh root")
  assert.notEqual(
    span.spanContext().traceId,
    "1af7651916cd43dd8448eb211c80319d"
  )
})

test("runMachineMessageSpan: a throwing fn records ERROR + exception and rethrows; span still ends", async () => {
  exporter.reset()
  const boom = new Error("handler exploded")
  await assert.rejects(
    () =>
      runMachineMessageSpan("machine-1", statusMessage(), async () => {
        throw boom
      }),
    boom,
    "the error must reach the socket handler's error path unchanged"
  )
  const spans = exporter.getFinishedSpans()
  assert.equal(spans.length, 1, "the span still exports (finally-end)")
  const span = spans[0]!
  assert.equal(span.status.code, SpanStatusCode.ERROR)
  const exception = span.events.find((e) => e.name === "exception")
  assert.ok(exception)
  assert.equal(exception.attributes?.["exception.message"], "handler exploded")
})
