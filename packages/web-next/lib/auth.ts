export const AUTH_SESSION_COOKIE_NAME = "synapse_session"

export function normalizeRedirectTarget(input: string | null | undefined) {
  if (!input) return null

  const target = input.trim()
  if (!target.startsWith("/")) return null
  if (target.startsWith("//")) return null
  if (target.includes("\n") || target.includes("\r")) return null

  return target
}

export function buildLoginRedirect(target?: string | null) {
  const normalized = normalizeRedirectTarget(target)
  return normalized
    ? `/login?redirect=${encodeURIComponent(normalized)}`
    : "/login"
}

export function buildMobileLoginRedirect(target?: string | null) {
  const normalized = normalizeRedirectTarget(target)
  return normalized
    ? `/m/login?redirect=${encodeURIComponent(normalized)}`
    : "/m/login"
}
