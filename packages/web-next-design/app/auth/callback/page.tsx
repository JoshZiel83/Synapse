"use client"

import { Suspense, useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"

import { normalizeRedirectTarget } from "@/lib/auth"
import { OAUTH_MESSAGE_TYPE, OAUTH_PROVIDER_UNKNOWN } from "@/lib/oauth-popup"
import { resolveDestination } from "@/lib/post-login"

const MESSAGE = "Finishing sign-in…"

function StatusScreen() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted p-6 text-sm text-muted-foreground">
      {MESSAGE}
    </main>
  )
}

/**
 * OAuth popup landing page. Better Auth redirects here (as both callbackURL and
 * errorCallbackURL) after the provider flow; the session cookie is already set
 * by then. We relay the outcome to the opener and close. If there's no opener
 * (the redirect fallback path, or a direct hit), we route ourselves so the page
 * never dead-ends.
 */
function CallbackInner() {
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    const error = searchParams.get("error")
    const ok = !error
    // Provider is threaded through the callback URL so this page (and the
    // opener's message filter) stays generic across providers. Better Auth's
    // onAPIError.errorURL fallback (cancel / missing-code / state-fail) is a
    // static URL with no provider query, so default to the unknown sentinel.
    const provider = searchParams.get("provider") ?? OAUTH_PROVIDER_UNKNOWN

    // Popup case: hand the result to the opener and close ourselves. Return
    // after posting so a blocked close() doesn't also self-route (which would
    // render the dashboard inside the little popup window).
    if (window.opener && window.opener !== window) {
      window.opener.postMessage(
        { type: OAUTH_MESSAGE_TYPE, provider, ok, error },
        window.location.origin
      )
      window.close()
      return
    }

    // No-opener fallback: this tab IS the flow. Route based on outcome.
    const redirect = normalizeRedirectTarget(searchParams.get("redirect"))
    if (ok) {
      void resolveDestination(redirect)
        .then((dest) => router.replace(dest))
        .catch(() => router.replace("/dashboard"))
    } else {
      // Carry the (validated) redirect back to /login so a retry still lands on
      // the originally-requested page.
      const params = new URLSearchParams({ error })
      if (redirect) params.set("redirect", redirect)
      router.replace(`/login?${params.toString()}`)
    }
  }, [router, searchParams])

  return <StatusScreen />
}

export default function OAuthCallbackPage() {
  return (
    <Suspense fallback={<StatusScreen />}>
      <CallbackInner />
    </Suspense>
  )
}
