// Per-request Server-Timing + trace exposure.
//
// Always pushes per-request server timing into the browser's PerformanceObserver
// / RUM (`performance.getEntriesByType('navigation')[0].serverTiming`,
// `Server-Timing` — W3C Server Timing WD). When trace exposure is enabled it
// also surfaces the active OTel span context via the registered `trace`
// Server-Timing metric from the W3C trace-context **Level 3 editor's draft**
// (the response-side trace exposure; there is no W3C *Recommendation* for a
// response header — the retired `traceresponse` header appears in zero RECs):
//
//   Server-Timing: trace;desc=00-<trace-id>-<span-id>-<flags>
//
// The desc payload MUST be the full version-00 member — a bare trace-id is
// invalid per the draft's ABNF and conformant clients MUST ignore it.
//
// trace_id is an internal correlation id; exposing it to every client is a small
// information-disclosure surface (and meaningless for unsampled requests), so it
// is GATED via env — default = only on 5xx, where it is most useful for triage.
//   SYNAPSE_SERVER_TIMING_TRACE = off | errors (default) | on
//
// SAMPLING ORACLE (round-2 trust boundary, §3a A3). Mode `on` echoes the SAMPLED
// FLAG of the active span to EVERY client. On a public deployment running a
// ratio-class OTEL_TRACES_SAMPLER that turns the sampler's offline-mining
// residual into an ONLINE oracle: a client can test candidate trace ids and keep
// the ones that record. This CANNOT be designed away — presence/absence of any
// response-side trace-correlation channel leaks the same decision bit, and that
// channel is exactly what makes the browser-side trace-context Level 3 bridge
// work (already wired via CORS exposedHeaders: ["server-timing"]). The bound is
// the nginx limit_req at the edge, not this header. Recommended public posture:
// `errors` (the default) or `off` with a ratio sampler. A boot warning fires
// below when `on` coincides with a ratio sampler; see docs/logging-refactor/
// 04-operations.md and docs/trace-propagation-policy.md.
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

    // Boot warning: mode `on` + a ratio-class sampler = an online sampling
    // oracle (see the file header). Named vars + doc pointer, once at
    // registration.
    if (
      mode === "on" &&
      (process.env.OTEL_TRACES_SAMPLER || "").includes("traceidratio")
    ) {
      app.log.warn(
        "SYNAPSE_SERVER_TIMING_TRACE=on with a ratio-class OTEL_TRACES_SAMPLER " +
          "echoes the sampled flag to every client — an ONLINE sampling oracle. " +
          "Use `errors` or `off` on a public ratio-sampled deployment " +
          "(docs/logging-refactor/04-operations.md)."
      )
    }

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
          // W3C trace-context Level 3 editor's-draft `trace` metric: the FULL
          // version-00 traceparent payload (trace-id alone is invalid ABNF).
          const flags = sc.traceFlags.toString(16).padStart(2, "0")
          parts.push(`trace;desc=00-${sc.traceId}-${sc.spanId}-${flags}`)
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
