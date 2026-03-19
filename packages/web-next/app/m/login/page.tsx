import { Suspense } from "react"
import Link from "next/link"
import { redirect } from "next/navigation"

import { MobileAuthShell } from "@/components/mobile-auth-shell"
import { MobileLoginForm } from "@/components/mobile-login-form"
import { normalizeRedirectTarget } from "@/lib/auth"
import { getServerAuthState } from "@/lib/server-auth"

function buildMobileRegisterHref(redirect: string | null) {
  if (!redirect) return "/m/register"
  return `/m/register?redirect=${encodeURIComponent(redirect)}`
}

export default async function MobileLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>
}) {
  const [{ redirect: redirectTarget }, auth] = await Promise.all([
    searchParams,
    getServerAuthState(),
  ])
  const normalizedRedirect = normalizeRedirectTarget(redirectTarget)

  if (auth.status === "authenticated") {
    redirect("/m")
  }

  return (
    <MobileAuthShell
      title="Sign in"
      description="Access your Synapse workspace from your phone."
      footer={
        <>
          Don&apos;t have an account?{" "}
          <Link
            href={buildMobileRegisterHref(normalizedRedirect)}
            className="text-foreground underline-offset-2 hover:underline"
          >
            Sign up
          </Link>
        </>
      }
    >
      <Suspense>
        <MobileLoginForm />
      </Suspense>
    </MobileAuthShell>
  )
}
