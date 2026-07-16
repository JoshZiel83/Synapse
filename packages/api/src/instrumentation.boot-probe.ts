/**
 * Child-process boot probe for instrumentation.ts (§4.A change 6; consumed by
 * instrumentation.boot.test.ts and probes P-A1/P-A4/P-A6 under
 * scripts/trace-probes/). Boots the REAL instrumentation module as the first
 * import — exactly like src/index.ts — registers the @fastify/otel plugin + the
 * house Sentry onError hook, serves over a real socket, self-probes, and
 * reports per-route span-recording state as one JSON line so callers can
 * assert the health-suppression / SDK-disabled matrices. Prints BOOT_OK and
 * exits 0 on success.
 *
 * BOOT_RESULT also always reports:
 *   rateEnvPresent            whether SENTRY_TRACES_SAMPLE_RATE survived module
 *                             load (instrumentation.ts must DELETE it so the
 *                             Sentry SDK env fallback can never re-read the
 *                             repurposed forward rate as a head rate)
 *   tracesSampleRateOption    String(client.getOptions().tracesSampleRate) —
 *                             "undefined" at forward rate <= 0 ([D4] DSN-only
 *                             semantics), "1" at rate > 0
 *
 * Env knobs (besides the observability vars instrumentation.ts itself reads):
 *   BOOT_PROBE_CAPTURE_ERROR=1  capture one test error to Sentry before exit
 *   BOOT_PROBE_ERROR_ROUTES=1   also hit /boom (500 ⇒ Sentry event) and
 *                               /expected-400 (client error ⇒ NO Sentry event)
 *   BOOT_PROBE_CRASH=1          throw from a timer after serving — exercises
 *                               the Synapse uncaughtException fatalExit path
 *                               (must flush buffered telemetry and exit 1)
 *   BOOT_PROBE_CHILD_SPANS=1    each route handler emits a marker child span
 *                               under the ACTIVE request context — under the
 *                               http-layer health suppression it must be
 *                               non-recording (the "whole trace vanishes,
 *                               children included" pin for P-A1)
 *   BOOT_PROBE_HTTP_CHECK=1     make an outbound node:http request to an
 *                               in-probe echo server and report whether it
 *                               carried a traceparent header — pins the forced
 *                               cjsRequire("http") RITM activation
 */
import {
  fastifyOtelInstrumentation,
  setupSentryErrorHandler,
  shutdownTelemetry,
} from "./instrumentation.js"
import { context, trace } from "@opentelemetry/api"
import { suppressTracing } from "@opentelemetry/core"
import Fastify from "fastify"
import * as Sentry from "@sentry/node"
import http from "node:http"
import { once } from "node:events"
import type { AddressInfo } from "node:net"

const app = Fastify({ logger: false })
await app.register(fastifyOtelInstrumentation.plugin())
setupSentryErrorHandler(app)

/**
 * Marker child span under the ACTIVE request context (BOOT_PROBE_CHILD_SPANS).
 * A manual tracer span exercises the same mechanism as pg/redis/undici
 * children (Tracer.startSpan consults the context's suppression key), so on a
 * suppressed route it comes back non-recording and never exports, while on an
 * unsuppressed route it exports with the marker name — P-A1 asserts marker
 * presence/absence on the raw OTLP payload.
 */
function emitChildMarker(name: string): void {
  if (process.env.BOOT_PROBE_CHILD_SPANS !== "1") return
  trace.getTracer("boot-probe").startSpan(name, {}, context.active()).end()
}

// `span` is null for routes skipped by the plugin's ignorePaths (the health
// route below) and non-recording under http-layer suppression / OTEL_SDK_DISABLED.
app.get("/ping", async (request) => {
  emitChildMarker("boot-probe-child-of-ping")
  return {
    recording: request.opentelemetry().span?.isRecording() ?? false,
  }
})
app.get("/api/v1/health", async (request) => {
  emitChildMarker("boot-probe-child-of-health")
  return {
    recording: request.opentelemetry().span?.isRecording() ?? false,
  }
})
app.get("/boom", async () => {
  throw new Error("boot-probe deliberate 500")
})
app.get("/expected-400", async () => {
  const clientError = new Error("boot-probe expected client error") as Error & {
    statusCode: number
  }
  clientError.statusCode = 400
  throw clientError
})

const address = await app.listen({ port: 0, host: "127.0.0.1" })

