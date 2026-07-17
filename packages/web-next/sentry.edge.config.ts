// Sentry (edge runtime). Same env-driven, DSN-gated, no-replay setup as the
// server config; imported by instrumentation.ts when NEXT_RUNTIME === "edge".
import * as Sentry from "@sentry/nextjs"

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN

// Docker/compose materialize unset vars as EMPTY STRINGS and
// `Number("") === 0` would silently zero sampling — `|| "0.1"` + isFinite
// keeps the 0.1 default for empty/garbage while honoring explicit 0.
function parseSampleRate(raw: string | undefined): number {
  const parsed = Number(raw || "0.1")
  return Number.isFinite(parsed) ? parsed : 0.1
}

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    // The WEB-SCOPED head rate — deliberately NOT the api's repurposed
    // SENTRY_TRACES_SAMPLE_RATE (that var is a Sentry FORWARD rate with
    // different semantics and is never forwarded to the web container).
    tracesSampleRate: parseSampleRate(
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
    ),
    // Emit W3C traceparent on outgoing first-party requests so correlation
    // holds even where sentry-trace is stripped/ignored.
    propagateTraceparent: true,
    sendDefaultPii: false,
  })
}
