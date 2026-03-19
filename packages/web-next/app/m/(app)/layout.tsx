import { redirect } from "next/navigation"
import type { ReactNode } from "react"

import { buildMobileLoginRedirect } from "@/lib/auth"
import { getServerAuthState } from "@/lib/server-auth"
import { AuthStoreProvider } from "@/stores/auth-store"
import MobileLayoutClient from "../mobile-layout-client"

export default async function MobileAppLayout({
  children,
}: {
  children: ReactNode
}) {
  const auth = await getServerAuthState()

  if (auth.status === "unauthenticated") {
    redirect(buildMobileLoginRedirect("/m"))
  }

  if (!auth.user) {
    throw new Error(
      "Unable to validate the current session for mobile routes."
    )
  }

  return (
    <AuthStoreProvider initialUser={auth.user}>
      <MobileLayoutClient>{children}</MobileLayoutClient>
    </AuthStoreProvider>
  )
}
