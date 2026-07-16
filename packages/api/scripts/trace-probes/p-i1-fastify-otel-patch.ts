/**
 * P-I1 — patched @fastify/otel behavior matrix (trace remediation plan §7).
 *
 * Runs against the REPO's installed node_modules (i.e. the patched plugin from
 * patches/@fastify+otel+0.19.0.patch) with an InMemorySpanExporter — no live
 * services. Asserts the OTel HTTP semconv matrix the patch exists to enforce:
 *
 *   400/404  ⇒ request SERVER span status UNSET + zero exception events
 *   500      ⇒ request SERVER span status ERROR + exactly ONE exception event
 *   INTERNAL handler spans keep ERROR status but carry NO duplicate exception
 *   events (the single event lives on the request span)
 *   hijacked reply ⇒ the request span still ENDS (via reply.raw 'close')
 *
 * Run from packages/api:  npx tsx scripts/trace-probes/p-i1-fastify-otel-patch.ts
 * Exits non-zero on the first failed assertion.
 */
import assert from "node:assert/strict"
import Fastify from "fastify"
import { FastifyOtelInstrumentation } from "@fastify/otel"
import { SpanKind, SpanStatusCode } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

const fastifyOtelInstrumentation = new FastifyOtelInstrumentation()
fastifyOtelInstrumentation.setTracerProvider(provider)

function requestSpan(path: string): ReadableSpan {
  const span = exporter
    .getFinishedSpans()
    .find((s) => s.name === "request" && s.attributes["url.path"] === path)
  assert.ok(span, `request span for ${path} not exported (never ended?)`)
  return span
}

function handlerSpans(path: string): ReadableSpan[] {
  return exporter
    .getFinishedSpans()
    .filter(
      (s) =>
        s.kind === SpanKind.INTERNAL &&
        s.attributes["http.route"] === path &&
        s.attributes["fastify.type"] === "request-handler"
    )
}

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

async function main() {
  const app = Fastify()
  await app.register(fastifyOtelInstrumentation.plugin())

  // Mirrors src/index.ts's setErrorHandler shape: thrown errors with a 4xx
  // statusCode answer with that status, everything else becomes a 500 — so the
  // probe exercises exactly the onError-before-error-handler ordering the
  // patch's kRequestError stash exists for.
  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      typeof error.statusCode === "number" && error.statusCode >= 400
        ? error.statusCode
        : 500
    return reply.status(statusCode).send({ error: error.message })
  })

  app.get("/client-error", async () => {
    throw Object.assign(new Error("bad client input"), { statusCode: 400 })
  })
  app.get("/server-error", async () => {
    throw new Error("boom")
  })
  app.get("/hijack", (_request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, { "content-type": "text/plain" })
    reply.raw.end("hijacked")
  })

  await app.listen({ host: "127.0.0.1", port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address === "object")
  const base = `http://127.0.0.1:${address.port}`

  // ── 400 (thrown, error-handler-mapped) ⇒ UNSET + zero exception events ────
  assert.equal((await fetch(`${base}/client-error`)).status, 400)
  const clientError = requestSpan("/client-error")
  assert.equal(clientError.kind, SpanKind.SERVER)
  assert.equal(clientError.status.code, SpanStatusCode.UNSET)
  assert.equal(exceptionEvents(clientError).length, 0)
  assert.equal(clientError.attributes["http.response.status_code"], 400)
  console.log("PASS 400 ⇒ status UNSET + zero exception events")

  // ── 404 (no route) ⇒ UNSET + zero exception events ─────────────────────────
  assert.equal((await fetch(`${base}/nope`)).status, 404)
  const notFound = requestSpan("/nope")
  assert.equal(notFound.status.code, SpanStatusCode.UNSET)
  assert.equal(exceptionEvents(notFound).length, 0)
  assert.equal(notFound.attributes["http.response.status_code"], 404)
  console.log("PASS 404 ⇒ status UNSET + zero exception events")

  // ── 500 ⇒ ERROR + exactly ONE exception event on the whole request ────────
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
  console.log("PASS 500 ⇒ status ERROR + exactly one exception event")

  // ── INTERNAL handler spans: keep ERROR status, drop duplicate events ───────
  for (const path of ["/client-error", "/server-error"]) {
    const [handler, ...rest] = handlerSpans(path)
    assert.ok(handler, `handler span for ${path} not exported`)
    assert.equal(rest.length, 0)
    assert.equal(handler.status.code, SpanStatusCode.ERROR)
    assert.equal(exceptionEvents(handler).length, 0)
  }
  console.log("PASS INTERNAL handler spans keep status, zero exception events")

  // ── hijacked reply ⇒ request span ends on reply.raw close ─────────────────
  const hijacked = await fetch(`${base}/hijack`)
  assert.equal(await hijacked.text(), "hijacked")
  // onSend/onResponse never run for hijacked replies; the span only reaches the
  // exporter when the patch's raw-close listener ends it.
  await waitFor("hijacked request span", () =>
    exporter
      .getFinishedSpans()
      .some(
        (s) => s.name === "request" && s.attributes["url.path"] === "/hijack"
      )
  )
  console.log("PASS hijacked reply ⇒ request span ended on raw close")

  await app.close()
  await provider.shutdown()
  console.log("P-I1: ALL PASS")
}

main().catch((error) => {
  console.error("P-I1: FAIL")
  console.error(error)
  process.exit(1)
})
