// Child-process boot regression tests for instrumentation.ts (§4.A change 6):
// boots src/instrumentation.boot-probe.ts (the REAL instrumentation module +
// a minimal fastify app) under four env matrices and asserts exit 0 + BOOT_OK.
// Case 1 is the direct C1 regression: SENTRY_DSN set + a >0 forward rate is
// EXACTLY the config that crash-looped pre-rewrite (Sentry's vendored Fastify
// auto-instrumentation double-registered the request decorator against
// @fastify/otel → FST_ERR_DEC_ALREADY_PRESENT).
//
// Every matrix also pins:
//   - nodeHttpTraceparent — the forced cjsRequire("http") RITM activation: an
//     outbound node:http request must carry traceparent whenever the SDK is
//     live (plain ESM `import http from "node:http"` alone is NOT patched),
//     and must NOT under OTEL_SDK_DISABLED;
//   - rateEnvPresent === false — instrumentation.ts must DELETE the repurposed
//     SENTRY_TRACES_SAMPLE_RATE so the Sentry SDK env fallback can never
//     re-read the forward rate as a head rate;
//   - tracesSampleRateOption — "undefined" at forward rate <= 0 ([D4] DSN-only
//     client semantics, matrix 4 = the compose `${VAR:-0}` default), "1" at
//     rate > 0.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const execFileAsync = promisify(execFile)

const PROBE = fileURLToPath(
  new URL("./instrumentation.boot-probe.ts", import.meta.url)
)
const API_DIR = fileURLToPath(new URL("..", import.meta.url))
const TSX_BIN = fileURLToPath(
  new URL("../../../node_modules/.bin/tsx", import.meta.url)
)

// A syntactically valid DSN pointing at a dead local port — the probe captures
// no events in these cases, and Sentry transports swallow delivery failures.
const DEAD_DSN = "http://examplepublickey@127.0.0.1:9/1"

interface BootResult {
  ping: { status: number; recording?: boolean }
  health: { status: number; recording?: boolean }
  rateEnvPresent: boolean
  tracesSampleRateOption: string
  nodeHttpTraceparent?: boolean
  spanProcessorCount: number
  serviceName: string
  serviceNamespace: string
  tracesSamplerEnv: string | null
}

async function runProbe(overrides: Record<string, string>): Promise<{
  stdout: string
  result: BootResult
}> {
  const { stdout } = await execFileAsync(TSX_BIN, [PROBE], {
    cwd: API_DIR,
    env: {
      ...process.env,
      // Neutralize the repo .env (dotenv never overrides set vars; the
      // instrumentation treats empty string as unset per the OTel env spec).
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
      OTEL_TRACES_SAMPLER: "",
      OTEL_TRACES_SAMPLER_ARG: "",
      OTEL_SDK_DISABLED: "",
      OTEL_LOG_LEVEL: "",
      // Neutralized to "" (NOT unset): the repo .env sets OTEL_SERVICE_NAME=
      // synapse-api, and dotenv would set an ABSENT key — so leaving it unset
      // leaks that value in and it beats OTEL_RESOURCE_ATTRIBUTES (matrix 7).
      // An empty string is "present" ⇒ dotenv does not override ⇒ EnvDetector
      // treats empty as unset ⇒ OTEL_RESOURCE_ATTRIBUTES' service.name can win.
      OTEL_SERVICE_NAME: "",
      OTEL_RESOURCE_ATTRIBUTES: "",
      OTEL_SEMCONV_STABILITY_OPT_IN: "",
      SENTRY_DSN: "",
      SENTRY_TRACES_SAMPLE_RATE: "",
      BOOT_PROBE_HTTP_CHECK: "1",
      ...overrides,
    },
    timeout: 90_000,
  })
  assert.ok(stdout.includes("BOOT_OK"), `BOOT_OK missing in: ${stdout}`)
  const line = stdout.split("\n").find((l) => l.startsWith("BOOT_RESULT "))
  assert.ok(line, `BOOT_RESULT missing in: ${stdout}`)
  const result = JSON.parse(line.slice("BOOT_RESULT ".length)) as BootResult
  // Invariant in EVERY matrix: the repurposed forward-rate var must not
  // survive module load (Sentry SDK env-fallback hazard).
  assert.equal(result.rateEnvPresent, false)
  return { stdout, result }
}

test("boot matrix 1 (C1 regression): SENTRY_DSN set + forward rate 0.1 boots and serves", async () => {
  const { result } = await runProbe({
    SENTRY_DSN: DEAD_DSN,
    SENTRY_TRACES_SAMPLE_RATE: "0.1",
  })
  assert.equal(result.ping.status, 200)
  // Route span recording (default AlwaysOn sampler) proves the OTel pipeline
  // is live under Sentry — not starved by a Sentry-owned sampler.
  assert.equal(result.ping.recording, true)
  // The health route is ignorePaths-skipped at the plugin layer (and its whole
  // trace is suppressed at the http layer).
  assert.equal(result.health.recording, false)
  // Forward rate > 0 ⇒ Sentry sees every span (event-level drop downstream).
  assert.equal(result.tracesSampleRateOption, "1")
  // node:http outbound propagation is live (forced cjsRequire("http") pin).
  assert.equal(result.nodeHttpTraceparent, true)
})

