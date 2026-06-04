"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"

import { signInWithOAuthPopup } from "@/lib/oauth-popup"
import { resolveDestination } from "@/lib/post-login"
import { FeishuIcon } from "@/components/brand-icons"
import { Button } from "@/components/ui/button"

/**
 * Feishu OAuth entry, shared by the login and signup forms. Tries a popup first
 * and falls back to a full-page redirect if the browser blocks it (see
 * signInWithOAuthPopup). OAuth sign-in also provisions a new account, so the
 * same button fits both surfaces.
 */
export function FeishuSignInButton({
  redirect,
  disabled,
  onError,
}: {
  redirect: string | null
  disabled?: boolean
  onError: (message: string) => void
}) {
  const router = useRouter()
  const [isBusy, setIsBusy] = useState(false)
  const cleanupRef = useRef<(() => void) | null>(null)

  // Tear down any in-flight popup listener/timers if we unmount mid-flow.
  useEffect(() => () => cleanupRef.current?.(), [])

  function handleClick() {
    setIsBusy(true)
    onError("")
    cleanupRef.current = signInWithOAuthPopup({
      providerId: "feishu",
      finalDestination: redirect ?? "/dashboard",
      onSuccess: () => {
        // Cookie is set; route to the resolved destination. (On the redirect
        // fallback the whole tab navigates and this never runs.)
        void resolveDestination(redirect)
          .then((dest) => router.replace(dest))
          .catch(() => router.replace("/dashboard"))
      },
      onCancel: () => setIsBusy(false),
      onError: (message) => {
        setIsBusy(false)
        if (message) onError(message)
      },
    })
  }

  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      onClick={handleClick}
      disabled={disabled || isBusy}
    >
      {isBusy ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <FeishuIcon className="size-4" />
      )}
      Continue with Feishu
    </Button>
  )
}
