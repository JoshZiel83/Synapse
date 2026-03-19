import { redirect } from "next/navigation"

import { buildLoginRedirect } from "@/lib/auth"
import { getServerAuthState } from "@/lib/server-auth"
import { AuthStoreProvider } from "@/stores/auth-store"

import WelcomeClient from "./welcome-client"

export default async function WelcomePage() {
  const auth = await getServerAuthState()

  if (auth.status === "unauthenticated") {
    redirect(buildLoginRedirect("/welcome"))
  }

  if (!auth.user) {
    throw new Error("Unable to validate the current session for onboarding.")
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted p-6 md:p-10">
      <div className="w-full max-w-sm md:max-w-4xl">
        <AuthStoreProvider initialUser={auth.user}>
          <WelcomeClient />
        </AuthStoreProvider>
      </div>
    </div>
  )
}
