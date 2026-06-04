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
