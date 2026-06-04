"use client"

import { useState } from "react"

import { api } from "@/lib/api"
import { FeishuIcon } from "@/components/brand-icons"
import { Button } from "@/components/ui/button"

/**
 * Feishu OAuth entry, shared by the login and signup forms. Better Auth returns
 * a redirect URL we navigate to ourselves (see api.startOAuth). OAuth sign-in
 * also provisions a new account, so the same button fits both surfaces.
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
  const [isRedirecting, setIsRedirecting] = useState(false)

  async function handleClick() {
    setIsRedirecting(true)
    try {
      const { url } = await api.startOAuth("feishu", redirect ?? "/dashboard")
      window.location.href = url
    } catch (err) {
      setIsRedirecting(false)
      onError(err instanceof Error ? err.message : "Feishu sign-in failed")
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      onClick={handleClick}
      disabled={disabled || isRedirecting}
    >
      <FeishuIcon className="size-4" />
      Continue with Feishu
    </Button>
  )
}
