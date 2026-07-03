"use client"

// The correctness check that every schedule mode shares: the next N fire times,
// computed with the same cron-parser the backend scheduler uses, rendered in the
// chosen IANA timezone.
import { CalendarClock } from "lucide-react"
import { scheduleNextRuns, type ScheduleValue } from "@/lib/automation/schedule"
import { formatInstant } from "@/lib/automation/describe"

export function NextRuns({
  value,
  count = 5,
}: {
  value: ScheduleValue
  count?: number
}) {
  const runs = scheduleNextRuns(value, count)
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <CalendarClock className="size-3.5" />
        接下来 {count} 次运行
        {value.scheduleTimezone && (
          <span className="text-muted-foreground/70">
            · {value.scheduleTimezone}
          </span>
        )}
      </div>
      {runs.length === 0 ? (
        <div className="text-sm text-muted-foreground/70">
          规则不完整或不会再触发
        </div>
      ) : (
        <ol className="space-y-1">
          {runs.map((d, i) => (
            <li
              key={d.getTime()}
              className="flex items-center gap-2 font-mono text-xs text-foreground/80 tabular-nums"
            >
              <span className="w-4 text-right text-muted-foreground/50">
                {i + 1}
              </span>
              {formatInstant(d.toISOString(), value.scheduleTimezone)}
            </li>
          ))}
        </ol>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground/60">
        调度器约 15 秒轮询一次，实际触发精度约 ±15 秒。
      </p>
    </div>
  )
}
