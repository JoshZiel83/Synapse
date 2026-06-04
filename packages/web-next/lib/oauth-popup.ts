import { api } from "@/lib/api"
import { normalizeRedirectTarget } from "@/lib/auth"
import { getAuthErrorMessage, getOAuthErrorMessage } from "@/lib/auth-errors"

// Posted by /auth/callback (running inside the popup) back to this opener.
export const OAUTH_MESSAGE_TYPE = "synapse:oauth"

// The callback page tags each message with the provider, threaded through the
// callback URL's query. Better Auth's onAPIError.errorURL fallback (the cancel /
// missing-code / state-parse-failure paths) is a STATIC url with no provider
// query, so those error messages carry this sentinel instead. The opener
// accepts it on errors (it's still gated by event.source === popup).
export const OAUTH_PROVIDER_UNKNOWN = "oauth"

export type OAuthPopupMessage = {
  type: typeof OAUTH_MESSAGE_TYPE
  provider: string
  ok: boolean
  error?: string | null
}

// The popup (and the full-page fallback) lands here after Better Auth's OAuth
// callback. In a popup it relays the outcome to the opener and closes; as a
// full-page navigation it routes itself. We pass it as BOTH callbackURL and
// errorCallbackURL so every outcome (success, cancel, state/token/userInfo
// failure) is funnelled through a page we control instead of Better Auth's
// default ${baseURL}/error (which 404s here).
const POPUP_CALLBACK_PATH = "/auth/callback"

const POPUP_FEATURES = "popup=yes,width=480,height=640,menubar=no,toolbar=no"
const POPUP_TIMEOUT_MS = 5 * 60 * 1000
const CLOSE_POLL_MS = 500

// Build the controlled callback URL, threading provider + final destination
// through as query params. better-auth appends `?error=<code>` (or `&error=`)
// on failure, so these survive into the callback page's search params.
function buildCallbackUrl(providerId: string, finalDestination: string) {
  const params = new URLSearchParams({ provider: providerId })
  const redirect = normalizeRedirectTarget(finalDestination)
  if (redirect) params.set("redirect", redirect)
  return `${POPUP_CALLBACK_PATH}?${params.toString()}`
}

type SignInOptions = {
  providerId: string
  /** Where the opener should navigate on success (already-normalized path). */
  finalDestination: string
  onSuccess: () => void
  onCancel: () => void
  onError: (message: string) => void
}

/**
 * Mainstream "popup-first, redirect-fallback" OAuth sign-in.
 *
 * Opens the provider authorization flow in a popup; on success the popup's
 * /auth/callback page posts back here and we hand control to onSuccess. If the
 * browser blocks the popup (or opening/initiating fails), we fall back to a
 * full-page redirect — the reliable path that always works. The session cookie
 * is set by Better Auth on the callback either way (same-origin), so the opener
 * just needs to route once it knows auth succeeded.
 *
 * Returns a cleanup function (remove listener, clear timers). Generic over
 * providers so Google/Apple can reuse it.
 */
