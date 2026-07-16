// P-A3 (sampling parity, [D4] forward rate) — §7 / §3a of
// docs/trace-correctness-remediation-plan-2026-07-12.md.
// Runs the REAL instrumentation module against a local OTLP catcher + a local
// Sentry envelope catcher, twice (SENTRY_TRACES_SAMPLE_RATE=0 — the default
// errors-only path — and =0.5), asserting:
//   - OTLP sees 25/25 spans (5 parentless CLIENT + 20 root CONSUMER) at ANY
//     forward rate — Sentry never starves OTLP;
//   - rate 0: ZERO transactions reach Sentry (no SentrySpanProcessor);
//   - rate 0.5: Sentry receives EXACTLY the deterministic per-trace-id subset
//     (parseInt(traceId[0:8],16)/0xffffffff < rate);
//   - an error event carries the active span's EXACT trace/span ids in both.
// Run: npx tsx scripts/trace-probes/p-a3-sampling-parity.ts
import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import {
  API_DIR,
  TSX_BIN,
  baselineEnv,
  check,
  finish,
  startOtlpCatcher,
  startSentryCatcher,
} from "./_shared.js"

const SELF = fileURLToPath(import.meta.url)

// ---------------------------------------------------------------------------
// Role mode: one rate per process (instrumentation.ts reads env at import).
// ---------------------------------------------------------------------------
if (process.env.PA3_RATE !== undefined) {
  const rate = Number(process.env.PA3_RATE)
  const otlp = await startOtlpCatcher()
  const sentry = await startSentryCatcher()
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = otlp.url
  process.env.SENTRY_DSN = sentry.dsn
  process.env.SENTRY_TRACES_SAMPLE_RATE = process.env.PA3_RATE

  const { flushTelemetry } = await import("../../src/instrumentation.js")
  const { ROOT_CONTEXT, SpanKind, trace } = await import("@opentelemetry/api")
  const Sentry = await import("@sentry/node")

  const tracer = trace.getTracer("p-a3")
  const traceIds: string[] = []

  // 5 parentless CLIENT spans (the class SentrySampler dropped 100% of).
  for (let i = 0; i < 5; i++) {
    const span = tracer.startSpan(
      `pa3-client-${i}`,
      { kind: SpanKind.CLIENT },
      ROOT_CONTEXT
    )
    traceIds.push(span.spanContext().traceId)
    span.end()
  }
  // 20 root CONSUMER spans.
  for (let i = 0; i < 20; i++) {
    const span = tracer.startSpan(
      `pa3-root-${i}`,
      { kind: SpanKind.CONSUMER },
      ROOT_CONTEXT
    )
    traceIds.push(span.spanContext().traceId)
    span.end()
  }

  // Error event inside an active span: must carry these exact ids.
  let errorTraceId = ""
  let errorSpanId = ""
  tracer.startActiveSpan("pa3-error-span", (span) => {
    errorTraceId = span.spanContext().traceId
    errorSpanId = span.spanContext().spanId
    Sentry.captureException(new Error("pa3-test-error"))
    span.end()
  })
  traceIds.push(errorTraceId)

  await flushTelemetry()
  await Sentry.flush(5000)
  // No settle-sleep needed: both catchers in _shared.ts parse the body BEFORE
  // writing their response, and both flush paths resolve only after receiving
  // responses — capture is ordered by the time the flushes resolve.

  // --- OTLP parity: all 26 spans exported regardless of the forward rate ----
  const allNames = [
    ...Array.from({ length: 5 }, (_, i) => `pa3-client-${i}`),
    ...Array.from({ length: 20 }, (_, i) => `pa3-root-${i}`),
    "pa3-error-span",
  ]
  const missing = allNames.filter((n) => otlp.count(n) === 0)
  check(
    `rate=${rate}: OTLP received ALL ${allNames.length} spans (25/25 + error span)`,
    missing.length === 0,
    { missing }
  )

  // --- Sentry side -----------------------------------------------------------
  const transactions = sentry.itemsOfType("transaction")
  const allTxTraceIds = transactions.map(
    (t) =>
      ((t.payload as { contexts?: { trace?: { trace_id?: string } } }).contexts
        ?.trace?.trace_id ?? "") as string
  )
  // The in-process OTLP/Sentry catchers are THEMSELVES instrumented http
  // servers (node:http patching is unconditional via instrumentation.ts's
  // forced cjsRequire("http")), so their inbound POSTs generate root SERVER
  // spans that also flow through the forward pipeline. The exact-subset
  // assertion therefore runs over the probe's OWN trace ids; the harness
  // transactions are separately held to the same deterministic rule below.
  const probeTraceIdSet = new Set(traceIds)
  const txTraceIds = new Set(
    allTxTraceIds.filter((id) => probeTraceIdSet.has(id))
  )
  const expected = new Set(
    rate > 0
      ? traceIds.filter(
          (id) => parseInt(id.slice(0, 8), 16) / 0xffffffff < rate
        )
      : []
  )
  if (rate === 0) {
    check(
      "rate=0 ([D4] default): ZERO transactions reach Sentry",
      transactions.length === 0,
      transactions.length
    )
  } else {
    check(
      `rate=${rate}: Sentry received EXACTLY the deterministic subset of probe traces (${expected.size} of ${traceIds.length})`,
      txTraceIds.size === expected.size &&
        [...txTraceIds].every((id) => expected.has(id)),
      { got: [...txTraceIds], expected: [...expected] }
    )
    check(
      `rate=${rate}: subset is non-trivial for this run`,
      expected.size > 0 && expected.size < traceIds.length,
      expected.size
    )
    check(
      `rate=${rate}: EVERY forwarded transaction (harness spans included) satisfies the deterministic rule`,
      allTxTraceIds.every(
        (id) =>
          id.length >= 8 && parseInt(id.slice(0, 8), 16) / 0xffffffff < rate
      ),
      allTxTraceIds
    )
  }

  const errorEvents = sentry
    .itemsOfType("event")
    .map(
      (i) =>
        i.payload as {
          exception?: { values?: Array<{ value?: string }> }
          contexts?: { trace?: { trace_id?: string; span_id?: string } }
        }
    )
    .filter((p) =>
      p.exception?.values?.some((v) => v.value === "pa3-test-error")
    )
  check(
    `rate=${rate}: error event captured`,
    errorEvents.length === 1,
    errorEvents.length
  )
  const errTrace = errorEvents[0]?.contexts?.trace
  check(
    `rate=${rate}: error event carries the active span's EXACT trace/span ids`,
    errTrace?.trace_id === errorTraceId && errTrace?.span_id === errorSpanId,
    { got: errTrace, want: { errorTraceId, errorSpanId } }
  )

  await otlp.close()
  await sentry.close()
  finish(`P-A3[rate=${rate}]`)
}

// ---------------------------------------------------------------------------
// Orchestrator: run both rates as child processes.
// ---------------------------------------------------------------------------
let failed = false
for (const rate of ["0", "0.5"]) {
  const child = spawn(TSX_BIN, [SELF], {
    cwd: API_DIR,
    env: baselineEnv({ PA3_RATE: rate }),
    stdio: ["ignore", "inherit", "inherit"],
  })
  const [code] = (await once(child, "exit")) as [number | null]
  if (code !== 0) failed = true
}
console.log(`\nP-A3: ${failed ? "FAILED" : "all rates passed"}`)
process.exit(failed ? 1 : 0)
