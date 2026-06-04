import { ApiError } from "@/lib/api"

/**
 * Map an auth failure to one of three user-facing messages (Simplified Chinese,
 * to match the app's hardcoded copy). We deliberately do NOT distinguish
 * "邮箱未注册" from "密码错误" — that leaks which addresses have accounts, and
 * the backend (better-auth) collapses them by design.
 *
 *   - 429              -> 限流（尝试过多）
 *   - 401 / 凭据错误    -> 邮箱或密码错误
 *   - 其它（网络/5xx/未知）-> 通用兜底（可按场景自定义 fallback）
 *
 * `fallback` overrides only the third bucket, so screens with a more specific
 * generic message (e.g. the QR flow) can keep theirs.
 */
export function getAuthErrorMessage(
  error: unknown,
  fallback = "网络或服务异常，请稍后再试。"
): string {
  const status = error instanceof ApiError ? error.status : undefined
  const code = error instanceof ApiError ? error.code : undefined

  if (status === 429) {
    return "尝试过多，请稍后再试。"
  }
  if (status === 401 || code === "INVALID_EMAIL_OR_PASSWORD") {
    return "邮箱或密码错误。"
  }
  return fallback
}
