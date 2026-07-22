/**
 * P-I1 — patched @fastify/otel behavior matrix (trace remediation plan §7).
 *
 * Validates the HOST tree's patched @fastify/otel — the patch is applied by
 * `patches/@fastify+otel+*.patch` (version-agnostic; the filename is NOT pinned
 * here). This probe proves the HOST node_modules copy behaves; the applied
 * ARTIFACT inside each shipped image is proven separately by cluster A's
 * in-image apply-and-assert (scripts/apply-patches.mjs). InMemorySpanExporter,
 * no live services. Three scenarios:
 *
 *   A. STANDALONE (plugin only) — the OTel HTTP semconv matrix the patch enforces:
 *      400/404 ⇒ request span status UNSET + zero exception events; 500 ⇒ ERROR +
 *      exactly ONE exception event (never duplicated on the handler span); and an
 *      ABORTED hijacked stream (writeHead + write, NEVER end — the reverse-MCP SSE
 *      shape) still ENDS the request span via the patch's reply.raw 'close' ender.
 *      `request` is SERVER here (upstream's standalone kind).
 *   B. HTTP-PRESENT (plugin + HttpInstrumentation) — 0.20.1 demotes the fastify
 *      `request` span to INTERNAL whenever an upstream HTTP SERVER span exists, so
 *      one served request yields EXACTLY ONE SERVER span (node:http) with `request`
 *      INTERNAL nested under it. This is the PRODUCTION shape; the old probe
 *      registered only the plugin and was blind to the double-SERVER span (R3).
 *   C. instrumentHooks:false — ZERO `fastify.type: "hook"` lifecycle-hook spans
 *      while the `request` span AND the route `handler` span (fastify.type:
 *      "request-handler", carries http.route) both survive.
 *
 * Run from packages/api:  npx tsx scripts/trace-probes/p-i1-fastify-otel-patch.ts
 * Exits non-zero on the first failed assertion.
 */
// NB: `fastify` is imported DYNAMICALLY inside main() — it must load node:http
// AFTER HttpInstrumentation.enable() so scenario B's SERVER-span patch actually
// takes (require-in-the-middle cannot patch an already-cached module). A static
// `import Fastify from "fastify"` at the top would load http first and defeat it.
import assert from "node:assert/strict"
import { FastifyOtelInstrumentation } from "@fastify/otel"
import { context, SpanKind, SpanStatusCode } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { registerInstrumentations } from "@opentelemetry/instrumentation"
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import type { FastifyInstance } from "fastify"

type FastifyFactory = (typeof import("fastify"))["default"]

function exceptionEvents(span: ReadableSpan) {
  return span.events.filter((e) => e.name === "exception")
}

async function waitFor(what: string, predicate: () => boolean) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** A minimal error handler mirroring src/index.ts: 4xx statusCode ⇒ that status,
 * everything else ⇒ 500 — exercises the onError-before-error-handler ordering the
 * patch's kRequestError stash exists for. */
function withErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      typeof error.statusCode === "number" && error.statusCode >= 400
        ? error.statusCode
        : 500
    return reply.status(statusCode).send({ error: error.message })
  })
}

