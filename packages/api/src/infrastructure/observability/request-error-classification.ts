import { ZodError } from "zod"

/**
 * Classification of request errors that the global `setErrorHandler` in
 * src/index.ts answers with a 4xx — i.e. client mistakes, not server faults.
 *
 * Shared between the error handler itself and the Sentry `onError` gate in
 * instrumentation.ts, so "what counts as an expected client error" can never
 * drift between HTTP responses and error reporting: an error suppressed from
 * Sentry is exactly an error the handler maps below 500.
 */

export function isMalformedUuidDatabaseError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false
  }

  const candidate = error as { code?: unknown; message?: unknown }
  return (
    candidate.code === "22P02" &&
    typeof candidate.message === "string" &&
    /invalid input syntax for type uuid/i.test(candidate.message)
  )
}

/**
 * Mirrors the `setErrorHandler` branches exactly: malformed-UUID 22P02 → 400,
 * ZodError → 400, and any error carrying a 400–499 `statusCode` keeps it —
 * everything else (including bare 22P02 without the UUID message) becomes 500.
 */
export function isExpectedClientError(error: unknown) {
  if (isMalformedUuidDatabaseError(error) || error instanceof ZodError) {
    return true
  }

  const statusCode = (error as { statusCode?: unknown } | null | undefined)
    ?.statusCode
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500
}
