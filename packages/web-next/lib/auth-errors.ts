import { ApiError } from "@/lib/api"

/**
 * Map an auth failure to one of three user-facing messages. We deliberately do
 * NOT distinguish "email not registered" from "wrong password" (that leaks which
 * addresses have accounts, and better-auth collapses them by design). The three
 * buckets:
 *   - 429            -> rate limited
 *   - 401 / bad creds -> incorrect email or password
 *   - everything else (network, 5xx, unknown) -> generic retry
 */
export function getAuthErrorMessage(error: unknown): string {
  const status = error instanceof ApiError ? error.status : undefined
  const code = error instanceof ApiError ? error.code : undefined

  if (status === 429) {
    return "Too many attempts. Please try again later."
  }
  if (status === 401 || code === "INVALID_EMAIL_OR_PASSWORD") {
    return "Incorrect email or password."
  }
  return "Something went wrong. Please try again."
}

/**
 * Map an OAuth callback error code (Better Auth's `?error=<code>`, relayed from
 * /auth/callback) to a friendly message. These are provider/flow failures, not
 * credential failures, so they get their own mapping. Always returns a message;
 * callers decide whether to show it based on whether a code was present.
 */
export function getOAuthErrorMessage(code: string | null | undefined): string {
  if (code === "access_denied") return "Sign-in was cancelled."
  return "Sign-in failed. Please try again."
}