// ── Scenario A — standalone semconv matrix + aborted-hijack ender ─────────────
async function scenarioStandalone(Fastify: FastifyFactory) {
  const exporter = new InMemorySpanExporter()
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  const fastifyOtel = new FastifyOtelInstrumentation()
  fastifyOtel.setTracerProvider(provider)

  const requestSpan = (path: string): ReadableSpan => {
    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "request" && s.attributes["url.path"] === path)
    assert.ok(span, `request span for ${path} not exported (never ended?)`)
    return span
  }
  const handlerSpans = (path: string): ReadableSpan[] =>
    exporter
      .getFinishedSpans()
      .filter(
        (s) =>
          s.kind === SpanKind.INTERNAL &&
          s.attributes["http.route"] === path &&
          s.attributes["fastify.type"] === "request-handler"
      )

  const app = Fastify()
  await app.register(fastifyOtel.plugin())
  withErrorHandler(app)

  app.get("/client-error", async () => {
    throw Object.assign(new Error("bad client input"), { statusCode: 400 })
  })
  app.get("/server-error", async () => {
    throw new Error("boom")
  })
  // Aborted hijacked SSE: hijack, write headers + a chunk, NEVER end. onSend/
  // onResponse never run (they fire on the raw response's 'finish' event, which
  // an aborted stream never emits) — only the patch's reply.raw 'close' ender
  // ends the span. Against an UNPATCHED tree this route's request span never
  // exports and the assertion below times out (the intended negative control).
  app.get("/hijack-abort", (_request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, { "content-type": "text/event-stream" })
    reply.raw.write("data: hello\n\n")
  })

  await app.listen({ host: "127.0.0.1", port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address === "object")
  const base = `http://127.0.0.1:${address.port}`

  // 400 (thrown, error-handler-mapped) ⇒ UNSET + zero exception events
  assert.equal((await fetch(`${base}/client-error`)).status, 400)
  const clientError = requestSpan("/client-error")
  assert.equal(
    clientError.kind,
    SpanKind.SERVER,
    "standalone request span is SERVER"
  )
  assert.equal(clientError.status.code, SpanStatusCode.UNSET)
  assert.equal(exceptionEvents(clientError).length, 0)
  assert.equal(clientError.attributes["http.response.status_code"], 400)
  console.log("PASS A: 400 ⇒ status UNSET + zero exception events")

  // 404 (no route) ⇒ UNSET + zero exception events
  assert.equal((await fetch(`${base}/nope`)).status, 404)
  const notFound = requestSpan("/nope")
  assert.equal(notFound.status.code, SpanStatusCode.UNSET)
  assert.equal(exceptionEvents(notFound).length, 0)
  assert.equal(notFound.attributes["http.response.status_code"], 404)
  console.log("PASS A: 404 ⇒ status UNSET + zero exception events")

  // 500 ⇒ ERROR + exactly ONE exception event on the whole request
  assert.equal((await fetch(`${base}/server-error`)).status, 500)
  const serverError = requestSpan("/server-error")
  assert.equal(serverError.status.code, SpanStatusCode.ERROR)
  assert.equal(serverError.status.message, "boom")
  assert.equal(exceptionEvents(serverError).length, 1)
  const totalExceptionEvents = exporter
    .getFinishedSpans()
    .filter(
      (s) => s.spanContext().traceId === serverError.spanContext().traceId
    )
    .flatMap(exceptionEvents).length
  assert.equal(totalExceptionEvents, 1)
  console.log("PASS A: 500 ⇒ status ERROR + exactly one exception event")

  // INTERNAL handler spans: keep ERROR status, drop duplicate events
  for (const path of ["/client-error", "/server-error"]) {
    const [handler, ...rest] = handlerSpans(path)
    assert.ok(handler, `handler span for ${path} not exported`)
    assert.equal(rest.length, 0)
    assert.equal(handler.status.code, SpanStatusCode.ERROR)
    assert.equal(exceptionEvents(handler).length, 0)
  }
  console.log(
    "PASS A: INTERNAL handler spans keep status, zero exception events"
  )

  // Aborted hijacked stream ⇒ request span still ends on reply.raw 'close'.
  const ac = new AbortController()
  const res = await fetch(`${base}/hijack-abort`, { signal: ac.signal })
  const reader = res.body?.getReader()
  await reader?.read() // one SSE chunk, proving the stream is live and hijacked
  ac.abort() // client aborts WITHOUT the server ever calling reply.raw.end()
  await reader?.cancel().catch(() => {})
  await waitFor("aborted-hijack request span", () =>
    exporter
      .getFinishedSpans()
      .some(
        (s) =>
          s.name === "request" && s.attributes["url.path"] === "/hijack-abort"
      )
  )
  console.log(
    "PASS A: aborted hijacked stream ⇒ request span ended on raw 'close' (unpatched ⇒ this times out)"
  )

  // The aborted hijacked connection can linger in the server's socket set, so
  // app.close()'s graceful drain would hang — force any straggler sockets shut.
  app.server.closeAllConnections?.()
  await app.close()
  await provider.shutdown()
}

