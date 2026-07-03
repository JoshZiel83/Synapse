"use client"

// A quiet info (ⓘ) affordance: reference detail lives behind a hover tooltip
// instead of always-on explanatory text (progressive disclosure — the mainstream
// product pattern). Shared across settings surfaces for a consistent vocabulary.
import { Info } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export function InfoTip({
  text,
  className,
  label = "说明",
}: {
  text: string
  className?: string
  label?: string
}) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className={cn(
              "text-muted-foreground/40 transition-colors hover:text-muted-foreground",
              className
            )}
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[16rem] text-xs leading-relaxed">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
