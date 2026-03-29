"use client"

import { useEffect, useRef } from "react"
import type { ComponentType, SVGProps } from "react"
import {
  ChatBubbleLeftRightIcon as ChatBubbleLeftRightIconOutline,
  Cog6ToothIcon as Cog6ToothIconOutline,
  HomeIcon as HomeIconOutline,
  UserGroupIcon as UserGroupIconOutline,
} from "@heroicons/react/24/outline"
import {
  ChatBubbleLeftRightIcon as ChatBubbleLeftRightIconSolid,
  Cog6ToothIcon as Cog6ToothIconSolid,
  HomeIcon as HomeIconSolid,
  UserGroupIcon as UserGroupIconSolid,
} from "@heroicons/react/24/solid"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { m } from "framer-motion"

import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat-store"

type TabIcon = ComponentType<SVGProps<SVGSVGElement>>

const tabs = [
  {
    href: "/m",
    label: "Home",
    outlineIcon: HomeIconOutline,
    solidIcon: HomeIconSolid,
    match: (pathname: string) => pathname === "/m",
  },
  {
    href: "/m/chat",
    label: "Chats",
    outlineIcon: ChatBubbleLeftRightIconOutline,
    solidIcon: ChatBubbleLeftRightIconSolid,
    match: (pathname: string) => pathname === "/m/chat",
  },
  {
    href: "/m/contacts",
    label: "Contacts",
    outlineIcon: UserGroupIconOutline,
    solidIcon: UserGroupIconSolid,
    match: (pathname: string) => pathname.startsWith("/m/contacts"),
  },
  {
    href: "/m/settings",
    label: "Settings",
    outlineIcon: Cog6ToothIconOutline,
    solidIcon: Cog6ToothIconSolid,
    match: (pathname: string) => pathname.startsWith("/m/settings"),
  },
] as const satisfies Array<{
  href: string
  label: string
  outlineIcon: TabIcon
  solidIcon: TabIcon
  match: (pathname: string) => boolean
}>

export function MobileTabBar({
  onMeasuredHeight,
}: {
  onMeasuredHeight?: (height: number) => void
}) {
  const pathname = usePathname()
  const unreadCount = useChatStore((state) => state.totalUnread)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!onMeasuredHeight) return

    const node = containerRef.current
    if (!node) return
    const reportMeasuredHeight = onMeasuredHeight

    function reportHeight(target: HTMLDivElement) {
      const nextHeight = Math.ceil(target.getBoundingClientRect().height)
      if (nextHeight > 0) {
        reportMeasuredHeight(nextHeight)
      }
    }

    reportHeight(node)

    if (typeof ResizeObserver === "undefined") {
      return
    }

    const observer = new ResizeObserver(() => {
      reportHeight(node)
    })

    observer.observe(node)

    return () => {
      observer.disconnect()
    }
  }, [onMeasuredHeight])

  return (
    <div
      ref={containerRef}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40"
    >
      <nav className="pointer-events-auto flex w-full items-stretch border-t border-border bg-background/96 px-2 pt-1 pb-[max(env(safe-area-inset-bottom),0.35rem)] backdrop-blur supports-[backdrop-filter]:bg-background/90">
        {tabs.map((tab) => {
          const active = tab.match(pathname)
          const Icon = active ? tab.solidIcon : tab.outlineIcon
          const showBadge = tab.href === "/m/chat" && unreadCount > 0

          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-2 py-1 text-muted-foreground transition-colors",
                active && "text-primary"
              )}
              aria-label={tab.label}
            >
              <m.div
                animate={{ scale: active ? 1.04 : 1 }}
                className="relative"
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              >
                <Icon className="size-[18px]" aria-hidden="true" />
                {showBadge ? (
                  <span className="absolute -top-2 -right-2 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] leading-4 font-semibold text-white">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                ) : null}
              </m.div>
              <span className="truncate pb-px text-[10px] leading-[1.15] font-medium">
                {tab.label}
              </span>
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
