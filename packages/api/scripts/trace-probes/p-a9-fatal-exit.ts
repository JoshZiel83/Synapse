// P-A9 (fatalExit flush) — §4.A lifecycle verification of
// docs/trace-correctness-remediation-plan-2026-07-12.md: the thrown-timer
// probe. The boot-probe child throws from a setTimeout AFTER serving a
// request; the Synapse-owned uncaughtException handler must:
//   - exit 1 (uniform strict crash semantics, Sentry on or off);
//   - export the BUFFERED spans of the served request (bounded flush inside
//     fatalExit — pre-rewrite they died with the process);
//   - deliver a Sentry event tagged fatal.context=uncaughtException.
// Run: npx tsx scripts/trace-probes/p-a9-fatal-exit.ts
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
  OTEL_EXPORTER_OTLP_ENDPOINT: otlp.url,
  SENTRY_DSN: sentry.dsn,
  BOOT_PROBE_CRASH: "1",
})

check("crashed child exits 1", run.code === 1, { code: run.code })
check(
  "fatal handler logged the crash context",
  run.stderr.includes("[fatal] uncaughtException:"),
  run.stderr.slice(0, 300)
)
check("BOOT_OK NOT printed (the crash preempted the clean path)", !run.bootOk)

// Buffered spans of the served request were exported by fatalExit's bounded
// shutdownTelemetry (BatchSpanProcessor's 5s schedule had not fired yet).
check(
  "buffered route span exported on the way down",
  otlp.text().includes("GET /ping"),
  { posts: otlp.posts.length }
)

interface FatalEventPayload {
  tags?: Record<string, unknown>
  exception?: {
    values?: Array<{ value?: string; mechanism?: { handled?: boolean } }>
  }
}
const events = sentry
  .itemsOfType("event")
  .map((i) => i.payload as FatalEventPayload)
const fatalEvent = events.find((e) =>
  e.exception?.values?.some((v) => v.value === "boot-probe deliberate crash")
)
check(
  "Sentry received the crash event",
  fatalEvent !== undefined,
  events.length
)
check(
  "crash event tagged fatal.context=uncaughtException",
  fatalEvent?.tags?.["fatal.context"] === "uncaughtException",
  fatalEvent?.tags
)
check(
  "crash event mechanism handled=false",
  fatalEvent?.exception?.values?.some((v) => v.mechanism?.handled === false) ===
    true
)

await otlp.close()
await sentry.close()
finish("P-A9")
