import { redirect } from "next/navigation"

import { MobileAuthShell } from "@/components/mobile-auth-shell"
import { MobileUnifiedScanClient } from "@/components/mobile-unified-scan-client"
import { buildMobileLoginRedirect } from "@/lib/auth"
import { getServerAuthState } from "@/lib/server-auth"

interface MobileScanPageProps {
  searchParams: Promise<{
    intent?: string
    kind?: string
    token?: string
  }>
}

export default async function MobileScanPage({
  searchParams,
}: MobileScanPageProps) {
  const params = await searchParams
  const auth = await getServerAuthState()
  const query = new URLSearchParams()

  if (typeof params.intent === "string" && params.intent.trim()) {
    query.set("intent", params.intent.trim())
  }
  if (typeof params.kind === "string" && params.kind.trim()) {
    query.set("kind", params.kind.trim())
  }
  if (typeof params.token === "string" && params.token.trim()) {
    query.set("token", params.token.trim())
  }

  if (auth.status === "unauthenticated") {
    redirect(
      buildMobileLoginRedirect(
        `/m/scan${query.size > 0 ? `?${query.toString()}` : ""}`
      )
    )
  }

  if (!auth.user) {
    throw new Error("Unable to validate the current session for mobile scan.")
  }

  return (
    <MobileAuthShell
      title="Scan"
      description="One camera entry for Web login QR codes and relationship QR codes."
    >
      <MobileUnifiedScanClient
        intent={typeof params.intent === "string" ? params.intent : undefined}
        initialKind={typeof params.kind === "string" ? params.kind : undefined}
        initialToken={typeof params.token === "string" ? params.token : undefined}
      />
    </MobileAuthShell>
  )
}
