import { redirect } from "next/navigation"
import type { ReactNode } from "react"
import { buildLoginRedirect } from "@/lib/auth"
import { getServerAuthState } from "@/lib/server-auth"
import { AuthStoreProvider } from "@/stores/auth-store"
import DashboardLayoutClient from "./dashboard-layout-client"

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode
}) {
  const auth = await getServerAuthState()

  if (auth.status === "unauthenticated") {
    redirect(buildLoginRedirect("/dashboard"))
  }

  if (!auth.user) {
    throw new Error(
      "Unable to validate the current session for protected routes."
    )
  }

  return (
    <AuthStoreProvider initialUser={auth.user}>
      <DashboardLayoutClient>{children}</DashboardLayoutClient>
    </AuthStoreProvider>
  )
}
