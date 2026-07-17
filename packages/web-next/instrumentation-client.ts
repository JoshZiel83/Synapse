// Sentry (browser) — errors + performance tracing. ENV-DRIVEN + DSN-gated.
// NO Session Replay: this is a chat product and replay would record message
// content.
//
// Trace bridge: the public edge strips `sentry-trace`/`baggage`/`tracestate`
// at nginx (Ring 0 trust boundary) — only W3C `traceparent` crosses it. So
// browser→api correlation rides `propagateTraceparent` exclusively: requests
// to first-party targets carry a spec-valid `00-<traceId>-<spanId>-<flags>`
// header the api's OTel propagator extracts (untrusted: validated at extract,
// flags advisory), which works in every Sentry-on/off matrix cell — including
// api Sentry OFF, where Tempo still shows one browser-rooted trace.
import * as Sentry from "@sentry/nextjs"

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

// Docker/compose materialize unset vars as EMPTY STRINGS and
// `Number("") === 0`, which would silently zero sampling — `|| "0.1"` +
// isFinite keeps the 0.1 default for empty/garbage while honoring explicit 0.
function parseSampleRate(raw: string | undefined): number {
  const parsed = Number(raw || "0.1")
  return Number.isFinite(parsed) ? parsed : 0.1
}

// Trace headers attach to same-origin requests (`/api/v1/*` through the Next
// rewrite proxy — the default deploy) AND to the API origin when
// NEXT_PUBLIC_API_URL is configured absolute (split-origin deploys previously
// attached NO trace headers). Anchored RegExp: Sentry treats plain strings as
// substring matches, which would over-match.
function buildTracePropagationTargets(): RegExp[] {
  const targets: RegExp[] = [/^\//]
  const apiUrl = process.env.NEXT_PUBLIC_API_URL
  if (apiUrl && /^https?:\/\//i.test(apiUrl)) {
    try {
      const origin = new URL(apiUrl).origin
      const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      targets.push(new RegExp(`^${escaped}(/|$)`))
    } catch {
      // Malformed absolute URL — keep same-origin-only rather than guess.
    }
  }
  return targets
}

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ||
      process.env.NODE_ENV ||
      "development",
    tracesSampleRate: parseSampleRate(
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
    ),
    // Emit W3C traceparent alongside sentry-trace on matching requests — the
    // only header that survives the public-edge strip (see header comment).
    propagateTraceparent: true,
    tracePropagationTargets: buildTracePropagationTargets(),
    sendDefaultPii: false,
  })
}

// Required by Next.js App Router for client-side navigation instrumentation.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
