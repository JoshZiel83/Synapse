import { ApiError } from "@/lib/api"

type AuthActionLabel = "登录" | "注册" | "授权"

/**
 * Map an auth failure to one of three user-facing messages. We deliberately do
 * NOT distinguish "email not registered" from "wrong password" (that leaks which
 * addresses have accounts, and better-auth collapses them by design). The three
 * buckets:
 *   - 429            -> rate limited
 *   - 401 / bad creds -> incorrect email or password
 *   - everything else (network, 5xx, unknown) -> generic retry
 */
export function getAuthErrorMessage(
  error: unknown,
  actionLabel: AuthActionLabel = "授权"
): string {
  const status = error instanceof ApiError ? error.status : undefined
  const code = error instanceof ApiError ? error.code : undefined

  if (status === 429) {
    return "尝试次数过多，请稍后再试。"
  }
  if (status === 401 || code === "INVALID_EMAIL_OR_PASSWORD") {
    return "邮箱或密码有误。"
  }
  return `${actionLabel}失败，请重试。`
}

/**
 * Map an OAuth callback error code (Better Auth's `?error=<code>`, relayed from
 * /auth/callback) to a friendly message. These are provider/flow failures, not
 * credential failures, so they get their own mapping. Always returns a message;
 * callers decide whether to show it based on whether a code was present.
 */
export function getOAuthErrorMessage(
  code: string | null | undefined,
  actionLabel: AuthActionLabel = "授权"
): string {
  if (code === "access_denied") return "已取消授权。"
  return `${actionLabel}失败，请重试。`
}
