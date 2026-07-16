// P-A1 (boot / C1 regression) — §7 of
// docs/trace-correctness-remediation-plan-2026-07-12.md.
// Boots the REAL instrumentation module + a minimal fastify app in a child
// process with SENTRY_DSN set (the exact config that crash-looped with
// FST_ERR_DEC_ALREADY_PRESENT pre-rewrite); asserts exit 0 and that a served
// request emits a ROUTE span to a local OTLP catcher — i.e. the OTel pipeline
// is not starved under Sentry. Also pins the SDK-layer noise suppression:
// health-path and OPTIONS-preflight traces never reach the exporter.
// Run: npx tsx scripts/trace-probes/p-a1-boot.ts
import { check, finish, runBootProbe, startOtlpCatcher } from "./_shared.js"

const otlp = await startOtlpCatcher()

const run = await runBootProbe({
  SENTRY_DSN: "http://examplepublickey@127.0.0.1:9/1",
  SENTRY_TRACES_SAMPLE_RATE: "0.1",
  OTEL_EXPORTER_OTLP_ENDPOINT: otlp.url,
  // Each route handler emits a marker child span under the ACTIVE request
  // context — makes the health-suppression asserts below cover the CHILD half
  // of the claim, not just the childless SERVER/route spans.
  BOOT_PROBE_CHILD_SPANS: "1",
})

check("child exits 0 with a DSN set", run.code === 0, run.stderr)
check("BOOT_OK printed", run.bootOk, run.stdout)
check(
  "served request has a recording route span",
  run.result?.ping.recording === true,
  run.result
)

check("OTLP catcher received at least one export", otlp.posts.length > 0)
const payload = otlp.text()
check(
  "route span exported (GET /ping span name present)",
  payload.includes("GET /ping")
)
check(
  "@fastify/otel route spans present",
  payload.includes("@fastify/otel"),
  "expected the fastify.root attribute value in the payload"
)
// The boot-probe self-fetches health + OPTIONS under suppressTracing, so any
// occurrence of these markers could only come from SERVER-side spans that the
// HttpInstrumentation ignoreIncomingRequestHook failed to suppress.
check(
  "health trace fully suppressed (no /api/v1/health bytes)",
  !payload.includes("/api/v1/health")
)
check(
  "OPTIONS preflight fully suppressed (no OPTIONS bytes)",
  !payload.includes("OPTIONS")
)
// The whole-trace-kill pin, child half (instrumentation.ts: "the WHOLE trace
// (route/pg/redis children included) vanishes"): a marker child span started
// under the request's ACTIVE context inside each handler. The /ping child
// exporting proves the mechanism is non-vacuous; the health child must be
// non-recording under the http-layer suppressTracing context bind — a future
// change that keeps the SERVER-span ignore but loses the context bind fails
// the negative assert.
check(
  "ping child marker span exported (child-span pin non-vacuous)",
  payload.includes("boot-probe-child-of-ping")
)
check(
  "health child span suppressed too (whole-trace kill includes children)",
  !payload.includes("boot-probe-child-of-health")
)

await otlp.close()
finish("P-A1")
