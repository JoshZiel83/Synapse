// Trace-id response exposure + Server-Timing.
//
// Always pushes per-request server timing into the browser's PerformanceObserver
// / RUM (`performance.getEntriesByType('navigation')[0].serverTiming`,
// `Server-Timing` — W3C Server Timing WD). When trace exposure is enabled it
// also surfaces the active OTel trace_id to the client in TWO complementary ways
// so a client/operator can jump straight to the trace in Tempo:
//   - `Server-Timing: trace;desc="<trace_id>"` — read via the RUM/Performance API.
//   - `traceresponse: 00-<trace-id>-<span-id>-<flags>` — the W3C Trace Context
//     Level 2 standard response header (the response-side analogue of
//     `traceparent`).
//
// trace_id is an internal correlation id; exposing it to every client is a small
// information-disclosure surface (and meaningless for unsampled requests), so it
// is GATED via env — default = only on 5xx, where it is most useful for triage.
// This deployment sets it to `on` (see .env) to expose on every response:
//   SYNAPSE_SERVER_TIMING_TRACE = off | errors (default) | on
//
// We append to (never clobber) any upstream Server-Timing, and only set headers
// when there is something to report.
import fp from "fastify-plugin"
import type { FastifyInstance } from "fastify"
import { isSpanContextValid, trace } from "@opentelemetry/api"

type TraceMode = "off" | "errors" | "on"

function resolveTraceMode(): TraceMode {
  const v = (process.env.SYNAPSE_SERVER_TIMING_TRACE || "errors").toLowerCase()
  return v === "off" || v === "on" ? v : "errors"
}

export default fp(
  async function serverTiming(app: FastifyInstance) {
    const mode = resolveTraceMode()

    app.addHook("onSend", async (_req, reply, payload) => {
      const parts: string[] = []

      const dur = reply.elapsedTime
      if (typeof dur === "number" && Number.isFinite(dur)) {
        parts.push(`app;dur=${dur.toFixed(1)}`)
      }

      const exposeTrace =
        mode === "on" || (mode === "errors" && reply.statusCode >= 500)
      if (exposeTrace) {
        const sc = trace.getActiveSpan()?.spanContext()
        if (sc && isSpanContextValid(sc)) {
          // RUM-readable trace id.
          parts.push(`trace;desc="${sc.traceId}"`)
          // W3C Trace Context Level 2 `traceresponse`: 00-<trace>-<span>-<flags>.
          const flags = sc.traceFlags.toString(16).padStart(2, "0")
          reply.header(
            "traceresponse",
            `00-${sc.traceId}-${sc.spanId}-${flags}`
          )
        }
      }

      if (parts.length > 0) {
        const existing = reply.getHeader("server-timing")
        reply.header(
          "server-timing",
          existing ? `${existing}, ${parts.join(", ")}` : parts.join(", ")
        )
      }
      return payload
    })
  },
  { name: "server-timing" }
)
