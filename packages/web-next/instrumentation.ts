// Next.js server instrumentation entrypoint. Loads the Sentry server/edge config
// for the active runtime and re-exports the request-error hook so server-side
// (RSC / route handler / middleware) errors reach Sentry.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config")
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config")
  }
}

export { captureRequestError as onRequestError } from "@sentry/nextjs"
