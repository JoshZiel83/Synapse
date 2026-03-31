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
      <div className="px-4 pt-[max(env(safe-area-inset-top),0.375rem)] pb-1.5">
        <div className="flex h-10 items-center justify-between gap-2.5">
          <h1 className="truncate text-[1.2rem] font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      </div>
    </header>
  )
}