test("boot matrix 2: DSN unset boots with identical span shape", async () => {
  const { result } = await runProbe({})
  assert.equal(result.ping.status, 200)
  assert.equal(result.ping.recording, true)
  assert.equal(result.health.recording, false)
  // No Sentry client at all.
  assert.equal(result.tracesSampleRateOption, "undefined")
  assert.equal(result.nodeHttpTraceparent, true)
})

test("boot matrix 3: OTEL_SDK_DISABLED=true + DSN set boots, serves, records nothing", async () => {
  const { result } = await runProbe({
    OTEL_SDK_DISABLED: "true",
    SENTRY_DSN: DEAD_DSN,
  })
  assert.equal(result.ping.status, 200)
  assert.equal(result.ping.recording, false)
  assert.equal(result.health.recording, false)
  // No provider ⇒ no instrumentations ⇒ no propagator: outbound node:http
  // must carry NO traceparent.
  assert.equal(result.nodeHttpTraceparent, false)
})

test("boot matrix 4 ([D4] compose default): DSN set + rate '0' — client in DSN-only semantics", async () => {
  // docker-compose materializes `SENTRY_TRACES_SAMPLE_RATE: ${VAR:-0}`, so the
  // literal string "0" is what every default deployment boots with. The Sentry
  // client must be indistinguishable from DSN-without-tracesSampleRate:
  // options.tracesSampleRate === undefined (NOT 0 — the SDK env fallback would
  // produce 0 if instrumentation.ts failed to delete the repurposed var).
  const { result } = await runProbe({
    SENTRY_DSN: DEAD_DSN,
    SENTRY_TRACES_SAMPLE_RATE: "0",
  })
  assert.equal(result.ping.status, 200)
  assert.equal(result.ping.recording, true)
  assert.equal(result.health.recording, false)
  assert.equal(result.tracesSampleRateOption, "undefined")
  assert.equal(result.nodeHttpTraceparent, true)
})

test("boot matrix 5 (F13): OTEL_TRACES_EXPORTER=none + endpoint ⇒ ZERO span processors, spans still record", async () => {
  const { result } = await runProbe({
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
    OTEL_TRACES_EXPORTER: "none",
  })
  // The off switch that keeps the endpoint set: no OTLP processor is pushed…
  assert.equal(result.spanProcessorCount, 0)
  // …but the provider still records (sampler, not processor, decides recording),
  // so logs keep a trace_id.
  assert.equal(result.ping.recording, true)
  assert.equal(result.ping.status, 200)
})

test("boot matrix 6 (F13): OTEL_TRACES_EXPORTER=bogus + endpoint ⇒ treated as unset, export ON", async () => {
  const { result } = await runProbe({
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
    OTEL_TRACES_EXPORTER: "bogus",
  })
  // Unknown value ⇒ diag.error (asserted in P-A8) + treat as unset ⇒ one OTLP
  // BatchSpanProcessor still pushed.
  assert.equal(result.spanProcessorCount, 1)
  assert.equal(result.ping.status, 200)
})

test("boot matrix 7 (F13 precedence): OTEL_RESOURCE_ATTRIBUTES service.name wins when OTEL_SERVICE_NAME unset", async () => {
  const { result } = await runProbe({
    OTEL_RESOURCE_ATTRIBUTES: "service.name=from-resource-attrs",
  })
  // The precedence-inversion regression pin: pre-fix this reported `synapse-api`
  // because the house literal merged LAST and silently overrode the operator.
  assert.equal(result.serviceName, "from-resource-attrs")
  // OTEL_SERVICE_NAME unset ⇒ house namespace fallback survives.
  assert.equal(result.serviceNamespace, "synapse")
})

test("boot matrix 8 (F13 sampler): OTEL_TRACES_SAMPLER=' ALWAYS_OFF ' normalizes + drives AlwaysOff", async () => {
  const { result } = await runProbe({
    OTEL_TRACES_SAMPLER: " ALWAYS_OFF ",
  })
  // Written back to process.env trim+lowercased, so the SDK's parallel parse
  // agrees (no ERROR spam)…
  assert.equal(result.tracesSamplerEnv, "always_off")
  // …and our parser builds AlwaysOff ⇒ the route span is non-recording.
  assert.equal(result.ping.recording, false)
  assert.equal(result.ping.status, 200)
})