// ── Scenario B — http-present: exactly one SERVER span, request INTERNAL ──────
// HttpInstrumentation + fastifyOtel are registered in main() BEFORE fastify is
// dynamic-imported (so node:http is patched when fastify loads it); this scenario
// just drives one request against that already-live registration.
async function scenarioHttpPresent(
  Fastify: FastifyFactory,
  provider: NodeTracerProvider,
  exporter: InMemorySpanExporter,
  fastifyOtel: FastifyOtelInstrumentation
) {
  const app = Fastify()
  await app.register(fastifyOtel.plugin())
  app.get("/normal", async () => ({ ok: true }))
  await app.listen({ host: "127.0.0.1", port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address === "object")
  const base = `http://127.0.0.1:${address.port}`

  assert.equal((await fetch(`${base}/normal`)).status, 200)
  await waitFor("http SERVER span", () =>
    exporter.getFinishedSpans().some((s) => s.kind === SpanKind.SERVER)
  )

  const serverSpans = exporter
    .getFinishedSpans()
    .filter((s) => s.kind === SpanKind.SERVER)
  assert.equal(
    serverSpans.length,
    1,
    `exactly ONE SERVER span expected (0.20.1 demotes fastify request to INTERNAL), got ${serverSpans.length}`
  )
  const serverSpan = serverSpans[0]!
  const fastifyRequest = exporter
    .getFinishedSpans()
    .find((s) => s.name === "request" && s.attributes["url.path"] === "/normal")
  assert.ok(fastifyRequest, "fastify request span must export")
  assert.equal(
    fastifyRequest.kind,
    SpanKind.INTERNAL,
    "fastify request span is INTERNAL under an upstream HTTP SERVER span"
  )
  assert.equal(
    fastifyRequest.parentSpanContext?.spanId,
    serverSpan.spanContext().spanId,
    "fastify request span parents to the node:http SERVER span"
  )
  console.log(
    "PASS B: exactly one SERVER span, fastify request INTERNAL beneath it (double-SERVER span fixed)"
  )

  await app.close()
  // provider shutdown + httpInstr.disable() happen in main() after this returns.
}

// ── Scenario C — instrumentHooks:false span budget ───────────────────────────
async function scenarioNoHookSpans(Fastify: FastifyFactory) {
  const exporter = new InMemorySpanExporter()
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  const fastifyOtel = new FastifyOtelInstrumentation({ instrumentHooks: false })
  fastifyOtel.setTracerProvider(provider)

  const app = Fastify()
  await app.register(fastifyOtel.plugin())
  app.get("/budget", async () => ({ ok: true }))
  await app.listen({ host: "127.0.0.1", port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address === "object")
  const base = `http://127.0.0.1:${address.port}`

  assert.equal((await fetch(`${base}/budget`)).status, 200)
  await waitFor("request span", () =>
    exporter.getFinishedSpans().some((s) => s.name === "request")
  )

  const spans = exporter.getFinishedSpans()
  const hookSpans = spans.filter((s) => s.attributes["fastify.type"] === "hook")
  assert.equal(
    hookSpans.length,
    0,
    `instrumentHooks:false ⇒ zero fastify.type:"hook" spans, got ${hookSpans.length}`
  )
  assert.ok(
    spans.some((s) => s.name === "request"),
    "the request span survives instrumentHooks:false"
  )
  assert.ok(
    spans.some(
      (s) =>
        s.attributes["fastify.type"] === "request-handler" &&
        s.attributes["http.route"] === "/budget"
    ),
    "the route handler span (with http.route) survives instrumentHooks:false"
  )
  console.log(
    "PASS C: instrumentHooks:false ⇒ zero hook spans; request + handler survive"
  )

  await app.close()
  await provider.shutdown()
}

async function main() {
  // A real context manager is required for cross-instrumentation context to
  // flow — without it context.active() is always ROOT, so @fastify/otel's
  // getRPCMetadata() sees no upstream HTTP SERVER span and never demotes the
  // request span to INTERNAL (the demotion is exactly scenario B's assertion).
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable()
  )

  // Scenario B needs HttpInstrumentation live BEFORE node:http is first required
  // (require-in-the-middle cannot patch an already-cached module), so register it
  // here, THEN dynamic-import fastify (whose module init requires http → patched).
  // After B, disable() it so the standalone scenarios see an UNPATCHED http and
  // the fastify request span stays SERVER (upstream's standalone kind).
  const httpExporter = new InMemorySpanExporter()
  const httpProvider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(httpExporter)],
  })
  const httpInstr = new HttpInstrumentation()
  const bFastifyOtel = new FastifyOtelInstrumentation()
  registerInstrumentations({
    tracerProvider: httpProvider,
    instrumentations: [httpInstr, bFastifyOtel],
  })
  const Fastify = (await import("fastify")).default

  await scenarioHttpPresent(Fastify, httpProvider, httpExporter, bFastifyOtel)

  httpInstr.disable()
  bFastifyOtel.disable()
  await httpProvider.shutdown()

  await scenarioStandalone(Fastify)
  await scenarioNoHookSpans(Fastify)
  console.log("P-I1: ALL PASS")
}

main().catch((error) => {
  console.error("P-I1: FAIL")
  console.error(error)
  process.exit(1)
})
