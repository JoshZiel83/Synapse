"use client"

import { useEffect, useState } from "react"
import Image from "next/image"

import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"

interface WorkspaceLoadingScreenProps {
  className?: string
}

const INITIAL_PROGRESS = 14
const PROGRESS_CEILING = 92

function getNextProgress(current: number) {
  if (current >= PROGRESS_CEILING) {
    return PROGRESS_CEILING
  }

  if (current < 42) {
    return Math.min(current + 9, PROGRESS_CEILING)
  }

  if (current < 68) {
    return Math.min(current + 5, PROGRESS_CEILING)
  }

  if (current < 84) {
    return Math.min(current + 2.4, PROGRESS_CEILING)
  }

  return Math.min(current + 0.8, PROGRESS_CEILING)
}

export function WorkspaceLoadingScreen({
  className,
}: WorkspaceLoadingScreenProps) {
  const [progress, setProgress] = useState(INITIAL_PROGRESS)

  useEffect(() => {
    const timer = window.setInterval(() => {
      setProgress((current) => getNextProgress(current))
    }, 180)

    return () => {
      window.clearInterval(timer)
    }
  }, [])

  return (
    <div
      className={cn(
        "relative flex min-h-svh items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.1),transparent_30%),linear-gradient(180deg,#f7fbff_0%,#ffffff_100%)] px-6 dark:bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.08),transparent_24%),linear-gradient(180deg,#090f19_0%,#0f172a_100%)]",
        className
      )}
    >
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(15,23,42,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.03)_1px,transparent_1px)] [mask-image:linear-gradient(180deg,rgba(0,0,0,0.65),transparent_85%)] bg-[size:32px_32px] opacity-40 dark:bg-[linear-gradient(rgba(148,163,184,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.06)_1px,transparent_1px)]" />

      <div
        aria-live="polite"
        className="relative flex w-full max-w-[10rem] flex-col items-center gap-6 text-center"
        role="status"
      >
        <Image
          alt="Synapse"
          className="h-11 w-auto drop-shadow-[0_14px_30px_rgba(37,99,235,0.18)] select-none dark:drop-shadow-[0_14px_30px_rgba(56,189,248,0.12)]"
          height={44}
          priority
          src="/synapse.svg"
          width={44}
        />

        <Progress
          aria-label="Loading workspace"
          className="h-1.5 w-28 bg-slate-950/8 dark:bg-white/10 [&_[data-slot=progress-indicator]]:bg-[linear-gradient(90deg,color-mix(in_oklab,var(--color-primary)_72%,white)_0%,var(--color-primary)_100%)]"
          value={progress}
        />
      </div>
    </div>
  )
}
