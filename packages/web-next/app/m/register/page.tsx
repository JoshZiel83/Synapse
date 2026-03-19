import { Suspense } from "react"
import Link from "next/link"
import { redirect } from "next/navigation"

import { MobileAuthShell } from "@/components/mobile-auth-shell"
import { MobileSignupForm } from "@/components/mobile-signup-form"
import { buildMobileLoginRedirect, normalizeRedirectTarget } from "@/lib/auth"
import { getServerAuthState } from "@/lib/server-auth"

export default async function MobileRegisterPage({
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
      title="Create account"
      description="Set up your Synapse account with a clean mobile flow."
      footer={
        <>
          Already have an account?{" "}
          <Link
            href={buildMobileLoginRedirect(normalizedRedirect)}
            className="text-foreground underline-offset-2 hover:underline"
          >
            Sign in
          </Link>
        </>
      }
    >
      <Suspense>
        <MobileSignupForm />
      </Suspense>
    </MobileAuthShell>
  )
}
