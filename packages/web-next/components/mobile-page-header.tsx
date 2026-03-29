"use client"

import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

export function MobilePageHeader({
  title,
  action,
  className,
}: {
  title: string
  action?: ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        "border-b border-border bg-background/96 backdrop-blur supports-[backdrop-filter]:bg-background/88",
        className
      )}
    >
      <div className="px-4 pt-[max(env(safe-area-inset-top),0.5rem)] pb-2">
        <div className="flex h-11 items-center justify-between gap-3">
          <h1 className="truncate text-[1.35rem] font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      </div>
    </header>
  )
}
