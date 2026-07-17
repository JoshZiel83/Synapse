import Constants from "expo-constants"
import { Platform } from "react-native"

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "")
}

function ensureScheme(value: string) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`
}

// --- Normalization primitives ----------------------------------------------
// Two tiers: `*OrThrow` for network/connection/resource entry points (a missing
// OR malformed value must fail loud there), and `tryNormalize*` for render /
// auth-client construction / display paths (must degrade to undefined, never
// throw — Expo static web export prerenders every route on Node, so any throw
// reachable at import or render time aborts the whole export).

function normalizeApiBaseOrThrow(raw: string) {
  const url = new URL(ensureScheme(raw))
  if (url.pathname === "/" || url.pathname.trim().length === 0) {
    url.pathname = "/api/v1"
  }
  return trimTrailingSlash(url.toString())
}

function normalizeOriginOrThrow(raw: string) {
  return trimTrailingSlash(new URL(ensureScheme(raw)).origin)
}

function tryNormalizeApiBase(raw?: string): string | undefined {
  if (!raw) return undefined
  try {
    return normalizeApiBaseOrThrow(raw)
  } catch {
    return undefined
  }
}

function tryNormalizeOrigin(raw?: string): string | undefined {
  if (!raw) return undefined
  try {
    return normalizeOriginOrThrow(raw)
  } catch {
    return undefined
  }
}

// --- Raw env readers --------------------------------------------------------
// Read at call time (never at module load) so importing this file is a no-op
// regardless of env state — the prerender-safety guarantee.

function getRawApiUrl(): string | undefined {
  return process.env.EXPO_PUBLIC_API_URL?.trim() || undefined
}

function getRawAuthOrigin(): string | undefined {
  return process.env.EXPO_PUBLIC_AUTH_ORIGIN?.trim() || undefined
}

const MISSING_API_URL_MESSAGE =
  "Missing EXPO_PUBLIC_API_URL. Set it at build time, for example: https://your-api-host/api/v1"

// Cache only the successfully-normalized base. A malformed value is never
// cached (so a later corrected env is still picked up within the same process).
let cachedApiBase: string | undefined

// --- Throwing accessors (network / connection / resource entry points) ------

/**
 * Absolute API base ending in /api/v1. Throws when EXPO_PUBLIC_API_URL is unset
 * (Missing message) or malformed (URL TypeError). Call this only from real
 * network/connection paths, never at module load or during render.
 */
export function getApiBase(): string {
  if (cachedApiBase !== undefined) return cachedApiBase
  const raw = getRawApiUrl()
  if (!raw) {
    throw new Error(MISSING_API_URL_MESSAGE)
  }
  cachedApiBase = normalizeApiBaseOrThrow(raw)
  return cachedApiBase
}

export function getApiOrigin(): string {
  return new URL(getApiBase()).origin
}

/**
 * Public origin Better Auth is mounted on. Defaults to getApiOrigin(); can be
 * overridden via EXPO_PUBLIC_AUTH_ORIGIN when the browser-facing public origin
 * differs from the internal API origin. Throws on missing API or malformed
 * AUTH_ORIGIN.
 */
export function getAuthOrigin(): string {
  const rawAuth = getRawAuthOrigin()
  if (rawAuth) return normalizeOriginOrThrow(rawAuth)
  return getApiOrigin()
}

/** Fail loud if the API URL is unset or malformed. */
export function assertApiConfigured(): void {
  getApiBase()
}

/**
 * Fail loud before any Better Auth network action: the API URL must be valid,
 * AND if EXPO_PUBLIC_AUTH_ORIGIN is set it must be valid too. Without this an
 * unset/malformed AUTH_ORIGIN would make the client silently fall back to
 * better-auth's BASE_URL / window.location.origin / "/api/auth" default.
 */
export function assertAuthConfigured(): void {
  getApiBase()
  const rawAuth = getRawAuthOrigin()
  if (rawAuth) normalizeOriginOrThrow(rawAuth)
}

export function getWebSocketUrl(path = "/ws") {
  const url = new URL(getApiBase())
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
    return new URL(normalized, getApiOrigin()).toString()
  }
}

// --- Non-throwing helpers (render / client construction / display) ----------

/**
 * baseURL to hand to createAuthClient. Returns an ABSOLUTE string when a valid
 * value is configured, or undefined when nothing valid is configured so
 * better-auth self-derives at construction WITHOUT throwing in
 * assertHasProtocol. NEVER returns a relative string, NEVER throws (so the lazy
 * client can be constructed during prerender with any env).
 */
export function getAuthBaseURLForClient(): string | undefined {
  const fromAuth = tryNormalizeOrigin(getRawAuthOrigin())
  if (fromAuth) return fromAuth
  const apiBase = tryNormalizeApiBase(getRawApiUrl())
  if (!apiBase) return undefined
  try {
    return new URL(apiBase).origin
  } catch {
    return undefined
  }
}

/**
 * Whether the config is complete enough to make an authenticated network call.
 * Stricter than `getAuthBaseURLForClient() !== undefined`: the API URL must be
 * valid (not just AUTH_ORIGIN), and a present AUTH_ORIGIN must be valid. Used by
 * signOut to decide between a best-effort remote sign-out and a local-only
 * clear, so a missing/malformed config never hits the wrong endpoint.
 */
export function hasValidAuthNetworkConfig(): boolean {
  if (!tryNormalizeApiBase(getRawApiUrl())) return false
  const rawAuth = getRawAuthOrigin()
  if (rawAuth && !tryNormalizeOrigin(rawAuth)) return false
  return true
}

/** Display-only API base for debug surfaces; never throws. */
export function getApiBaseForDisplay(): string {
  return tryNormalizeApiBase(getRawApiUrl()) ?? "(未配置)"
}

/**
 * Sentry `tracePropagationTargets` restricted to the API/auth origins. The RN
 * SDK default is `[/.*\/]` — that would attach `sentry-trace`/`baggage`
 * (environment + DSN public key) to EVERY third-party XHR with no CORS to stop
 * it, so an explicit allowlist is mandatory. Anchored RegExps because Sentry
 * treats plain string patterns as substring matches; native `shouldAttachHeaders`
 * tests the raw absolute request URL, so one anchored-origin regex per origin
 * covers it. Non-throwing and prerender-safe (tryNormalize* tier): unset or
 * malformed env ⇒ `[]` = fail-safe, no trace headers anywhere.
 */
export function getSentryTracePropagationTargets(): RegExp[] {
  const origins = new Set<string>()
  const apiBase = tryNormalizeApiBase(getRawApiUrl())
  if (apiBase) {
    try {
      origins.add(new URL(apiBase).origin)
    } catch {
      // unreachable after tryNormalize, but stay non-throwing by contract
    }
  }
  const authOrigin = tryNormalizeOrigin(getRawAuthOrigin())
  if (authOrigin) origins.add(authOrigin)

  return [...origins].map(
    (origin) =>
      new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)`)
  )
}

// Content-addressed file ref render URL. file_ref blocks now carry a sha256
// (+ optional path); bytes are served by GET /content/<sha256>. Returns
// undefined when there is no sha256 to resolve OR when the API base is not
// configured (this is reachable from render, so it must not throw).
export function resolveContentUrl(sha256?: string | null) {
  if (!sha256) return undefined
  const base = tryNormalizeApiBase(getRawApiUrl())
  if (!base) return undefined
  return `${base}/content/${sha256}`
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