async function probe(
  path: string
): Promise<{ status: number; recording?: boolean }> {
  const res = await fetch(`${address}${path}`)
  // Marker scan instead of a JSON parse: this file is probe scaffolding but
  // lives under src/ as production code, where unchecked Response.json/
  // JSON.parse surfaces are barred (test/regression/json-parse-classification
  // .test.ts). The routes above are the only writers and always serialize
  // `{"recording":boolean}`.
  const body = res.status === 200 ? await res.text() : undefined
  const match = body?.match(/"recording":(true|false)/)
  return {
    status: res.status,
    recording: match ? match[1] === "true" : undefined,
  }
}

const ping = await probe("/ping")
// The health + OPTIONS self-probes run under suppressTracing so the PROBE's
// own outbound CLIENT spans (url.full would embed the path) never reach the
// exporter — any "/api/v1/health" or "OPTIONS" bytes in an OTLP catcher's
// payload can then only come from SERVER-side spans, i.e. from a broken
// ignoreIncomingRequestHook.
const health = await context.with(suppressTracing(context.active()), async () =>
  probe("/api/v1/health")
)
const preflight = await context.with(
  suppressTracing(context.active()),
  async () => fetch(`${address}/ping`, { method: "OPTIONS" })
)
if (ping.status !== 200 || health.status !== 200) {
  console.error("BOOT_FAIL route status", { ping, health })
  process.exit(1)
}

// BOOT_PROBE_HTTP_CHECK: outbound node:http (NOT fetch/undici) against an
// in-probe echo server. `import http from "node:http"` alone is NOT patched by
// require-in-the-middle — only instrumentation.ts's forced cjsRequire("http")
// makes this request carry a traceparent (loopback = first-party, so the
// FirstPartyOnlyPropagator delegates). Expected true whenever the SDK is live,
// false under OTEL_SDK_DISABLED.
let nodeHttpTraceparent: boolean | undefined
if (process.env.BOOT_PROBE_HTTP_CHECK === "1") {
  const echo = http.createServer((req, res) => {
    res.end(String(req.headers.traceparent ?? ""))
  })
  echo.listen(0, "127.0.0.1")
  await once(echo, "listening")
  const echoPort = (echo.address() as AddressInfo).port
  const echoedTraceparent: string = await new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${echoPort}/node-http-echo`, (res) => {
        let data = ""
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString()
        })
        res.on("end", () => resolve(data))
        res.on("error", reject)
      })
      .on("error", reject)
  })
  nodeHttpTraceparent = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/.test(
    echoedTraceparent
  )
  await new Promise<void>((resolve) => echo.close(() => resolve()))
}

console.log(
  `BOOT_RESULT ${JSON.stringify({
    ping,
    health,
    options: { status: preflight.status },
    // Pins for the SENTRY_TRACES_SAMPLE_RATE repurposing ([D4]): the env var
    // must be gone after module load, and the Sentry client must sit in
    // DSN-only semantics (tracesSampleRate undefined) at forward rate <= 0.
    rateEnvPresent: "SENTRY_TRACES_SAMPLE_RATE" in process.env,
    tracesSampleRateOption: String(
      Sentry.getClient()?.getOptions().tracesSampleRate
    ),
    ...(nodeHttpTraceparent === undefined ? {} : { nodeHttpTraceparent }),
  })}`
)

if (process.env.BOOT_PROBE_ERROR_ROUTES === "1") {
  const boom = await probe("/boom")
  const expected = await probe("/expected-400")
  if (boom.status !== 500 || expected.status !== 400) {
    console.error("BOOT_FAIL error-route status", { boom, expected })
    process.exit(1)
  }
}

if (process.env.BOOT_PROBE_CAPTURE_ERROR === "1") {
  Sentry.captureException(new Error("boot-probe test error"))
}

if (process.env.BOOT_PROBE_CRASH === "1") {
  // Deliberate crash AFTER a served request: the Synapse-owned
  // uncaughtException handler (instrumentation.ts) must capture it with
  // tags["fatal.context"]="uncaughtException", flush buffered spans/events
  // within its 3s bound, and exit 1.
  setTimeout(() => {
    throw new Error("boot-probe deliberate crash")
  }, 10)
} else {
  await app.close()
  await shutdownTelemetry()
  console.log("BOOT_OK")
  process.exit(0)
}
