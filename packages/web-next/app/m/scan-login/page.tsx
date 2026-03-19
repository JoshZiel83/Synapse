import { redirect } from "next/navigation"

import { MobileScanLoginClient } from "@/components/mobile-scan-login-client"
import { MobileAuthShell } from "@/components/mobile-auth-shell"
import { buildMobileLoginRedirect } from "@/lib/auth"
import { getServerAuthState } from "@/lib/server-auth"

export default async function MobileScanLoginPage() {
  const auth = await getServerAuthState()

  if (auth.status === "unauthenticated") {
    redirect(buildMobileLoginRedirect("/m/scan-login"))
  }

  if (!auth.user) {
    throw new Error("Unable to validate the current session for scan login.")
  }

  return (
    <MobileAuthShell
      title="Scan login code"
      description="Scan the QR code on your computer to approve a Web login."
    >
      <MobileScanLoginClient />
    </MobileAuthShell>
  )
}
