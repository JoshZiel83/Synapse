// P-F (egress wrapper) — §7 of docs/trace-correctness-remediation-plan-2026-07-12.md.
// Re-runs the design-phase spike assertions against the installed tree (an
// unchanged PASS proves no SDK drift):
//   1. BOTH installed HTTP instrumentations (instrumentation-http,
//      instrumentation-undici) expose the destination URL on recording CLIENT
//      spans at inject time.
//   2. Denying delegation suppresses ALL trace headers while the CLIENT span
//      still exports (fail-closed is correlation-only loss).
//   3. A dotted fake third-party host receives no trace headers — driven over a
//      real socket via the npm undici Agent connector pattern (the request URL
//      carries the fake host; the connector dials loopback) — and a leading-dot
//      SYNAPSE_TRACE_FIRST_PARTY_HOSTS suffix entry flips it to injected.
// Standalone: spins its own echo server, no live services. Run:
//   npx tsx scripts/trace-probes/p-f-first-party.ts
import net from "node:net"
import { once } from "node:events"
import { createRequire } from "node:module"
import {
  context,
  createTraceState,
  defaultTextMapSetter,
  propagation,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type Context,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
} from "@opentelemetry/api"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { registerInstrumentations } from "@opentelemetry/instrumentation"
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http"
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { Agent, fetch as undiciFetch } from "undici"
import {
  FirstPartyOnlyPropagator,
  buildFirstPartyAllowlist,
} from "../../src/infrastructure/observability/first-party-propagator.js"

// Mirror production (src/instrumentation.ts:221): HttpInstrumentation reads this
// in its CONSTRUCTOR, so it MUST be set before `new HttpInstrumentation()` below.
// Without it instrumentation-http emits legacy `http.url` instead of the stable
// `url.full` that FirstPartyOnlyPropagator.resolveDestinationUrl actually reads —
// the probe would then diverge from prod (the spy could see a URL via the legacy
// attr while the real propagator resolves nothing and fails closed, silently
// under-testing the http egress path). `||=` not `??=`: the OTel env spec treats
// empty-string as unset (compose `${VAR:-}` passthroughs materialize exactly it).
process.env.OTEL_SEMCONV_STABILITY_OPT_IN ||= "http"

let pass = 0
let fail = 0
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++
    console.log(`PASS ${label}`)
  } else {
    fail++
    console.error(`FAIL ${label}`, detail ?? "")
  }
}

// Spy: records the URL resolvable from the active span AT INJECT TIME (the
// SDK-shape fact the wrapper depends on), then delegates to the wrapper.
interface InjectObservation {
  url: unknown
  recording: boolean
}
const observations: InjectObservation[] = []
function spy(inner: TextMapPropagator): TextMapPropagator {
  return {
    inject(ctx: Context, carrier: unknown, setter: TextMapSetter) {
      const span = trace.getSpan(ctx)
      if (span) {
        const attributes = (
          span as unknown as { attributes?: Record<string, unknown> }
        ).attributes
        observations.push({
          // Reads EXACTLY what FirstPartyOnlyPropagator.resolveDestinationUrl
          // reads (stable `url.full` only) — the semconv opt-in above forces
          // both instrumentations to set it, so no legacy `http.url` fallback.
          url: attributes?.["url.full"],
          recording: span.isRecording(),
        })
      }
      inner.inject(ctx, carrier, setter)
    },
    extract: (ctx: Context, carrier: unknown, getter: TextMapGetter) =>
      inner.extract(ctx, carrier, getter),
    fields: () => inner.fields(),
  }
}

function wrapper(env: Record<string, string | undefined>): TextMapPropagator {
  return spy(
    new FirstPartyOnlyPropagator(
      new W3CTraceContextPropagator(),
      buildFirstPartyAllowlist(env)
    )
  )
}

function setPropagator(p: TextMapPropagator): void {
  propagation.disable()
  propagation.setGlobalPropagator(p)
}

const exporter = new InMemorySpanExporter()
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})
trace.setGlobalTracerProvider(provider)
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
setPropagator(wrapper({}))
registerInstrumentations({
  tracerProvider: provider,
  instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()],
})

// instrumentation-http patches the CJS module object; a post-enable require
// routes this script's client calls through the patched functions.
const require = createRequire(import.meta.url)
const http = require("http") as typeof import("node:http")

let received: Record<string, unknown> = {}
const server = http.createServer((req, res) => {
  received = { ...req.headers }
  res.end("ok")
})
server.listen(0, "127.0.0.1")
await once(server, "listening")
const port = (server.address() as net.AddressInfo).port
const TRACE_HEADERS = ["traceparent", "tracestate", "sentry-trace", "baggage"]

