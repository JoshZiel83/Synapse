// P-A6 (OTEL_SDK_DISABLED) — §7 of
// docs/trace-correctness-remediation-plan-2026-07-12.md.
// OTEL_SDK_DISABLED=true + DSN set ⇒ the api boots, serves, exports ZERO
// spans, and Sentry error capture still works — including the house onError
// gate (adjudication 7): a thrown 500 produces exactly one Sentry event, an
// expected 400-class error produces none. Fastify plugin registration without
// a provider is a noop (span never recording).
// Run: npx tsx scripts/trace-probes/p-a6-disabled.ts
import {
  check,
  finish,
  runBootProbe,
  startOtlpCatcher,
  startSentryCatcher,
} from "./_shared.js"

const otlp = await startOtlpCatcher()
const sentry = await startSentryCatcher()

const run = await runBootProbe({
  OTEL_SDK_DISABLED: "true",
  OTEL_EXPORTER_OTLP_ENDPOINT: otlp.url,
  SENTRY_DSN: sentry.dsn,
  BOOT_PROBE_CAPTURE_ERROR: "1",
  BOOT_PROBE_ERROR_ROUTES: "1",
})

check("child exits 0 (boots and serves)", run.code === 0, run.stderr)
check("BOOT_OK printed", run.bootOk, run.stdout)
check(
  "served request span is non-recording (noop tracer)",
  run.result?.ping.recording === false,
  run.result
)
check(
  "ZERO OTLP exports with the SDK disabled",
  otlp.posts.length === 0,
  otlp.posts.length
)

interface ErrorEventPayload {
  exception?: { values?: Array<{ value?: string }> }
}
const errorEvents = sentry
  .itemsOfType("event")
  .map((i) => i.payload as ErrorEventPayload)
const messages = errorEvents.flatMap(
  (e) => e.exception?.values?.map((v) => v.value ?? "") ?? []
)
check(
  "Sentry error capture survives the disabled SDK (captured test error arrived)",
  messages.includes("boot-probe test error"),
  messages
)
check(
  "thrown 500 captured by the house onError hook",
  messages.includes("boot-probe deliberate 500"),
  messages
)
check(
  "expected 400-class error NOT captured (isExpectedClientError gate)",
  !messages.some((m) => m.includes("boot-probe expected client error")),
  messages
)
check(
  "exactly the two expected error events",
  errorEvents.length === 2,
  errorEvents.length
)

await otlp.close()
await sentry.close()
finish("P-A6")
