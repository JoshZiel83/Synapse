// P-A2 (header skew + the [D1] sanitized-member wire probe) — §7 / §4.A of
// docs/trace-correctness-remediation-plan-2026-07-12.md.
// Loads the REAL instrumentation module with a DSN set, makes outbound fetches
// inside an active span to a local echo server, and asserts on the actual wire
// headers:
//   1. exactly ONE traceparent + ONE sentry-trace, with identical trace AND
//      span ids (pre-rewrite: Sentry's NodeFetch integration ALSO injected,
//      yielding two sentry-trace values with different span ids);
//   2. [D1]: the wire `tracestate` carries no `sentry.*` members (the
//      all-sentry traceState of a locally-rooted trace collapses to NO header)
//      while `sentry-trace` and DSC `baggage` are intact;
//   3. a legitimate co-resident vendor tracestate member passes verbatim.
// Run: npx tsx scripts/trace-probes/p-a2-header-skew.ts
import http from "node:http"
import net from "node:net"
import { once } from "node:events"
import { check, finish } from "./_shared.js"

// Env BEFORE the instrumentation import (it reads env at module eval).
process.env.SENTRY_DSN = "http://examplepublickey@127.0.0.1:9/1"
process.env.SENTRY_TRACES_SAMPLE_RATE = "0.1"
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ""
process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = ""
process.env.OTEL_TRACES_SAMPLER = ""
process.env.OTEL_SDK_DISABLED = ""
process.env.SYNAPSE_TRACE_FIRST_PARTY_HOSTS = ""

await import("../../src/instrumentation.js")

const { context, propagation, trace } = await import("@opentelemetry/api")

let received: http.IncomingHttpHeaders = {}
let rawHeaderNames: string[] = []
const server = http.createServer((req, res) => {
  received = req.headers
  // rawHeaders preserves duplicates that IncomingHttpHeaders would join.
  rawHeaderNames = req.rawHeaders
    .filter((_, i) => i % 2 === 0)
    .map((h) => h.toLowerCase())
  res.end("ok")
})
server.listen(0, "127.0.0.1")
await once(server, "listening")
const port = (server.address() as net.AddressInfo).port
const url = `http://127.0.0.1:${port}/echo`

const tracer = trace.getTracer("p-a2")

// --- 1+2: locally-rooted trace, Sentry-ON -----------------------------------
await tracer.startActiveSpan("p-a2-root", async (span) => {
  await fetch(url)
  span.end()
})

const countHeader = (name: string) =>
  rawHeaderNames.filter((h) => h === name).length
check(
  "exactly ONE traceparent",
  countHeader("traceparent") === 1,
  rawHeaderNames
)
check(
  "exactly ONE sentry-trace",
  countHeader("sentry-trace") === 1,
  rawHeaderNames
)

const traceparent = String(received.traceparent)
const sentryTrace = String(received["sentry-trace"])
const tpParts = traceparent.split("-")
const stParts = sentryTrace.split("-")
check(
  "traceparent is valid",
  /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/.test(traceparent),
  traceparent
)
check(
  "sentry-trace and traceparent share the SAME trace id",
  stParts[0] === tpParts[1],
  { sentryTrace, traceparent }
)
check(
  "sentry-trace and traceparent share the SAME span id",
  stParts[1] === tpParts[2],
  { sentryTrace, traceparent }
)

// [D1]: the locally-rooted trace's traceState is all-sentry (sample_rand/url
// seeded by wrapSamplingDecision) — the sanitized W3C member must emit NO
// tracestate header at all, while Sentry DSC rides its own headers.
check(
  "[D1] no tracestate header for an all-sentry traceState",
  received.tracestate === undefined,
  received.tracestate
)
check(
  "sentry-trace present (DSC continuity header 1/2)",
  typeof received["sentry-trace"] === "string"
)
check(
  "baggage carries the Sentry DSC (public_key)",
  String(received.baggage ?? "").includes("sentry-public_key=examplepublickey"),
  received.baggage
)

// --- 3: co-resident vendor member passes verbatim ---------------------------
const remoteCarrier = {
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  tracestate: "othervendor=xyz",
}
const parentCtx = propagation.extract(context.active(), remoteCarrier)
await context.with(parentCtx, () =>
  tracer.startActiveSpan("p-a2-child", async (span) => {
    await fetch(url)
    span.end()
  })
)
check(
  "[D1] vendor tracestate member passes verbatim (no sentry.* joined it)",
  received.tracestate === "othervendor=xyz",
  received.tracestate
)
check(
  "remote trace id continued on the wire",
  String(received.traceparent).split("-")[1] ===
    "4bf92f3577b34da6a3ce929d0e0e4736",
  received.traceparent
)

server.close()
finish("P-A2")
