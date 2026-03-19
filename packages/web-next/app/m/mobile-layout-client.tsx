"use client"

import { useEffect, type ReactNode } from "react"
import { usePathname, useRouter } from "next/navigation"

import { WorkspaceProvider, useWorkspace } from "@/app/dashboard/workspace-provider"
import { MobileTabBar } from "@/components/mobile-tab-bar"
import { useChatRealtimeSync } from "@/hooks/use-chat-realtime-sync"
import { buildMobileLoginRedirect } from "@/lib/auth"
import { cn } from "@/lib/utils"
import { useAuthStore } from "@/stores/auth-store"
import { useChatStore } from "@/stores/chat-store"

function MobileOnboardingGuard({
  children,
  pathname,
}: {
  children: ReactNode
  pathname: string
}) {
  const router = useRouter()
  const { loading, needsOnboarding } = useWorkspace()
  const shouldRedirectToWelcome =
    needsOnboarding && pathname !== "/m/welcome"
  const shouldRedirectToHome =
    !needsOnboarding && pathname === "/m/welcome"

  useEffect(() => {
    if (loading) return

    if (shouldRedirectToWelcome) {
      router.replace("/m/welcome")
      return
    }

    if (shouldRedirectToHome) {
      router.replace("/m")
    }
  }, [loading, router, shouldRedirectToHome, shouldRedirectToWelcome])

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-muted/40 px-4">
        <div className="flex flex-col items-center gap-4">
          <div className="size-12 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading workspace...</p>
        </div>
      </div>
    )
  }

  if (shouldRedirectToWelcome || shouldRedirectToHome) {
    return null
  }

  return <>{children}</>
}

function MobileShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { workspaceId } = useWorkspace()
  const selectedGroupId = useChatStore((state) => state.selectedGroupId)
  const hideTabBar =
    /^\/m\/chat\/[^/]+$/.test(pathname) || pathname === "/m/welcome"

  useChatRealtimeSync({ workspaceId, selectedGroupId })

  return (
    <div className="min-h-svh bg-[radial-gradient(circle_at_top,_color-mix(in_oklab,var(--color-primary)_10%,transparent),transparent_36%),linear-gradient(180deg,color-mix(in_oklab,var(--color-muted)_62%,white)_0%,var(--color-background)_42%)]">
      <div className="flex min-h-svh w-full flex-col bg-background/72 backdrop-blur-[2px]">
        <div
          className={cn(
            "flex min-h-svh flex-1 flex-col",
            !hideTabBar &&
              "pb-[calc(env(safe-area-inset-bottom)+5.75rem)]"
          )}
        >
          {children}
        </div>
      </div>
      {hideTabBar ? null : <MobileTabBar />}
    </div>
  )
}

export default function MobileLayoutClient({
  children,
}: {
  children: ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const user = useAuthStore((state) => state.user)

  useEffect(() => {
    if (!user) {
      const currentTarget =
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : pathname
      router.replace(buildMobileLoginRedirect(currentTarget))
    }
  }, [pathname, router, user])

  if (!user) return null

  return (
    <WorkspaceProvider>
      <MobileOnboardingGuard pathname={pathname}>
        <MobileShell>{children}</MobileShell>
      </MobileOnboardingGuard>
    </WorkspaceProvider>
  )
}
