// Server-Timing trace exposure (plan §4.I change 4): the W3C trace-context
// Level 3 editor's-draft registered `trace` metric with the FULL
// `00-<trace>-<span>-<flags>` payload (a bare trace-id is invalid per the
// draft ABNF), NO `traceresponse` header anywhere, append-never-clobber
// merging, and the SYNAPSE_SERVER_TIMING_TRACE gate.
import assert from "node:assert/strict"
import { test } from "node:test"
import fastify from "fastify"
import { context, trace } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import serverTiming from "./server-timing.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})
context.setGlobalContextManager(new AsyncLocalStorageContextManager())
trace.setGlobalTracerProvider(provider)

const TRACE_METRIC_RE = /trace;desc=00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]/

async function buildApp(mode: string) {
  process.env.SYNAPSE_SERVER_TIMING_TRACE = mode
  const app = fastify()
  await app.register(serverTiming)
  app.get("/ok", async () => ({ ok: true }))
  app.get("/boom", async (_req, reply) => {
    return reply.status(500).send({ err: true })
  })
  app.get("/upstream", async (_req, reply) => {
    reply.header("server-timing", "db;dur=3.0")
    return { ok: true }
  })
  return app
}

/** Inject with an active recording span, as under real instrumentation. */
async function injectInSpan(
  app: Awaited<ReturnType<typeof buildApp>>,
  url: string
) {
  const tracer = trace.getTracer("server-timing-test")
  return tracer.startActiveSpan("request", async (span) => {
    try {
      return await app.inject({ method: "GET", url })
    } finally {
      span.end()
    }
  })
}

test("mode=on: full L3 trace metric matching the active span; NO traceresponse", async () => {
  const app = await buildApp("on")
  const res = await injectInSpan(app, "/ok")
  const header = res.headers["server-timing"]
  assert.ok(typeof header === "string")
  assert.match(header, TRACE_METRIC_RE)
  assert.match(header, /app;dur=\d/)
  // The desc payload is the active span's exact ids.
  const finished = exporter.getFinishedSpans().at(-1)!
  assert.ok(
    header.includes(
      `trace;desc=00-${finished.spanContext().traceId}-${finished.spanContext().spanId}-01`
    ),
    header
  )
  // The retired traceresponse header is GONE (zero W3C RECs define it).
  assert.equal(res.headers["traceresponse"], undefined)
  await app.close()
})

test("mode=errors (default): no trace metric on 200, trace metric on 500", async () => {
  const app = await buildApp("errors")
  const ok = await injectInSpan(app, "/ok")
  assert.doesNotMatch(String(ok.headers["server-timing"]), TRACE_METRIC_RE)
  assert.equal(ok.headers["traceresponse"], undefined)

  const boom = await injectInSpan(app, "/boom")
  assert.match(String(boom.headers["server-timing"]), TRACE_METRIC_RE)
  assert.equal(boom.headers["traceresponse"], undefined)
  await app.close()
})

test("mode=off: never a trace metric; app;dur still emitted", async () => {
  const app = await buildApp("off")
  const res = await injectInSpan(app, "/boom")
  const header = String(res.headers["server-timing"])
  assert.doesNotMatch(header, TRACE_METRIC_RE)
  assert.match(header, /app;dur=\d/)
  await app.close()
})

test("append-never-clobber: upstream Server-Timing is preserved, ours appended", async () => {
  const app = await buildApp("on")
  const res = await injectInSpan(app, "/upstream")
  const header = String(res.headers["server-timing"])
  assert.match(header, /^db;dur=3\.0, /)
  assert.match(header, TRACE_METRIC_RE)
  await app.close()
})

test("no active/valid span: no trace metric, no crash", async () => {
  const app = await buildApp("on")
  const res = await app.inject({ method: "GET", url: "/ok" })
  const header = String(res.headers["server-timing"])
  assert.doesNotMatch(header, TRACE_METRIC_RE)
  assert.equal(res.headers["traceresponse"], undefined)
  await app.close()
})
