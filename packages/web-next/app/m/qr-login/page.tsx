import { redirect } from "next/navigation"

import { MobileAuthShell } from "@/components/mobile-auth-shell"
import { MobileQrLoginConfirm } from "@/components/mobile-qr-login-confirm"
import { buildMobileLoginRedirect } from "@/lib/auth"
import { getServerAuthState } from "@/lib/server-auth"

interface MobileQrLoginPageProps {
  searchParams: Promise<{
    token?: string
  }>
}

export default async function MobileQrLoginPage({
  searchParams,
}: MobileQrLoginPageProps) {
  const params = await searchParams
  const token = typeof params.token === "string" ? params.token.trim() : ""

  if (!token) {
    return (
      <MobileAuthShell
        title="Invalid login code"
        description="This QR login link is incomplete or malformed."
      >
        <div className="rounded-2xl border border-border/70 bg-background px-4 py-4 text-sm text-muted-foreground">
          Open the QR code again from your computer and scan it with Synapse mobile.
        </div>
      </MobileAuthShell>
    )
  }

  const auth = await getServerAuthState()

  if (auth.status === "unauthenticated") {
    redirect(buildMobileLoginRedirect(`/m/qr-login?token=${encodeURIComponent(token)}`))
  }

  if (!auth.user) {
    throw new Error("Unable to validate the current session for QR login.")
  }

  return (
    <MobileAuthShell
      title="Confirm Web login"
      description="Review the browser session and approve it from your phone."
    >
      <MobileQrLoginConfirm token={token} userName={auth.user.name} />
    </MobileAuthShell>
  )
}
