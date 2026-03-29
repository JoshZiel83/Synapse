"use client"

import { useEffect, useState, type CSSProperties, type ReactNode } from "react"
import { usePathname, useRouter } from "next/navigation"
import {
  AnimatePresence,
  domAnimation,
  LazyMotion,
  m,
  MotionConfig,
} from "framer-motion"

import {
  WorkspaceProvider,
  useWorkspace,
} from "@/app/dashboard/workspace-provider"
import { WorkspaceLoadingScreen } from "@/components/workspace-loading-screen"
import { MobileTabBar } from "@/components/mobile-tab-bar"
import { useChatRealtimeSync } from "@/hooks/use-chat-realtime-sync"
import { buildMobileLoginRedirect } from "@/lib/auth"
import { useAuthStore } from "@/stores/auth-store"
import { useChatStore } from "@/stores/chat-store"

const MOBILE_PAGE_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1]
const DEFAULT_MOBILE_TAB_BAR_CLEARANCE = 72

function isChatDetailPath(pathname: string) {
  return /^\/m\/chat\/[^/]+$/.test(pathname)
}

function getMobilePageMotion(pathname: string) {
  if (isChatDetailPath(pathname)) {
    return {
      animate: { opacity: 1, x: 0, zIndex: 20 },
      exit: { opacity: 1, x: "28%", zIndex: 20 },
      initial: { opacity: 1, x: "28%", zIndex: 20 },
      transition: { duration: 0.26, ease: MOBILE_PAGE_EASE },
    }
  }

  return {
    animate: { opacity: 1, x: 0, zIndex: 10 },
    exit: { opacity: 0, x: -10, zIndex: 10 },
    initial: { opacity: 0, x: 10, zIndex: 10 },
    transition: { duration: 0.18, ease: MOBILE_PAGE_EASE },
  }
}

function MobileOnboardingGuard({
  children,
  pathname,
}: {
  children: ReactNode
  pathname: string
}) {
  const router = useRouter()
  const { loading, needsOnboarding } = useWorkspace()
  const shouldRedirectToWelcome = needsOnboarding && pathname !== "/m/welcome"
  const shouldRedirectToHome = !needsOnboarding && pathname === "/m/welcome"

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
    return <WorkspaceLoadingScreen />
  }

  if (shouldRedirectToWelcome || shouldRedirectToHome) {
    return null
  }

  return <>{children}</>
}

function MobileShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { workspaceId } = useWorkspace()
  const selectedConversationId = useChatStore(
    (state) => state.selectedConversationId
  )
  const [tabBarClearance, setTabBarClearance] = useState(
    DEFAULT_MOBILE_TAB_BAR_CLEARANCE
  )
  const hideTabBar =
    /^\/m\/chat\/[^/]+$/.test(pathname) || pathname === "/m/welcome"

  useChatRealtimeSync({ workspaceId, selectedConversationId })

  const pageMotion = getMobilePageMotion(pathname)
  const shellStyle = {
    "--mobile-tab-bar-clearance": hideTabBar ? "0px" : `${tabBarClearance}px`,
  } as CSSProperties

  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={domAnimation} strict>
        <div className="min-h-svh bg-[radial-gradient(circle_at_top,_color-mix(in_oklab,var(--color-primary)_10%,transparent),transparent_36%),linear-gradient(180deg,color-mix(in_oklab,var(--color-muted)_62%,white)_0%,var(--color-background)_42%)]">
          <div
            className="flex min-h-svh w-full flex-col bg-background/72 backdrop-blur-[2px]"
            style={shellStyle}
          >
            <div className="relative flex min-h-svh flex-1 flex-col overflow-hidden">
              <AnimatePresence initial={false} mode="sync">
                <m.div
                  key={pathname}
                  animate={pageMotion.animate}
                  className="absolute inset-0 flex min-h-0 flex-col will-change-transform"
                  exit={pageMotion.exit}
                  initial={pageMotion.initial}
                  transition={pageMotion.transition}
                >
                  {children}
                </m.div>
              </AnimatePresence>
            </div>
          </div>
          <AnimatePresence initial={false}>
            {hideTabBar ? null : (
              <m.div
                key="mobile-tab-bar"
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                initial={{ opacity: 0, y: 10 }}
                transition={{ duration: 0.18, ease: MOBILE_PAGE_EASE }}
              >
                <MobileTabBar onMeasuredHeight={setTabBarClearance} />
              </m.div>
            )}
          </AnimatePresence>
        </div>
      </LazyMotion>
    </MotionConfig>
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