// --- 1a. instrumentation-http: URL at inject time + loopback injection ------
received = {}
observations.length = 0
await new Promise<void>((resolve, reject) => {
  http
    .get(`http://127.0.0.1:${port}/via-http`, (res) => {
      res.resume()
      res.on("end", resolve)
    })
    .on("error", reject)
})
check(
  "http client: recording CLIENT span exposes destination URL at inject time",
  observations.some(
    (o) =>
      o.recording && String(o.url).includes(`http://127.0.0.1:${port}/via-http`)
  ),
  observations
)
check(
  "http client: loopback destination receives traceparent",
  typeof received.traceparent === "string",
  received
)

// --- 1b. instrumentation-undici: same via global fetch ----------------------
received = {}
observations.length = 0
await fetch(`http://127.0.0.1:${port}/via-fetch`)
check(
  "undici fetch: recording CLIENT span exposes destination URL at inject time",
  observations.some(
    (o) =>
      o.recording &&
      String(o.url).includes(`http://127.0.0.1:${port}/via-fetch`)
  ),
  observations
)
check(
  "undici fetch: loopback destination receives traceparent",
  typeof received.traceparent === "string",
  received
)

// --- 2+3. dotted fake third-party host over a real socket -------------------
// npm undici Agent whose connector dials loopback while the request URL says
// fake-thirdparty.example — the envd-client pattern. The instrumentation hooks
// undici's diagnostics channels regardless of which copy dispatches.
const loopbackAgent = new Agent({
  connect(_opts, callback) {
    const socket = net.connect(port, "127.0.0.1")
    socket.on("connect", () => callback(null, socket))
    socket.on("error", (err) => callback(err, null))
  },
})
received = {}
exporter.reset()
await undiciFetch("http://fake-thirdparty.example/deny", {
  dispatcher: loopbackAgent,
})
check(
  "deny: fake third-party host receives ZERO trace headers",
  TRACE_HEADERS.every((h) => !(h in received)),
  received
)
await provider.forceFlush()
const deniedSpan = exporter
  .getFinishedSpans()
  .find((s) =>
    String(
      (s as unknown as { attributes: Record<string, unknown> }).attributes[
        "url.full"
      ]
    ).includes("fake-thirdparty.example")
  )
check("deny: the denied CLIENT span still exports", deniedSpan !== undefined)

// --- 3b. leading-dot suffix entry flips the same host to injected -----------
setPropagator(
  wrapper({ SYNAPSE_TRACE_FIRST_PARTY_HOSTS: ".fake-thirdparty.example" })
)
received = {}
await undiciFetch("http://sub.fake-thirdparty.example/allow", {
  dispatcher: loopbackAgent,
})
check(
  "flip: .fake-thirdparty.example suffix entry injects traceparent",
  typeof received.traceparent === "string",
  received
)

// --- 4. F12 fail-closed-unconditional: non-recording span, no resolvable URL -
// The old carve-out delegated for non-recording spans under Sentry-off, leaking
// a flags-00 traceparent (and any inherited tracestate) to third parties. It is
// gone: an unresolvable-destination span injects NOTHING, recording or not, and
// the propagator no longer takes a sentryEnabled argument.
{
  const fpp = new FirstPartyOnlyPropagator(
    new W3CTraceContextPropagator(),
    buildFirstPartyAllowlist({})
  )
  const nonRecordingNoUrl = trace.setSpan(
    ROOT_CONTEXT,
    trace.wrapSpanContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: TraceFlags.NONE,
    })
  )
  const c1: Record<string, string> = {}
  fpp.inject(nonRecordingNoUrl, c1, defaultTextMapSetter)
  check(
    "F12: non-recording span with no resolvable URL ⇒ ZERO headers (fail-closed)",
    Object.keys(c1).length === 0,
    c1
  )
  const nonRecordingWithTs = trace.setSpan(
    ROOT_CONTEXT,
    trace.wrapSpanContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: TraceFlags.NONE,
      traceState: createTraceState("congo=congosSecret,es=s:1.0"),
    })
  )
  const c2: Record<string, string> = {}
  fpp.inject(nonRecordingWithTs, c2, defaultTextMapSetter)
  check(
    "F12: an inherited vendor tracestate never rides onward from a non-recording span",
    Object.keys(c2).length === 0,
    c2
  )
}

await loopbackAgent.close()
server.close()
console.log(`\nP-F: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
