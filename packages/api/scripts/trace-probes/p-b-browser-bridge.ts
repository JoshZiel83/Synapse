// P-B (browser bridge) — §7 of
// docs/trace-correctness-remediation-plan-2026-07-12.md.
// The frontend side of the W3C bridge: `Sentry.getTraceData({
// propagateTraceparent: true })` via the installed @sentry/nextjs returns a
// spec-valid `00-<traceId>-<spanId>-<flags>` traceparent that the api-side
// W3C propagator extracts to the IDENTICAL trace id (and the emitting span's
// id as the remote parent). Also pins the DSN-unset posture the WS stamping
// helpers rely on: getTraceData with no client is `{}` — frames go unstamped.
// Run: npx tsx scripts/trace-probes/p-b-browser-bridge.ts
import { createRequire } from "node:module"
import {
  context,
  defaultTextMapGetter,
  trace,
  ROOT_CONTEXT,
} from "@opentelemetry/api"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { TRACEPARENT_RE } from "@synapse/shared"
import { check, finish, startSentryCatcher } from "./_shared.js"

// CJS require: the package's node entry (build/cjs/index.server.js) re-exports
// @sentry/node DYNAMICALLY (Object.keys forEach), which cjs-module-lexer cannot
// see — an ESM namespace import would miss getTraceData. The browser bundle the
// frontends actually consume exports it statically (source-verified).
const Sentry = createRequire(import.meta.url)(
  "@sentry/nextjs"
) as typeof import("@sentry/nextjs")

// DSN-unset first (before any init): the frontends call getTraceData
// unconditionally from the WS stamping helpers — without a client it must
// return {} (no traceparent), never throw.
const withoutClient = Sentry.getTraceData({ propagateTraceparent: true })
check(
  "no client ⇒ getTraceData returns {} (WS frames go unstamped)",
  withoutClient.traceparent === undefined &&
    withoutClient["sentry-trace"] === undefined,
  withoutClient
)

const sentry = await startSentryCatcher()
Sentry.init({ dsn: sentry.dsn, tracesSampleRate: 1 })

const { traceData, activeTraceId, activeSpanId } = Sentry.startSpan(
  { name: "p-b-browser-bridge" },
  (span) => ({
    traceData: Sentry.getTraceData({ propagateTraceparent: true }),
    activeTraceId: span.spanContext().traceId,
    activeSpanId: span.spanContext().spanId,
  })
)

const traceparent = traceData.traceparent
check(
  "traceparent matches the canonical strict regex",
  typeof traceparent === "string" && TRACEPARENT_RE.test(traceparent),
  traceparent
)

// Api-side extraction: the W3C propagator member of the api's composite,
// reading the header exactly as an inbound HTTP request would present it.
const extracted = trace.getSpanContext(
  new W3CTraceContextPropagator().extract(
    ROOT_CONTEXT,
    { traceparent },
    defaultTextMapGetter
  )
)

check("api-side W3C extract yields a span context", Boolean(extracted))
check(
  "extracted trace id === the emitting span's trace id",
  extracted?.traceId === activeTraceId,
  { extracted: extracted?.traceId, active: activeTraceId }
)
check(
  "extracted span id === the emitting span's id (remote parent binding)",
  extracted?.spanId === activeSpanId,
  { extracted: extracted?.spanId, active: activeSpanId }
)
check(
  "sampled flag carried (tracesSampleRate 1 ⇒ flags 01)",
  extracted?.traceFlags === 1,
  extracted?.traceFlags
)

await Sentry.close(2000)
await sentry.close()
await new Promise((r) => setTimeout(r, 0))
context.disable()
finish("P-B")
