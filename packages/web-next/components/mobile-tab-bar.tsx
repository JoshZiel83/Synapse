"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { ContactRound, House, MessageSquare, Settings } from "lucide-react"

import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat-store"

const tabs = [
  {
    href: "/m",
    label: "Home",
    icon: House,
    match: (pathname: string) => pathname === "/m",
  },
  {
    href: "/m/chat",
    label: "Chats",
    icon: MessageSquare,
    match: (pathname: string) => pathname === "/m/chat",
  },
  {
    href: "/m/contacts",
    label: "Contacts",
    icon: ContactRound,
    match: (pathname: string) => pathname.startsWith("/m/contacts"),
  },
  {
    href: "/m/settings",
    label: "Settings",
    icon: Settings,
    match: (pathname: string) => pathname.startsWith("/m/settings"),
  },
] as const

export function MobileTabBar() {
  const pathname = usePathname()
  const unreadCount = useChatStore((state) => state.totalUnread)

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[calc(env(safe-area-inset-bottom)+0.85rem)]">
      <nav className="pointer-events-auto flex w-[min(22rem,calc(100vw-1.5rem))] items-center gap-1 rounded-full border border-border/80 bg-background/96 p-1.5 shadow-[0_24px_70px_rgba(15,23,42,0.18)] backdrop-blur-xl">
        {tabs.map((tab) => {
          const Icon = tab.icon
          const active = tab.match(pathname)
          const showBadge = tab.href === "/m/chat" && unreadCount > 0

          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "relative flex min-w-0 flex-1 items-center justify-center rounded-full px-2 py-2.5 text-muted-foreground transition-colors",
                active && "bg-primary/8 text-primary"
              )}
              aria-label={tab.label}
            >
              <div className="relative">
                <Icon className="size-5" />
                {showBadge ? (
                  <span className="absolute -right-2 -top-2 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-semibold leading-4 text-white">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                ) : null}
              </div>
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
