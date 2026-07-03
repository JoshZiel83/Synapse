"use client"

// One automation rule as a scannable card — humanized When-summary + delivery,
// a status pill, an on/off switch (active↔paused as a first-class row control),
// and edit/delete. No provider internals or raw enums leak here.
import {
  CalendarClock,
  Clock3,
  MessageSquare,
  PencilLine,
  Trash2,
  TriangleAlert,
  Zap,
} from "lucide-react"
import type { AutomationRule } from "@synapse/shared"
import { cn } from "@/lib/utils"
import { Switch } from "@/components/ui/switch"
import {
  describeDelivery,
  describeTrigger,
  formatInstant,
  STATUS_META,
} from "@/lib/automation/describe"

const TONE: Record<string, string> = {
  green: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  muted: "bg-muted text-muted-foreground",
  red: "bg-red-500/10 text-red-600 dark:text-red-400",
  blue: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
}

export function RuleCard({
  rule,
  conversationName,
  onEdit,
  onToggle,
  onDelete,
}: {
  rule: AutomationRule
  conversationName?: string
  onEdit: () => void
  onToggle: (next: "active" | "paused") => void
  onDelete: () => void
}) {
  const isEvent = rule.category === "event_subscription"
  const meta = STATUS_META[rule.status] ?? STATUS_META.active
  const toggleable = rule.status === "active" || rule.status === "paused"

  return (
    <div className="group rounded-xl border bg-card p-4 transition-colors hover:border-foreground/15">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
            isEvent
              ? "bg-violet-500/10 text-violet-600"
              : "bg-primary/10 text-primary"
          )}
        >
          {isEvent ? <Zap className="size-4" /> : <Clock3 className="size-4" />}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{rule.name}</span>
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                TONE[meta.tone]
              )}
            >
              {meta.label}
            </span>
          </div>

          <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {describeTrigger(rule.trigger)}
          </div>

          <div className="mt-1.5 flex items-center gap-1 text-xs text-foreground/70">
            <MessageSquare className="size-3.5 shrink-0 text-muted-foreground/50" />
            <span className="truncate">{describeDelivery(rule.delivery)}</span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/70">
            {conversationName && <span>#{conversationName}</span>}
            {rule.trigger.nextFireAt && (
              <span className="flex items-center gap-1">
                <CalendarClock className="size-3" />
                下次{" "}
                {formatInstant(
                  rule.trigger.nextFireAt,
                  rule.trigger.scheduleTimezone
                )}
              </span>
            )}
            {rule.lastTriggeredAt && (
              <span>上次 {formatInstant(rule.lastTriggeredAt)}</span>
            )}
          </div>

          {rule.status === "error" && rule.lastErrorMessage && (
            <div className="mt-2 flex items-center gap-1.5 rounded-md bg-red-500/5 px-2 py-1 text-xs text-red-600 dark:text-red-400">
              <TriangleAlert className="size-3.5 shrink-0" />
              <span className="truncate">{rule.lastErrorMessage}</span>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {toggleable && (
            <Switch
              checked={rule.status === "active"}
              onCheckedChange={(v) => onToggle(v ? "active" : "paused")}
              aria-label={rule.status === "active" ? "暂停" : "启用"}
            />
          )}
          <button
            type="button"
            onClick={onEdit}
            aria-label="编辑"
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground/50 opacity-0 transition group-hover:opacity-100 hover:bg-accent hover:text-foreground"
          >
            <PencilLine className="size-4" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label="删除"
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground/50 opacity-0 transition group-hover:opacity-100 hover:bg-red-500/10 hover:text-red-600"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
