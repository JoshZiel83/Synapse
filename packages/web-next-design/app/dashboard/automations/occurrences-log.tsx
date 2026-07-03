"use client"

// Occurrence log — the source's event history and debugging backbone. Each row
// expands to show the raw payload. Sources record occurrences even with zero
// subscribers, so this is populated before any rule exists.
import { useState } from "react"
import { ChevronRight } from "lucide-react"
import type { AutomationOccurrence } from "@synapse/shared"
import { cn } from "@/lib/utils"
import { formatInstant } from "@/lib/automation/describe"

export function OccurrencesLog({
  occurrences,
}: {
  occurrences: AutomationOccurrence[]
}) {
  const [open, setOpen] = useState<string | null>(null)
  if (occurrences.length === 0) {
    return (
      <div className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
        还没有收到事件
      </div>
    )
  }
  return (
    <div className="divide-y rounded-lg border">
      {occurrences.map((o) => {
        const expanded = open === o.id
        return (
          <div key={o.id}>
            <button
              type="button"
              onClick={() => setOpen(expanded ? null : o.id)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/40"
            >
              <ChevronRight
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground/50 transition",
                  expanded && "rotate-90"
                )}
              />
              <span className="min-w-0 flex-1 truncate text-sm">
                {o.displayTitle || "事件"}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground/70">
                {formatInstant(o.occurredAt)}
              </span>
            </button>
            {expanded && (
              <pre className="max-h-56 overflow-auto border-t bg-muted/20 px-3 py-2 font-mono text-[11px] leading-relaxed">
                {JSON.stringify(o.payload, null, 2)}
              </pre>
            )}
          </div>
        )
      })}
    </div>
  )
}
