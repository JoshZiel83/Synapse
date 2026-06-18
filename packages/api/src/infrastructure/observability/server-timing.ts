// Server-Timing response header (W3C Server Timing, Working Draft).
//
// Pushes per-request server timing into the browser's PerformanceObserver / RUM
// (`performance.getEntriesByType('navigation')[0].serverTiming`), and OPTIONALLY
// exposes the active OTel trace_id so a client/operator can jump from a request
// straight to its trace in Tempo.
//
// trace_id is an internal correlation id; exposing it to every client is a small
// information-disclosure surface (and meaningless for unsampled requests), so it
// is GATED via env — default = only on 5xx, where it is most useful for triage:
//   SYNAPSE_SERVER_TIMING_TRACE = off | errors (default) | on
//
// We append to (never clobber) any upstream Server-Timing, and only set the
// header when there is something to report.
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
          parts.push(`trace;desc="${sc.traceId}"`)
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
