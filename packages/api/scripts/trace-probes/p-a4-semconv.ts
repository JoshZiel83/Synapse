// P-A4 (stable semconv) — §7 of
// docs/trace-correctness-remediation-plan-2026-07-12.md.
// Boots the boot-probe child WITHOUT OTEL_SEMCONV_STABILITY_OPT_IN in the env
// (instrumentation.ts code-defaults it to "http") and asserts the exported
// spans carry ONLY stable HTTP semconv attribute keys — no legacy
// http.method / http.url / http.status_code / http.target — so
// instrumentation-http matches undici + @fastify/otel.
// Run: npx tsx scripts/trace-probes/p-a4-semconv.ts
import { check, finish, runBootProbe, startOtlpCatcher } from "./_shared.js"

const otlp = await startOtlpCatcher()

const run = await runBootProbe({
  OTEL_EXPORTER_OTLP_ENDPOINT: otlp.url,
  // Explicitly EMPTY: the code default (||=, empty = unset per the env spec)
  // must kick in — this is the "no operator action needed" path.
  OTEL_SEMCONV_STABILITY_OPT_IN: "",
})

check("child exits 0", run.code === 0, run.stderr)
check("BOOT_OK printed", run.bootOk, run.stdout)
check("OTLP catcher received exports", otlp.posts.length > 0)

const payload = otlp.text()

// Stable names present (attribute keys are length-prefixed UTF-8 in the
// protobuf, so contiguous-substring checks are exact).
for (const stable of [
  "http.request.method",
  "http.response.status_code",
  "url.path",
  "url.full",
]) {
  check(`stable attribute key present: ${stable}`, payload.includes(stable))
}

// Legacy names absent. NB none of these occurs as a substring of a stable name
// ("http.method" ≠ "http.request.method" contiguously, etc.).
for (const legacy of [
  "http.method",
  "http.url",
  "http.status_code",
  "http.target",
  "http.host",
]) {
  check(`legacy attribute key ABSENT: ${legacy}`, !payload.includes(legacy))
}

await otlp.close()
finish("P-A4")
