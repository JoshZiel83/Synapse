import Constants from "expo-constants"
import { Platform } from "react-native"

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "")
}

function resolveApiBase() {
  const configured = process.env.EXPO_PUBLIC_API_URL?.trim()
  if (!configured) {
    throw new Error(
      "Missing EXPO_PUBLIC_API_URL. Set it at build time, for example: https://your-api-host/api/v1"
    )
  }

  const normalizedInput = /^https?:\/\//i.test(configured)
    ? configured
    : `https://${configured}`
  const url = new URL(normalizedInput)

  if (url.pathname === "/" || url.pathname.trim().length === 0) {
    url.pathname = "/api/v1"
  }

  return trimTrailingSlash(url.toString())
}

export const API_BASE = resolveApiBase()
export const API_ORIGIN = new URL(API_BASE).origin

/**
 * Public origin Better Auth is mounted on (drives OAuth redirect_uri + the
 * origin where session/state cookies land). Defaults to API_ORIGIN, but can be
 * overridden via EXPO_PUBLIC_AUTH_ORIGIN when the browser-facing public origin
 * (which proxies /api/v1 -> API) differs from the internal API origin.
 */
function resolveAuthOrigin() {
  const configured = process.env.EXPO_PUBLIC_AUTH_ORIGIN?.trim()
  if (!configured) return API_ORIGIN
  const normalized = /^https?:\/\//i.test(configured)
    ? configured
    : `https://${configured}`
  return trimTrailingSlash(new URL(normalized).origin)
}

export const AUTH_ORIGIN = resolveAuthOrigin()

export function getWebSocketUrl(path = "/ws") {
  const url = new URL(API_BASE)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = path.startsWith("/") ? path : `/${path}`
  url.search = ""
  url.hash = ""
  return url.toString()
}

export function resolveApiUrl(pathOrUrl: string) {
  if (!pathOrUrl) return pathOrUrl

  try {
    return new URL(pathOrUrl).toString()
  } catch {
    const normalized = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`
    return new URL(normalized, API_ORIGIN).toString()
  }
}

// Content-addressed file ref render URL. file_ref blocks now carry a sha256
// (+ optional path); bytes are served by GET /content/<sha256>. Returns
// undefined when there is no sha256 to resolve.
export function resolveContentUrl(sha256?: string | null) {
  if (!sha256) return undefined
  return `${API_BASE}/content/${sha256}`
}

export function getPlatformClientType() {
  if (Platform.OS === "ios") return "ios"
  if (Platform.OS === "android") return "android"
  return "web"
}

export function getDeviceLabel() {
  const deviceName = Constants.deviceName?.trim()
  if (deviceName) return deviceName
  if (Platform.OS === "web") return "Web App"
  return Platform.OS === "ios" ? "iPhone App" : "Android App"
}
