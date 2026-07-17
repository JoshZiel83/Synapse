// withImInboundSpan (plan §4.I change 6): fresh-root CONSUMER span around the
// socket-mode emitInbound seam — named per the messaging-semconv template,
// always a fresh root (never parented on ambient state), records inside
// suppressed scopes (ROOT_CONTEXT drops the suppressTracing key), and makes
// the trace visible to session/repo.ts's activeTraceparent() so
// session_wakeups.origin_traceparent is finally populated for IM turns.
import assert from "node:assert/strict"
import { test } from "node:test"
import { context, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { suppressTracing } from "@opentelemetry/core"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { TRACEPARENT_RE } from "@synapse/shared"
import { nowIsoInstant } from "@synapse/shared/datetime"
import type { TransportAccountSummary } from "@synapse/shared/types"
import { activeTraceparent } from "../../infrastructure/observability/traceparent.js"
import { withImInboundSpan } from "./tracing.js"

// Real provider + in-memory exporter, mirroring instrumentation.ts's
// register() shape (context manager + provider) at unit scale.
const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})
context.setGlobalContextManager(new AsyncLocalStorageContextManager())
trace.setGlobalTracerProvider(provider)

const ACCOUNT: TransportAccountSummary = {
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  transportKind: "telegram",
  accountKey: "bot-123",
  displayName: "Test Bot",
  ownerScope: "workspace",
  inboundActorMode: "none",
  connectionMode: "long_connection",
  status: "active",
  config: {},
  metadata: {},
  createdAt: nowIsoInstant(),
  updatedAt: nowIsoInstant(),
}

test("fresh-root `process telegram` CONSUMER span with messaging semconv; active inside fn", async () => {
  exporter.reset()
  let insideTraceparent: string | undefined
  const result = await withImInboundSpan(ACCOUNT, async () => {
    insideTraceparent = activeTraceparent()
    return "ingested"
  })
  assert.equal(result, "ingested")

  const spans = exporter.getFinishedSpans()
  assert.equal(spans.length, 1)
  const span = spans[0]!
  assert.equal(span.name, "process telegram")
  assert.equal(span.kind, SpanKind.CONSUMER)
  // Fresh root — no parent.
  assert.equal(span.parentSpanContext, undefined)
  assert.equal(span.attributes["messaging.system"], "telegram")
  assert.equal(span.attributes["messaging.operation.type"], "process")
  assert.equal(span.attributes["messaging.destination.name"], "telegram")
  assert.equal(span.attributes["synapse.im.account_id"], ACCOUNT.id)
  assert.equal(span.attributes["synapse.workspace_id"], ACCOUNT.workspaceId)

  // The property session/repo.ts depends on: a valid traceparent is active
  // inside fn, so origin_traceparent capture works with zero changes there.
  assert.ok(insideTraceparent, "activeTraceparent() must see the span")
  assert.match(insideTraceparent, TRACEPARENT_RE)
  assert.equal(insideTraceparent.slice(3, 35), span.spanContext().traceId)
})

test("fresh root even under an active ambient span (never parents on connection-lifetime state)", async () => {
  exporter.reset()
  const tracer = trace.getTracer("test-ambient")
  await tracer.startActiveSpan("connection-lifetime", async (ambient) => {
    await withImInboundSpan(ACCOUNT, async () => {})
    ambient.end()
  })
  const inbound = exporter
    .getFinishedSpans()
    .find((s) => s.name === "process telegram")
  assert.ok(inbound)
  assert.equal(inbound.parentSpanContext, undefined)
  assert.notEqual(
    inbound.spanContext().traceId,
    exporter
      .getFinishedSpans()
      .find((s) => s.name === "connection-lifetime")!
      .spanContext().traceId
  )
})

test("records + exports even when emitted from inside a suppressTracing scope", async () => {
  exporter.reset()
  await context.with(suppressTracing(context.active()), () =>
    withImInboundSpan(ACCOUNT, async () => {})
  )
  const spans = exporter.getFinishedSpans()
  assert.equal(spans.length, 1)
  assert.equal(spans[0]!.name, "process telegram")
})

test("throw ⇒ recordException + ERROR status, error rethrown, span ended", async () => {
  exporter.reset()
  const boom = new Error("ingest exploded")
  await assert.rejects(
    withImInboundSpan(ACCOUNT, async () => {
      throw boom
    }),
    boom
  )
  const spans = exporter.getFinishedSpans()
  assert.equal(spans.length, 1)
  const span = spans[0]!
  assert.equal(span.status.code, SpanStatusCode.ERROR)
  assert.equal(span.status.message, "ingest exploded")
  const exceptions = span.events.filter((e) => e.name === "exception")
  assert.equal(exceptions.length, 1)
})