export function signInWithOAuthPopup({
  providerId,
  finalDestination,
  onSuccess,
  onCancel,
  onError,
}: SignInOptions): () => void {
  // Open the window SYNCHRONOUSLY in the click handler. Opening after an await
  // loses the user-gesture context and browsers block it as an unsolicited
  // popup. We point it at about:blank first, then inject the real URL once we
  // have it (or close it and fall back if we couldn't open it at all).
  const popup =
    typeof window !== "undefined"
      ? window.open("about:blank", `oauth-${providerId}`, POPUP_FEATURES)
      : null

  let settled = false
  // Set by cleanup() (e.g. the caller unmounted). Guards every async
  // continuation below so a late startOAuth resolution can't drive the popup,
  // navigate the page, or kick off the full-page fallback after teardown.
  let cancelled = false
  // Mutable holder so the timers can be assigned later (after the early-return
  // for a blocked popup) while cleanup still closes over them.
  const timers: {
    closePoll?: ReturnType<typeof setInterval>
    timeout?: ReturnType<typeof setTimeout>
  } = {}

  function teardownListeners() {
    if (timers.closePoll) clearInterval(timers.closePoll)
    if (timers.timeout) clearTimeout(timers.timeout)
    window.removeEventListener("message", onMessage)
  }

  // Returned to the caller; invoked on unmount. Marks the flow cancelled so any
  // pending async continuation (a not-yet-resolved startOAuth) becomes a no-op,
  // and closes the popup so it isn't orphaned (no opener left to receive its
  // result). settle() uses teardownListeners() instead, so the normal terminal
  // paths don't close a popup that's already closing itself.
  function cleanup() {
    cancelled = true
    teardownListeners()
    if (popup && !popup.closed) popup.close()
  }

  function settle(fn: () => void) {
    if (settled || cancelled) return
    settled = true
    teardownListeners()
    fn()
  }

  // Full-page redirect fallback. Routes through the SAME controlled callback
  // page (as callbackURL and errorCallbackURL) so a cancel/state/token/userInfo
  // failure lands on a page we own — the callback's no-opener branch then routes
  // to the destination on success or to /login?error= on failure.
  async function fallbackToRedirect() {
    if (cancelled) return
    try {
      const callback = buildCallbackUrl(providerId, finalDestination)
      const { url } = await api.startOAuth(providerId, callback, {
        errorCallbackURL: callback,
      })
      if (cancelled) return
      window.location.href = url
    } catch (err) {
      settle(() => onError(getAuthErrorMessage(err)))
    }
  }

  function onMessage(event: MessageEvent) {
    // Only trust messages from our own origin and from the popup we opened.
    // (event.source === popup is the real gate; the provider check below is a
    // secondary tag, not a security boundary.)
    if (event.origin !== window.location.origin) return
    if (popup && event.source !== popup) return
    const data = event.data as OAuthPopupMessage | undefined
    if (!data || data.type !== OAUTH_MESSAGE_TYPE) return

    if (data.ok) {
      // Success must be for THIS provider.
      if (data.provider !== providerId) return
      popup?.close()
      settle(onSuccess)
    } else {
      // Errors may arrive provider-less (Better Auth's onAPIError.errorURL
      // fallback for cancel/missing-code/state-fail has no provider query), so
      // accept our provider or the unknown sentinel. data.error is an OAuth
      // error code, not an HTTP error.
      if (
        data.provider !== providerId &&
        data.provider !== OAUTH_PROVIDER_UNKNOWN
      ) {
        return
      }
      popup?.close()
      settle(() => onError(getOAuthErrorMessage(data.error)))
    }
  }

  // Popup blocked outright -> go straight to the redirect path.
  if (!popup) {
    void fallbackToRedirect()
    return cleanup
  }

  window.addEventListener("message", onMessage)

  // Watchdog: detect the user manually closing the popup, and cap the wait.
  timers.closePoll = setInterval(() => {
    if (popup.closed) settle(onCancel)
  }, CLOSE_POLL_MS)
  timers.timeout = setTimeout(() => {
    if (!popup.closed) popup.close()
    settle(onCancel)
  }, POPUP_TIMEOUT_MS)

  // Fetch the authorization URL, then drive the popup to it. On any failure
  // (network, the popup vanished), close it and fall back to a redirect.
  const callback = buildCallbackUrl(providerId, finalDestination)
  api
    .startOAuth(providerId, callback, {
      errorCallbackURL: callback,
    })
    .then(({ url }) => {
      if (settled || cancelled) return
      if (popup.closed) {
        // User closed it before we were ready; treat as cancel.
        settle(onCancel)
        return
      }
      popup.location.href = url
    })
    .catch(() => {
      if (settled || cancelled) return
      // Couldn't initiate via popup; close it and try the full-page path.
      if (!popup.closed) popup.close()
      // Tear down listener/timers but NOT the cancellation flag — this is a
      // re-arm, not an unmount, so fallbackToRedirect must still run.
      teardownListeners()
      void fallbackToRedirect()
    })

  return cleanup
}
