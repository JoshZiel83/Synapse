import { createHmac, timingSafeEqual } from "node:crypto"

import { config } from "../../config/index.js"
import type { Executor } from "../../infrastructure/database/kysely.js"
import { db } from "../../infrastructure/database/kysely.js"

/**
 * Cross-platform routing for OAuth callback EARLY errors (provider returned
 * `?error=` or no `code`).
 *
 * Better Auth's generic-OAuth callback handles these before it parses state, so
 * it ignores the per-flow errorCallbackURL and jumps to the single global
 * `onAPIError.errorURL` (a web page). That strands a native (Expo) sign-in: the
 * in-app browser only completes when it returns to the app's custom scheme, so
 * a web URL leaves it hanging. We intercept the callback BEFORE delegating to
 * Better Auth and route the error to the right place per the stored state's
 * return URL: a native scheme (synapse:// / exp://) deep-links back into the
 * app; anything else falls back to the web callback page.
 *
 * Because this runs ahead of Better Auth, it also bypasses Better Auth's own
 * CSRF binding (signed `state` cookie must equal the `state` query). We
 * re-check that binding here; on any mismatch we refuse to read/consume the
 * stored state and fall back to the web page.
 */

const WEB_CALLBACK_PATH = "/auth/callback"
const FALLBACK_ERROR_CODE = "oauth_error"

// Better Auth's signed-cookie format is `${value}.${base64(HMAC-SHA256(value))}`
// (better-call/dist/crypto.cjs signCookieValue). Replicate the verification.
function verifyStateCookieBinding(
  state: string,
  stateCookieValue: string | undefined
): boolean {
  if (!stateCookieValue) return false
  const lastDot = stateCookieValue.lastIndexOf(".")
  if (lastDot <= 0) return false
  const value = stateCookieValue.slice(0, lastDot)
  const signature = stateCookieValue.slice(lastDot + 1)
  if (value !== state) return false

  const expected = createHmac("sha256", config.auth.secret)
    .update(value)
    .digest("base64")
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// Non-http(s) app schemes we'll deep-link an error to. `synapse:` is our
// first-party app scheme; deployments may add more via AUTH_TRUSTED_ORIGINS.
// Development additionally allows `exp:` because @better-auth/expo only injects
// exp:// as a trusted origin in dev (and Expo Go returns exp:// deep links).
function allowedNativeSchemes(): Set<string> {
  const schemes = new Set<string>(["synapse"])
  for (const origin of config.auth.trustedOrigins) {
    const match = /^([a-z][a-z0-9+.-]*):/i.exec(origin.trim())
    if (!match) continue
    const scheme = match[1].toLowerCase()
    if (scheme !== "http" && scheme !== "https") schemes.add(scheme)
  }
  if (config.nodeEnv === "development") schemes.add("exp")
  return schemes
}

function schemeOf(url: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())
  return match ? match[1].toLowerCase() : null
}

// Only pass through a known OAuth error code shape; otherwise normalize. The
// value is also URL-encoded by searchParams, so this is defense in depth
// against CRLF / javascript: / markup injection into the redirect Location.
function sanitizeErrorCode(raw: string | undefined): string {
  if (raw && /^[a-z0-9_]+$/i.test(raw)) return raw
  return FALLBACK_ERROR_CODE
}

function webTarget(code: string): string {
  const target = new URL(WEB_CALLBACK_PATH, config.auth.baseUrl)
  target.searchParams.set("error", code)
  return target.toString()
}

/**
 * Build the web error redirect from the stored web return URL, preserving its
 * path + query (e.g. the `redirect` the popup helper threaded in via
 * /auth/callback?redirect=...) and appending `error`. The stored URL was already
 * origin-validated by Better Auth at sign-in, but re-verify here: it must be a
 * relative path, or absolute on our own web origin (config.auth.baseUrl). Any
 * other / unparseable value falls back to the plain web callback.
 */
function webTargetFrom(
  storedReturnUrl: string | undefined,
  code: string
): string {
  if (!storedReturnUrl) return webTarget(code)
  try {
    // Resolve against our web origin so a relative path ("/auth/callback?...")
    // and an absolute same-origin URL both normalize the same way.
    const base = new URL(config.auth.baseUrl)
    const resolved = new URL(storedReturnUrl, base)
    if (resolved.origin !== base.origin) return webTarget(code)
    resolved.searchParams.set("error", code)
    return resolved.toString()
  } catch {
    return webTarget(code)
  }
}

type StoredState = {
  callbackURL?: string
  errorURL?: string
  oauthState?: string
  expiresAt?: number
}

export type OAuthErrorRedirect = {
  /** Absolute URL (native deep link or web page) to 302 to. */
  target: string
  /** True only when state passed every check and its row should be deleted. */
  consumed: boolean
}

/**
 * Resolve where an OAuth early-error should redirect.
 *
 * @param executor Kysely handle. Pass the global `db` in production, or a test
 *   transaction so the lookup sees the same uncommitted rows.
 */
export async function resolveOAuthErrorRedirect({
  executor = db,
  state,
  stateCookieValue,
  errorCode,
}: {
  executor?: Executor
  state: string | undefined
  stateCookieValue: string | undefined
  errorCode: string | undefined
}): Promise<OAuthErrorRedirect> {
  const code = sanitizeErrorCode(errorCode)
  const webFallback: OAuthErrorRedirect = {
    target: webTarget(code),
    consumed: false,
  }

  // No state, or the signed-cookie binding fails -> never trust it for a native
  // deep link, and never consume a (possibly forged) state row.
  if (!state || !verifyStateCookieBinding(state, stateCookieValue)) {
    return webFallback
  }

  const row = await executor
    .selectFrom("verification")
    .where("identifier", "=", state)
    .select(["value", "expires_at"])
    .executeTakeFirst()
  if (!row) return webFallback

  let stored: StoredState
  try {
    stored = JSON.parse(row.value) as StoredState
  } catch {
    return webFallback
  }

  // Mirror Better Auth's own state checks. Its stateDataSchema requires
  // `expiresAt: z.number()`, so a missing/non-number expiry is malformed state,
  // not a valid one — treat it as invalid (web fallback, not consumed), same as
  // an expired or oauthState-mismatched row.
  const now = Date.now()
  const dbExpired = row.expires_at.getTime() <= now
  const payloadExpiryValid =
    typeof stored.expiresAt === "number" &&
    Number.isFinite(stored.expiresAt) &&
    stored.expiresAt > now
  if (stored.oauthState !== state || dbExpired || !payloadExpiryValid) {
    return webFallback
  }

  const storedReturnUrl = stored.errorURL ?? stored.callbackURL
  const scheme = storedReturnUrl ? schemeOf(storedReturnUrl) : null

  // Native only when the stored return URL uses an allowed app scheme.
  if (storedReturnUrl && scheme && allowedNativeSchemes().has(scheme)) {
    try {
      const target = new URL(storedReturnUrl)
      target.searchParams.set("error", code)
      return { target: target.toString(), consumed: true }
    } catch {
      return { target: webTarget(code), consumed: true }
    }
  }

  // Valid web flow (or unknown scheme): web page. State passed every check, so
  // preserve the stored web return URL's path+query (e.g. ?redirect=...) and
  // consume the row.
  return { target: webTargetFrom(storedReturnUrl, code), consumed: true }
}
