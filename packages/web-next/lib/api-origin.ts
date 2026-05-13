const DEFAULT_PUBLIC_API_PREFIX = "/api/v1"
const DEFAULT_API_PROXY_ORIGIN = "http://127.0.0.1:3001"

export function normalizePublicApiPrefix(value: string | null | undefined) {
  if (!value || !value.startsWith("/")) {
    return DEFAULT_PUBLIC_API_PREFIX
  }

  const normalized = value.replace(/\/+$/, "")
  return normalized || DEFAULT_PUBLIC_API_PREFIX
}

export function getPublicApiPrefix() {
  return normalizePublicApiPrefix(process.env.NEXT_PUBLIC_API_URL)
}

export function getApiProxyOrigin() {
  return (process.env.API_PROXY_ORIGIN || DEFAULT_API_PROXY_ORIGIN).replace(
    /\/+$/,
    ""
  )
}

export function buildApiProxyUrl(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`
  return `${getApiProxyOrigin()}${getPublicApiPrefix()}${normalizedPath}`
}
