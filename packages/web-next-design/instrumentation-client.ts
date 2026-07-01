// Sentry (browser) — errors + performance tracing. ENV-DRIVEN + DSN-gated.
// NO Session Replay: this is a chat product and replay would record message
// content. web→api is same-origin (next rewrites proxy), so Sentry's
// sentry-trace/baggage headers reach the api (whose @sentry/opentelemetry
// propagator continues the trace into Tempo) — one trace across the boundary.
import * as Sentry from "@sentry/nextjs"

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ||
      process.env.NODE_ENV ||
      "development",
    tracesSampleRate: Number(
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.1"
    ),
    // Attach trace headers to same-origin API calls so the backend can stitch.
    tracePropagationTargets: [/^\//],
    sendDefaultPii: false,
  })
}

// Required by Next.js App Router for client-side navigation instrumentation.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
