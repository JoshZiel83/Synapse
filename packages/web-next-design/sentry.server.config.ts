// Sentry (server runtime) — errors + performance tracing. Self-hosted; all
// config is ENV-DRIVEN (open-source: no hardcoded DSN/host). Gated on a DSN so
// builds/runs without Sentry are unaffected. NO Session Replay (privacy).
import * as Sentry from "@sentry/nextjs"

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    sendDefaultPii: false,
  })
}
